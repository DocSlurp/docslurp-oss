"""Integration snippet for Estimator: imports json/os already exist in the package.

Add ds_range_open/step/supply/close to its exported function table. _call returns
the unwrapped envelope result. The caller must serialize all access to this WASM
instance across threads and hold its exclusive session token until finally exits.
"""

import json
import os

MAX_RANGE_BYTES = 1024 * 1024
MAX_SAFE_INTEGER = (1 << 53) - 1


def profile_range_jsonl(self, path, *, options=None, cancel=None):
    """Yield complete local JSONL lines using bounded positional reads.

    Close this generator if stopping early. No filesystem path enters the parser.
    This method uses self._detail_token, which must initialize to None and reset
    to None after a WASM trap. Legacy probes must refuse while it is active.
    """
    if self._detail_token is not None:
        raise ValueError("a range profile is already active")
    cancelled = getattr(cancel, "is_set", None) or cancel or (lambda: False)
    token = object()
    self._detail_token = token
    opened = False
    terminal = False
    last_request = -1
    failure = None
    handle = None

    def safe_int(value, label, minimum=0):
        # bool is an int subclass, but is not an acceptable ABI index.
        if type(value) is not int or not minimum <= value <= MAX_SAFE_INTEGER:
            raise ValueError(f"{label} is not a safe nonnegative integer")
        return value

    def encode(value):
        return json.dumps(value, separators=(",", ":")).encode("utf-8")

    def cancelled_line():
        return json.dumps({"t": "end", "complete": False, "reason": "cancelled"}, separators=(",", ":")) + "\n"

    try:
        if cancelled():
            terminal = True
            yield cancelled_line()
            return
        handle = open(path, "rb", buffering=0)
        initial = os.fstat(handle.fileno())
        import stat
        if not stat.S_ISREG(initial.st_mode):
            raise ValueError("range input must be a regular local file")
        size = safe_int(initial.st_size, "file size")
        identity = (initial.st_dev, initial.st_ino, initial.st_size, initial.st_mtime_ns, initial.st_ctime_ns)

        def verify():
            current = os.fstat(handle.fileno())
            if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != identity:
                raise ValueError("local input changed during profiling")

        if self._call("ds_range_open", encode(options or {}), encode({"size": size})) is not True:
            raise ValueError("parser did not acknowledge range session open")
        opened = True
        while True:
            if self._detail_token is not token:
                raise ValueError("range session was reset")
            if cancelled():
                if not terminal:
                    terminal = True
                    yield cancelled_line()
                return
            step = self._call("ds_range_step")
            if not isinstance(step, dict):
                raise ValueError("invalid range parser response")
            if step.get("kind") == "read":
                request_id = safe_int(step.get("requestId"), "request ID")
                offset = safe_int(step.get("offset"), "range offset")
                length = safe_int(step.get("length"), "range length", 1)
                if request_id <= last_request or length > MAX_RANGE_BYTES or offset > size or length > size - offset:
                    raise ValueError("invalid, reordered or oversized local range request")
                last_request = request_id
                verify()
                handle.seek(offset)
                # FileIO.read may short-read; satisfy the one bounded request explicitly.
                chunks = bytearray()
                while len(chunks) < length:
                    part = handle.read(length - len(chunks))
                    if not part:
                        break
                    chunks.extend(part)
                verify()
                if cancelled():
                    terminal = True
                    yield cancelled_line()
                    return
                if len(chunks) != length:
                    raise ValueError("local file range returned a short read")
                meta = {"requestId": request_id, "offset": offset, "length": length}
                if self._call("ds_range_supply", encode(meta), bytes(chunks)) is not True:
                    raise ValueError("parser did not acknowledge supplied range")
                continue
            if step.get("kind") == "output":
                frame = step.get("jsonl")
                if not isinstance(frame, str) or not frame or not frame.endswith("\n") or len(frame.encode("utf-8")) > MAX_RANGE_BYTES:
                    raise ValueError("invalid or oversized JSONL frame")
                lines = frame[:-1].split("\n")
                for index, line in enumerate(lines):
                    record = json.loads(line)
                    if not isinstance(record, dict) or not isinstance(record.get("t"), str) or terminal:
                        raise ValueError("invalid JSONL record or output after terminal")
                    if record["t"] == "end":
                        if index != len(lines) - 1 or type(record.get("complete")) is not bool:
                            raise ValueError("invalid JSONL terminal record")
                        terminal = True
                    yield line + "\n"
                    if terminal:
                        return
                    if cancelled():
                        terminal = True
                        yield cancelled_line()
                        return
                continue
            if step.get("kind") == "done":
                if not terminal:
                    raise ValueError("parser finished without a JSONL terminal record")
                return
            raise ValueError("unknown range parser response kind")
    except BaseException as error:
        # Preserve GeneratorExit so early close still cleans up without emitting.
        failure = error
        raise
    finally:
        cleanup_error = None
        if self._detail_token is token:
            if opened:
                try:
                    self._call("ds_range_close")
                except BaseException as error:
                    cleanup_error = error
            self._detail_token = None
        if handle is not None:
            try:
                handle.close()
            except BaseException as error:
                cleanup_error = cleanup_error or error
        if failure is None and cleanup_error is not None:
            raise cleanup_error
