"""Offline DocSlurp credit estimates: probe files locally and quote an upload with the published price card.

Runs the estimator's WebAssembly module (the same one `@docslurp/estimate` ships on npm) through wasmtime and calls
its JSON ABI (`ds_alloc`, `ds_free`, `ds_card`, `ds_read_plan`, `ds_probe`, `ds_quote`).
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from importlib import resources
from typing import Any, Callable, Iterable, Mapping, Optional, Union

import wasmtime

__all__ = ["Estimator", "EstimatorError", "apply_probe", "fetch_estimate_card"]

ProgressCallback = Callable[[dict], None]
Cancel = Union[threading.Event, Callable[[], bool]]

_MASK64 = (1 << 64) - 1
# The module's imported memory, in 64 KiB pages: 16 MiB initial, 256 MiB maximum (.cargo/config.toml).
_MEMORY_INITIAL_PAGES = 256
_MEMORY_MAXIMUM_PAGES = 4096


class EstimatorError(Exception):
    """An estimator error with a stable ``code``: invalid_request, invalid_card, unsupported_rules or crashed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _default_module_bytes() -> bytes:
    return resources.files(__package__).joinpath("docslurp_estimate.wasm").read_bytes()


class Estimator:
    """Probe files and quote uploads offline.

    ``card`` is a price card from ``GET /v1/billing/estimate-card`` (see :func:`fetch_estimate_card`); by default
    the card bundled into the module. ``wasm`` overrides the module bytes or path.
    """

    def __init__(self, card: Optional[Mapping[str, Any] | str] = None, wasm: Optional[bytes | str | os.PathLike] = None) -> None:
        self._engine = wasmtime.Engine()
        if wasm is None:
            module_bytes = _default_module_bytes()
        elif isinstance(wasm, (bytes, bytearray)):
            module_bytes = bytes(wasm)
        else:
            with open(wasm, "rb") as handle:
                module_bytes = handle.read()
        self._module = wasmtime.Module(self._engine, module_bytes)
        self._card_json = None if card is None else (card if isinstance(card, str) else json.dumps(card)).encode()
        # One bounded memory for the estimator's lifetime: after a trap it is zeroed and the module instantiated into
        # it again, so hostile files cost at most this memory, never a fresh allocation per crash.
        self._new_store()

    def _new_store(self) -> None:
        self._store = wasmtime.Store(self._engine)
        limits = wasmtime.Limits(_MEMORY_INITIAL_PAGES, _MEMORY_MAXIMUM_PAGES)
        self._memory = wasmtime.Memory(self._store, wasmtime.MemoryType(limits))
        self._resets = 0
        self._instantiate()

    _crashes = 0
    _total_resets = 0

    def _instantiate(self) -> None:
        instance = wasmtime.Instance(self._store, self._module, [self._memory])
        exports = instance.exports(self._store)
        self._fn = {name: exports[name] for name in ("ds_alloc", "ds_free", "ds_card", "ds_read_plan", "ds_probe", "ds_quote")}

    def _reset(self) -> None:
        # A store keeps a little bookkeeping per instance; start a new one now and then so it stays bounded.
        self._resets += 1
        if self._resets >= 64:
            self._new_store()
            return
        size = self._memory.data_len(self._store)
        chunk = bytes(16 * 1024 * 1024)
        for offset in range(0, size, len(chunk)):
            self._memory.write(self._store, chunk[: min(len(chunk), size - offset)], offset)
        self._instantiate()

    def _call(self, name: str, *inputs: Optional[bytes]) -> Any:
        store = self._store
        try:
            args: list[int] = []
            for data in inputs:
                if not data:
                    args += [0, 0]
                    continue
                pointer = self._fn["ds_alloc"](store, len(data))
                self._memory.write(store, data, pointer)
                args += [pointer, len(data)]
            packed = self._fn[name](store, *args) & _MASK64
            for pointer, length in zip(args[::2], args[1::2]):
                if length:
                    self._fn["ds_free"](store, pointer, length)
        except wasmtime.Trap as error:
            # A trap (a panic, an input larger than the memory, or a file that hit the memory cap) leaves the heap
            # inconsistent: zero the memory and instantiate the module into it again, exactly as on first load.
            self._crashes += 1
            self._total_resets += 1
            self._reset()
            raise EstimatorError("crashed", f"the estimator stopped on this input ({error})") from None
        pointer, length = packed >> 32, packed & 0xFFFFFFFF
        raw = self._memory.read(store, pointer, pointer + length)
        self._fn["ds_free"](store, pointer, length)
        envelope = json.loads(bytes(raw).decode())
        if not envelope["ok"]:
            raise EstimatorError(envelope["error"]["code"], envelope["error"]["message"])
        return envelope["value"]

    @staticmethod
    def _meta(name: str, size: int, type: Optional[str]) -> bytes:
        meta: dict[str, Any] = {"name": name, "size": size}
        if type:
            meta["type"] = type
        return json.dumps(meta).encode()

    def card(self) -> dict:
        """The price card quotes use: the supplied card, else the bundled one."""
        return json.loads(self._card_json) if self._card_json else self._call("ds_card")

    def read_plan(self, name: str, size: int, type: Optional[str] = None) -> dict:
        """Bytes :meth:`probe` needs: ``{"head": n, "tail": n}`` (head == size means the whole file)."""
        return self._call("ds_read_plan", self._meta(name, size, type))

    def probe(self, name: str, size: int, head: bytes, tail: Optional[bytes] = None, type: Optional[str] = None) -> dict:
        """Probe a file from its first bytes and, for large media, its last bytes."""
        return self._call("ds_probe", self._meta(name, size, type), head, tail)

    def probe_path(self, path: str | os.PathLike, type: Optional[str] = None) -> dict:
        """Probe the file at ``path``, reading only the bytes the probe needs."""
        name = os.path.basename(os.fspath(path))
        size = os.path.getsize(path)
        plan = self.read_plan(name, size, type)
        with open(path, "rb") as handle:
            head = handle.read(plan["head"])
            tail = None
            if plan["tail"]:
                handle.seek(size - plan["tail"])
                tail = handle.read(plan["tail"])
        return self.probe(name, size, head, tail, type)

    def quote(self, files: Iterable[Mapping[str, Any]], profile: Optional[Mapping[str, Any]] = None, speed_boost: Optional[bool] = None) -> dict:
        """Quote files (``{"name", "size", "type"?, "pages"?, "durationSeconds"?, "mix"?, "mixConfidence"?}``)."""
        request: dict[str, Any] = {"files": list(files)}
        if profile is not None:
            request["profile"] = profile
        if speed_boost is not None:
            request["speedBoost"] = speed_boost
        return self._call("ds_quote", json.dumps(request).encode(), self._card_json)

    def quote_paths(self, paths: Iterable[str | os.PathLike], profile: Optional[Mapping[str, Any]] = None, speed_boost: Optional[bool] = None) -> dict:
        """Probe each path and quote them together. Files the probe cannot read are priced from name and size."""
        files = []
        probes = []
        for path in paths:
            file = {"name": os.path.basename(os.fspath(path)), "size": os.path.getsize(path)}
            try:
                probed = self.probe_path(path)
            except EstimatorError:
                probed = None
            probes.append(probed)
            files.append(apply_probe(file, probed))
        return {**self.quote(files, profile, speed_boost), "probes": probes}

    def health(self) -> dict:
        """Traps (``crashed``) and the fresh instances made after them."""
        return {"crashes": self._crashes, "resets": self._total_resets}

    def estimate_paths(
        self,
        paths: Iterable[str | os.PathLike],
        profile: Optional[Mapping[str, Any]] = None,
        speed_boost: Optional[bool] = None,
        on_progress: Optional[ProgressCallback] = None,
        cancel: Optional[Cancel] = None,
    ) -> dict:
        """Probe and quote ``paths`` with progress, cancellation and per-file fallbacks, like JS ``estimateFiles``.

        ``on_progress`` receives the same events (``file-start``, ``read-progress``, ``probe-start``, ``probe-done``,
        ``file-done``, ``quote-done``; one batch, so one ``batch-done``). ``cancel`` is a ``threading.Event`` or a
        callable; once set, no further file starts and the result is ``partial``, quoting the finished files plus
        size-only assumptions for the rest. A file that cannot be read or probed is priced from its name and size.
        """
        emit = on_progress or (lambda event: None)
        cancelled = (cancel.is_set if isinstance(cancel, threading.Event) else cancel) or (lambda: False)
        started = time.perf_counter()
        paths = [os.fspath(path) for path in paths]
        sources = []
        for path in paths:
            name = os.path.basename(path)
            try:
                sources.append({"name": name, "size": os.path.getsize(path), "path": path})
            except OSError as error:
                sources.append({"name": name, "size": 0, "path": path, "error": {"code": "read_failed", "message": str(error)}})
        plans: list[Optional[dict]] = []
        for source in sources:
            plan = None if "error" in source else self.read_plan(source["name"], source["size"])
            plans.append(plan)
        planned = sum(plan["head"] + plan["tail"] for plan in plans if plan)
        file_bytes = sum(source["size"] for source in sources)
        counts = {"completed": 0, "probed": 0, "failed": 0, "skipped": 0}
        state = {"read": 0}
        health_before = self.health()
        results: list[Optional[dict]] = [None] * len(sources)

        def send(kind: str, **fields: Any) -> None:
            emit({
                "type": kind,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
                "files": {"total": len(sources), **counts},
                "bytes": {"read": state["read"], "planned": planned, "files": file_bytes},
                **fields,
            })

        def size_only(source: dict) -> dict:
            return {"name": source["name"], "size": source["size"]}

        def finish(index: int, status: str, **fields: Any) -> dict:
            source = sources[index]
            result = {"index": index, "name": source["name"], "size": source["size"], "status": status, "probe": None,
                      "quoteFile": size_only(source), "measured": False, "probeMs": None, **fields}
            results[index] = result
            counts["completed"] += 1
            counts[status if status in ("probed", "failed") else "skipped"] += 1
            return result

        for index, source in enumerate(sources):
            if cancelled():
                break
            ref = {"index": index, "name": source["name"]}
            plan = plans[index]
            send("file-start", file={**ref, "size": source["size"]}, plan=plan, filePlannedBytes=(plan["head"] + plan["tail"]) if plan else 0)
            if plan is None:
                send("file-done", file=ref, result=finish(index, "failed", reason=source["error"]))
                continue
            try:
                with open(source["path"], "rb") as handle:
                    head = handle.read(plan["head"])
                    tail = None
                    if plan["tail"]:
                        handle.seek(source["size"] - plan["tail"])
                        tail = handle.read(plan["tail"])
            except OSError as error:
                send("file-done", file=ref, result=finish(index, "failed", reason={"code": "read_failed", "message": str(error)}))
                continue
            read = len(head) + (len(tail) if tail else 0)
            state["read"] += read
            send("read-progress", file=ref, fileBytesRead=read, filePlannedBytes=plan["head"] + plan["tail"])
            # One opaque call: report the stage and its time, never a percentage.
            send("probe-start", file=ref, stage="probe")
            probe_started = time.perf_counter()
            try:
                probe = self.probe(source["name"], source["size"], head, tail)
                failure = None
            except EstimatorError as error:
                probe, failure = None, {"code": error.code, "message": f"{error}; priced from name and size."}
            probe_ms = round((time.perf_counter() - probe_started) * 1000, 2)
            send("probe-done", file=ref, stage="probe", probeMs=probe_ms, ok=failure is None)
            if failure:
                result = finish(index, "failed", reason=failure, probeMs=probe_ms)
            else:
                result = finish(index, "probed", probe=probe, quoteFile=apply_probe(size_only(source), probe), measured=True, probeMs=probe_ms)
            send("file-done", file=ref, result=result)

        was_cancelled = any(result is None for result in results)
        for index, source in enumerate(sources):
            if results[index] is None:
                finish(index, "skipped", reason={"code": "cancelled", "message": "Not probed before the estimate was cancelled; priced from name and size."})
        send("batch-done", batch={"index": 0, "start": 0, "end": len(sources)})
        quote = self.quote([result["quoteFile"] for result in results], profile, speed_boost) if results else None
        elapsed = time.perf_counter() - started
        times = sorted(result["probeMs"] for result in results if result["probeMs"] is not None)
        pick = lambda p: times[min(len(times) - 1, max(0, -(-p * len(times) // 100) - 1))] if times else 0
        confidences = [result["probe"].get("mixConfidence", 1) for result in results if result["probe"] and "mix" in result["probe"]]
        health = self.health()
        size_only_files = sum(1 for result in results if not result["measured"])
        stats = {
            "elapsedMs": round(elapsed * 1000, 1),
            "files": {"total": len(sources), "probed": counts["probed"], "failed": counts["failed"], "skipped": counts["skipped"], "sizeOnly": size_only_files},
            "bytes": {"read": state["read"], "planned": planned, "files": file_bytes},
            "probeMs": {"total": round(sum(times), 2), "p50": pick(50), "p95": pick(95), "max": times[-1] if times else 0},
            "throughput": {"filesPerSecond": round((counts["probed"] + counts["failed"]) / max(elapsed, 1e-3), 2), "megabytesPerSecond": round(state["read"] / 1e6 / max(elapsed, 1e-3), 2)},
            "pages": {"found": sum((result["probe"] or {}).get("pages", 0) for result in results)},
            "mixConfidence": {"files": len(confidences), "min": min(confidences, default=None), "max": max(confidences, default=None)},
            "estimator": {"crashes": health["crashes"] - health_before["crashes"], "resets": health["resets"] - health_before["resets"]},
        }
        result = {"quote": quote, "files": results, "stats": stats, "partial": size_only_files > 0, "cancelled": was_cancelled, "sizeOnlyFiles": size_only_files}
        send("quote-done", quote=quote, partial=result["partial"], cancelled=was_cancelled)
        return result


def apply_probe(file: Mapping[str, Any], probe: Optional[Mapping[str, Any]]) -> dict:
    """Copy a probe's measurements into a quote file, keeping fields the file already has."""
    merged = dict(file)
    if not probe:
        return merged
    if "type" not in merged and probe.get("mimeType"):
        merged["type"] = probe["mimeType"]
    for key in ("pages", "durationSeconds"):
        if key not in merged and key in probe:
            merged[key] = probe[key]
    if "mix" not in merged and "mix" in probe:
        merged["mix"] = probe["mix"]
        if "mixConfidence" in probe:
            merged["mixConfidence"] = probe["mixConfidence"]
    return merged


def fetch_estimate_card(origin: str = "https://docslurp.io", timeout: float = 10.0) -> dict:
    """The current price card from a DocSlurp server (public, no key)."""
    with urllib.request.urlopen(f"{origin.rstrip('/')}/v1/billing/estimate-card", timeout=timeout) as response:
        return json.loads(response.read().decode())
