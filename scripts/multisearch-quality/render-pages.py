"""Render authored <!-- page N --> Markdown into one physical PDF page per block.
No labels or gold are read. Standard library only; plain ASCII source is required.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import textwrap


def render(source):
    blocks = re.split(r"<!-- page (\d+) -->\s*", source)
    if blocks[0].strip() or len(blocks) < 3:
        raise ValueError("Expected explicitly numbered source pages")
    pages = []
    for offset in range(1, len(blocks), 2):
        if int(blocks[offset]) != len(pages) + 1:
            raise ValueError("Pages must be consecutive from one")
        body = blocks[offset + 1].strip()
        body.encode("ascii")
        if not body:
            raise ValueError("Empty source page")
        pages.append(body)
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    page_ids = []
    for page in pages:
        lines = [line for paragraph in page.splitlines() for line in (textwrap.wrap(paragraph, 84) or [""])]
        if len(lines) > 45:
            raise ValueError("Page would overflow; shorten lines or use a full layout renderer")
        escaped = [line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in lines]
        content = ("BT /F1 11 Tf 54 735 Td 16 TL\n" + "\n".join(f"({line}) Tj T*" for line in escaped) + "\nET").encode("ascii")
        page_id = len(objects) + 1
        page_ids.append(page_id)
        objects.extend([f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {page_id + 1} 0 R >>".encode(), b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"])
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(f'{n} 0 R' for n in page_ids)}] /Count {len(pages)} >>".encode()
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(data), pages


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source"); parser.add_argument("output")
    args = parser.parse_args()
    source = Path(args.source).read_text()
    pdf, pages = render(source)
    with Path(args.output).open("xb") as output:
        output.write(pdf)
    print(json.dumps({"sourceSha256": hashlib.sha256(source.encode()).hexdigest(), "pdfSha256": hashlib.sha256(pdf).hexdigest(), "pages": len(pages), "sizeBytes": len(pdf)}))
