#!/usr/bin/env python3
"""Fixed offline VM entry point: bounded page-range chunks, ordered Markdown merge.

No URLs, credentials, user flags or host paths. The host supplies a single PDF
and, for a parallel shard, an optional page range; all page counting, range
validation, parsing and merging happen behind the VM boundary.
"""
import json
import os
import re
import resource
import stat
import subprocess
import sys
import time
from pathlib import Path

DOPPLER_GUEST_PROTOCOL = "doppler-vm@3"
MAX_SHARD_REQUEST = 256
MAX_INPUT = 500 * 1024 * 1024
MAX_RAW = 256 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
# One VM converts at most MAX_PAGES pages. A longer document is converted only as host-planned
# shards, each of at most MAX_PAGES pages, up to MAX_DOCUMENT_PAGES in total.
MAX_PAGES = 10000
MAX_DOCUMENT_PAGES = 100000
CHUNK_PAGES = 32
JOB_SECONDS = 150


def page_ranges(pages, first=1, last=None):
    if type(pages) is not int or not 1 <= pages <= MAX_DOCUMENT_PAGES:
        raise ValueError('invalid PDF page count')
    last = pages if last is None else last
    if type(first) is not int or type(last) is not int or not 1 <= first <= last <= pages or last - first + 1 > MAX_PAGES:
        raise ValueError('PDF range exceeds the per-VM page limit')
    return [(start, min(start + CHUNK_PAGES - 1, last)) for start in range(first, last + 1, CHUNK_PAGES)]


def shard_request(pages, path=Path('/job/shard.json')):
    """The host's page range for a parallel shard, or the whole document when absent.

    Ranges start on the internal chunk grid, so a shard runs exactly the chunks the
    whole-document conversion would and the merged output is byte-identical. A final
    shard must end on the document's last page: a host page count that is too low
    fails here instead of silently dropping pages.
    """
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return 1, pages
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SHARD_REQUEST:
        raise ValueError('invalid shard request')
    request = json.loads(path.read_bytes())
    if type(request) is not dict or set(request) != {'first', 'last', 'final'}:
        raise ValueError('invalid shard request')
    first, last, final = request['first'], request['last'], request['final']
    if type(first) is not int or type(last) is not int or type(final) is not bool:
        raise ValueError('invalid shard request')
    if not 1 <= first <= last <= pages or (first - 1) % CHUNK_PAGES:
        raise ValueError('shard range outside document or chunk grid')
    if final != (last == pages) or (not final and last % CHUNK_PAGES):
        raise ValueError('shard end does not match document')
    return first, last


def chunk_settings(settings, document_pages, chunk_pages):
    # A short tail must not turn a section label into repeated page furniture.
    # Require the same absolute repetition count as whole-document conversion.
    # Counts from other chunks are unavailable, so retaining extra furniture is
    # intentional; losing meaningful text is worse than retaining a header.
    params = json.loads(settings)
    params['furniture_min_share'] = params.get('furniture_min_share', 0.4) * document_pages / chunk_pages
    return json.dumps(params)


def append_chunk(output, chunk_path, expected_pages, first, total_bytes):
    # Binary form feeds retain exact page slots, including blank first/last pages.
    size = chunk_path.stat().st_size
    if size + total_bytes + (0 if first else 1) > MAX_OUTPUT:
        raise ValueError('Markdown exceeds limit')
    separators = 0
    if not first:
        output.write(b'\f')
        total_bytes += 1
    with chunk_path.open('rb') as chunk:
        while data := chunk.read(65536):
            separators += data.count(b'\f')
            total_bytes += len(data)
            if total_bytes > MAX_OUTPUT:
                raise ValueError('Markdown exceeds limit')
            output.write(data)
    if separators != expected_pages - 1:
        raise ValueError('chunk page slots do not match range')
    return total_bytes


def main():
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (JOB_SECONDS, JOB_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RAW,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    info = os.lstat('/job/input')
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT:
        raise ValueError('invalid PDF input')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/job', 'TMPDIR': '/job', 'LANG': 'C.UTF-8'}
    started = time.monotonic()

    def run(args, stdout, stderr):
        remaining = JOB_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            raise ValueError('document deadline exceeded')
        subprocess.run(args, env=env, stdout=stdout, stderr=stderr, check=True, timeout=min(45, remaining))

    with open('/job/info', 'xb') as output, open('/job/parser.log', 'xb') as log:
        run(['/opt/doppler/bin/pdfinfo', '/job/input'], output, log)
    with open('/job/info', 'rb') as source:
        info_text = source.read(65537)
    if len(info_text) > 65536:
        raise ValueError('PDF info exceeds limit')
    match = re.search(rb'^Pages:\s+(\d+)\s*$', info_text, re.MULTILINE)
    pages = int(match[1]) if match else 0
    if type(pages) is not int or not 1 <= pages <= MAX_DOCUMENT_PAGES:
        raise ValueError('invalid PDF page count')  # validated before any request is read
    shard_first, shard_last = shard_request(pages)
    ranges = page_ranges(pages, shard_first, shard_last)
    settings = Path('/opt/doppler/defaults.json').read_text()
    total_bytes = 0
    words = 0
    degraded_pages = 0
    with open('/job/output', 'xb') as output:
        for index, (first, last) in enumerate(ranges):
            with open('/job/parser.log', 'wb') as log:
                run(['/opt/doppler/bin/pdftotext', '-bbox-layout', '-compact-layout', '-wordmeta', '-rules',
                     '-f', str(first), '-l', str(last), '-enc', 'UTF-8', '-eol', 'unix',
                     '/job/input', '/job/raw.xhtml'], log, log)
            if Path('/job/raw.xhtml').stat().st_size > MAX_RAW:
                raise ValueError('PDF chunk text layer exceeds limit')
            with open('/job/chunk.md', 'wb') as chunk, open('/job/converter-report.json', 'wb') as report:
                params = chunk_settings(settings, pages, last - first + 1)
                run(['/opt/doppler/bin/doppler-md', '--report', '--params', params, '/job/raw.xhtml'], chunk, report)
            with open('/job/converter-report.json', 'rb') as report:
                diagnostics = json.loads(report.read(16385))
            if type(diagnostics.get('pages')) is not int or diagnostics['pages'] != last - first + 1:
                raise ValueError('PDF chunk page count mismatch')
            total_bytes = append_chunk(output, Path('/job/chunk.md'), last - first + 1, index == 0, total_bytes)
            words += diagnostics.get('words', 0)
            degraded_pages += len(diagnostics.get('degraded', []))
            # Reuse bounded files; never accumulate intermediates per chunk.
            for name in ('raw.xhtml', 'chunk.md', 'converter-report.json'):
                Path('/job', name).unlink()
    print(json.dumps({'protocol': DOPPLER_GUEST_PROTOCOL, 'engine': 'doppler',
                      'elapsedMs': round((time.monotonic() - started) * 1000), 'outputBytes': total_bytes,
                      'conversion': {'pages': shard_last - shard_first + 1, 'first': shard_first, 'last': shard_last,
                                     'documentPages': pages, 'chunks': len(ranges), 'chunkPages': CHUNK_PAGES,
                                     'words': words, 'degradedPages': degraded_pages}}), file=sys.stderr)
    fd = os.open('/job/output', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != total_bytes:
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
