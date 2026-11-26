#!/usr/bin/env python3
"""Publish one immutable ClamAV signature generation from an operator host."""

import argparse
import hashlib
import os
from itertools import islice
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile

DEFINITION_NAME = re.compile(r"(main|daily|bytecode)\.(cvd|cld)")
MAX_BYTES = 512 * 1024 * 1024


def stage(source, target):
    """Copy and fingerprint the exact bytes uploaded, using the worker's format."""
    digest = hashlib.sha256()
    total = 0
    files = []
    for entry in sorted(source.iterdir()):
        if not DEFINITION_NAME.fullmatch(entry.name) or not stat.S_ISREG(entry.lstat().st_mode):
            continue
        fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as incoming:
            info = os.fstat(incoming.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES - total:
                raise ValueError("Invalid or oversized ClamAV signature file")
            name = entry.name
            digest.update(f"{name}\0{info.st_size}\0".encode())
            written = 0
            staged = target / name
            with staged.open("xb") as output:
                for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                    written += len(chunk)
                    if written > info.st_size:
                        raise ValueError("Signature changed during staging. Retry after the updater finishes.")
                    digest.update(chunk)
                    output.write(chunk)
            end = os.fstat(incoming.fileno())
            if written != info.st_size or end.st_mtime_ns != info.st_mtime_ns:
                raise ValueError("Signature changed during staging. Retry after the updater finishes.")
            files.append(staged)
            total += written

    if not files:
        raise ValueError("No ClamAV signatures found")
    return digest.hexdigest(), files


def remote_matches(volume, fingerprint, files):
    """Accept a concurrent publisher only after the complete existing set matches."""
    names = [file.name for file in files]
    entries = list(islice(volume.iterdir(f"/{fingerprint}", recursive=False), len(names) + 1))
    if sorted(PurePosixPath(entry.path).name for entry in entries) != names:
        return False
    digest = hashlib.sha256()
    for file in files:
        size = file.stat().st_size
        digest.update(f"{file.name}\0{size}\0".encode())
        read = 0
        for chunk in volume.read_file(f"/{fingerprint}/{file.name}"):
            read += len(chunk)
            if read > size:
                return False
            digest.update(chunk)
        if read != size:
            return False
    return digest.hexdigest() == fingerprint


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("volume", help="Existing Modal Volume name")
    parser.add_argument("--source", type=Path, default=Path("/var/lib/clamav"))
    parser.add_argument("--environment", help="Modal environment containing the Volume")
    parser.add_argument("--write", action="store_true", help="Upload the generation. Default is a local dry run.")
    args = parser.parse_args(argv)

    with tempfile.TemporaryDirectory(prefix="docslurp-clam-publish-") as directory:
        fingerprint, files = stage(args.source, Path(directory))
        print(f"Volume {args.volume}, signature generation {fingerprint}")
        if not args.write:
            return

        import modal

        volume = modal.Volume.from_name(args.volume, environment_name=args.environment)
        # One no-overwrite batch. A concurrent publisher cannot replace any published file.
        # The consumer independently verifies every byte, so partial or corrupt generations
        # never supply signatures even if the service returns or exposes an incomplete batch.
        try:
            with volume.batch_upload(force=False) as batch:
                for file in files:
                    batch.put_file(file, f"/{fingerprint}/{file.name}", mode=0o444)
        except FileExistsError:
            if not remote_matches(volume, fingerprint, files):
                raise
            print("Signature generation already present and verified")
        else:
            print("Uploaded signature generation")



if __name__ == "__main__":
    main()
