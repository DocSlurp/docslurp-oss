#!/usr/bin/env python3
"""
Extract text blocks with bounding boxes, classified by semantic page region,
using PyMuPDF. Outputs a JSON artifact suitable for region-aware chunking
and citation support.

Region classification uses relative position within the page:
  header  — top 10% of page height
  footer  — bottom 10% of page height
  sidebar — left 15% or right 15% of page width
  body    — everything else
"""

import argparse
import json
import sys
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract text regions with bboxes using PyMuPDF.")
    parser.add_argument("--input", required=True, help="Path to the source PDF.")
    parser.add_argument("--output", required=True, help="Path to the output JSON file.")
    parser.add_argument(
        "--header-pct", type=float, default=0.10,
        help="Fraction of page height reserved for the header region (default 0.10)."
    )
    parser.add_argument(
        "--footer-pct", type=float, default=0.10,
        help="Fraction of page height reserved for the footer region (default 0.10)."
    )
    parser.add_argument(
        "--sidebar-pct", type=float, default=0.15,
        help="Fraction of page width reserved for left/right sidebar regions (default 0.15)."
    )
    return parser.parse_args()


def import_pymupdf():
    try:
        import pymupdf  # type: ignore
        return pymupdf
    except ImportError:
        try:
            import fitz  # type: ignore
            return fitz
        except ImportError as exc:
            raise SystemExit(f"missing dependency: pip install pymupdf ({exc})")


def classify_region(
    bbox: tuple[float, float, float, float],
    page_width: float,
    page_height: float,
    header_pct: float,
    footer_pct: float,
    sidebar_pct: float,
) -> str:
    x0, y0, x1, y1 = bbox
    block_y_center = (y0 + y1) / 2
    block_x_center = (x0 + x1) / 2

    if block_y_center < page_height * header_pct:
        return "header"
    if block_y_center > page_height * (1.0 - footer_pct):
        return "footer"
    if block_x_center < page_width * sidebar_pct:
        return "sidebar-left"
    if block_x_center > page_width * (1.0 - sidebar_pct):
        return "sidebar-right"
    return "body"


def extract_block(raw_block: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw pymupdf block dict into a clean block record."""
    lines = []
    for line in raw_block.get("lines", []):
        spans = [
            {
                "text": span.get("text", ""),
                "bbox": [round(v, 2) for v in span.get("bbox", [0, 0, 0, 0])],
                "size": round(span.get("size", 0), 1),
                "flags": span.get("flags", 0),
            }
            for span in line.get("spans", [])
            if span.get("text", "").strip()
        ]
        if spans:
            lines.append({"bbox": [round(v, 2) for v in line.get("bbox", [0, 0, 0, 0])], "spans": spans})

    text = " ".join(
        span["text"]
        for line in lines
        for span in line["spans"]
    ).strip()

    return {
        "bbox": [round(v, 2) for v in raw_block.get("bbox", [0, 0, 0, 0])],
        "text": text,
        "lines": lines,
    }


def process_page(
    page: Any,
    page_number: int,
    header_pct: float,
    footer_pct: float,
    sidebar_pct: float,
) -> dict[str, Any]:
    rect = page.rect
    page_width = rect.width
    page_height = rect.height

    raw = page.get_text("dict", sort=True)
    raw_blocks = [b for b in raw.get("blocks", []) if b.get("type") == 0]  # type 0 = text

    # Group blocks by region
    region_map: dict[str, list[dict[str, Any]]] = {}
    for raw_block in raw_blocks:
        block = extract_block(raw_block)
        if not block["text"]:
            continue
        region = classify_region(
            tuple(raw_block["bbox"]),  # type: ignore[arg-type]
            page_width,
            page_height,
            header_pct,
            footer_pct,
            sidebar_pct,
        )
        region_map.setdefault(region, []).append(block)

    # Build ordered region list with combined text
    region_order = ["header", "sidebar-left", "body", "sidebar-right", "footer"]
    regions = []
    for region_type in region_order:
        blocks = region_map.get(region_type)
        if not blocks:
            continue
        combined_text = "\n".join(b["text"] for b in blocks)
        all_bboxes = [b["bbox"] for b in blocks]
        envelope = [
            min(b[0] for b in all_bboxes),
            min(b[1] for b in all_bboxes),
            max(b[2] for b in all_bboxes),
            max(b[3] for b in all_bboxes),
        ]
        regions.append({
            "type": region_type,
            "bbox": [round(v, 2) for v in envelope],
            "text": combined_text,
            "blockCount": len(blocks),
            "blocks": blocks,
        })

    return {
        "pageNumber": page_number,
        "width": round(page_width, 2),
        "height": round(page_height, 2),
        "regionCount": len(regions),
        "regions": regions,
    }


def main() -> int:
    args = parse_args()
    pymupdf = import_pymupdf()

    doc = pymupdf.open(args.input)
    try:
        pages = [
            process_page(page, i + 1, args.header_pct, args.footer_pct, args.sidebar_pct)
            for i, page in enumerate(doc)
        ]
    finally:
        doc.close()

    output = {
        "extractor": "pymupdf-regions",
        "pageCount": len(pages),
        "pages": pages,
    }

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
