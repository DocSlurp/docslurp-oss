"""Offline DocSlurp credit estimates: probe files locally and quote an upload with the published price card.

Runs the estimator's WebAssembly module (the same one `@docslurp/estimate` ships on npm) through wasmtime and calls
its JSON ABI (`ds_alloc`, `ds_free`, `ds_card`, `ds_read_plan`, `ds_probe`, `ds_quote`).
"""

from __future__ import annotations

import gc
import json
import os
import urllib.request
from importlib import resources
from typing import Any, Iterable, Mapping, Optional

import wasmtime

__all__ = ["Estimator", "EstimatorError", "apply_probe", "fetch_estimate_card"]

_MASK64 = (1 << 64) - 1


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
        self._instantiate()

    def _instantiate(self) -> None:
        self._store = wasmtime.Store(self._engine)
        instance = wasmtime.Instance(self._store, self._module, [])
        exports = instance.exports(self._store)
        self._memory = exports["memory"]
        self._fn = {name: exports[name] for name in ("ds_alloc", "ds_free", "ds_card", "ds_read_plan", "ds_probe", "ds_quote")}

    def _call(self, name: str, *inputs: Optional[bytes]) -> Any:
        store = self._store
        args: list[int] = []
        allocated: list[tuple[int, int]] = []
        for data in inputs:
            if not data:
                args += [0, 0]
                continue
            pointer = self._fn["ds_alloc"](store, len(data))
            self._memory.write(store, data, pointer)
            allocated.append((pointer, len(data)))
            args += [pointer, len(data)]
        try:
            packed = self._fn[name](store, *args) & _MASK64
        except wasmtime.Trap as error:
            # A panic traps the module and may leave its memory inconsistent: start a fresh instance, and release the
            # old one's linear memory (up to the module's 256 MiB cap) now rather than at the next collection.
            self._memory = None
            self._fn = {}
            self._store = None
            gc.collect()
            self._instantiate()
            raise EstimatorError("crashed", f"the estimator stopped on this input ({error})") from None
        for pointer, length in allocated:
            self._fn["ds_free"](store, pointer, length)
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
