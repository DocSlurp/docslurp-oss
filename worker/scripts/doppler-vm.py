#!/usr/bin/env python3
"""Fixed guest entry point. No URLs, credentials, user flags, or host paths accepted.

The private deployment image supplies /opt/doppler and its immutable settings.
This process runs ONLY behind the document VM boundary, never on the worker host.
"""
import json
import os
import resource
import stat
import sys
import subprocess
import time
from pathlib import Path

DOPPLER_GUEST_PROTOCOL = "doppler-vm@1"

MAX_INPUT = 64 * 1024 * 1024
MAX_RAW = 256 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024


def main():
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RAW,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    info = os.lstat('/job/input')
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT:
        raise ValueError('invalid PDF input')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/job', 'TMPDIR': '/job', 'LANG': 'C.UTF-8'}
    started = time.monotonic()
    # Neither binary receives document-controlled options or filenames.
    with open('/job/parser.log', 'xb') as log:
        subprocess.run(['/opt/doppler/bin/pdftotext', '-bbox-layout', '-compact-layout', '-wordmeta', '-rules',
                        '-enc', 'UTF-8', '-eol', 'unix', '/job/input', '/job/raw.xhtml'],
                       env=env, stdout=log, stderr=log, check=True, timeout=45)
        if Path('/job/raw.xhtml').stat().st_size > MAX_RAW:
            raise ValueError('PDF text layer exceeds limit')
        settings = Path('/opt/doppler/defaults.json').read_text()
        with open('/job/output', 'xb') as output, open('/job/converter-report.json', 'xb') as report:
            subprocess.run(['/opt/doppler/bin/doppler-md', '--report', '--params', settings,
                            '/job/raw.xhtml'], env=env, stdout=output, stderr=report,
                           check=True, timeout=max(1, 50 - (time.monotonic() - started)))
    if Path('/job/output').stat().st_size > MAX_OUTPUT:
        raise ValueError('Markdown exceeds limit')
    # A concise structured diagnostic; never return raw PDF strings in error messages.
    with open('/job/converter-report.json', 'rb') as report:
        diagnostics = json.loads(report.read(16385))
    print(json.dumps({'protocol': DOPPLER_GUEST_PROTOCOL, 'engine': 'doppler', 'elapsedMs': round((time.monotonic()-started)*1000),
                      'outputBytes': Path('/job/output').stat().st_size, 'conversion': diagnostics}), file=sys.stderr)
    fd = os.open('/job/output', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_OUTPUT:
            raise ValueError('invalid Markdown output')
        remaining = MAX_OUTPUT + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Doppler guest refused or failed extraction')
