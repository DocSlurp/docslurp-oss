#!/usr/bin/env python3
"""Fetch pinned public sources to an external cache. No credentials or model calls."""
import argparse
import json
from pathlib import Path
import subprocess
import urllib.request
from dataset import file_hash, write_json

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--registry", required=True); p.add_argument("--cache", required=True)
p.add_argument("--output", required=True); p.add_argument("--max-download-bytes", type=int, default=1500000000)
a = p.parse_args(); cache = Path(a.cache).resolve()
if cache.is_relative_to(Path(__file__).resolve().parents[3]):
    raise ValueError("Source media must stay outside repository")
cache.mkdir(parents=True, exist_ok=True)
used, sources = 0, []
for source in json.loads(Path(a.registry).read_text())["documents"]:
    if not source["url"].startswith("https://"):
        raise ValueError("Only explicit HTTPS public source URLs allowed")
    pdf = cache / (source["sha256"] + ".pdf")
    if not pdf.exists():
        if used + source["bytes"] > a.max_download_bytes:
            raise ValueError("Download budget exceeded")
        temporary = pdf.with_suffix(".part")
        try:
            with urllib.request.urlopen(source["url"], timeout=60) as response, open(temporary, "wb") as stream:
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    used += len(chunk)
                    if count > source["bytes"] or used > a.max_download_bytes:
                        raise ValueError("Publisher size changed or download budget exceeded")
                    stream.write(chunk)
            if file_hash(temporary) != source["sha256"]:
                raise ValueError("Publisher checksum changed; require a new source version")
            temporary.rename(pdf)
        finally:
            temporary.unlink(missing_ok=True)
    if file_hash(pdf) != source["sha256"]:
        raise ValueError("Cache checksum mismatch")
    text = pdf.with_suffix(".txt")
    if not text.exists():
        subprocess.run(["pdftotext", "-layout", str(pdf), str(text)], check=True)
    sources.append({**source, "local_path": str(pdf), "full_text_file": str(text), "pdfinfo_pages": source["pages"]})
write_json(a.output, {"documents": sources})
print(json.dumps({"documents": len(sources), "downloadedBytes": used}))
