#!/usr/bin/env python3

import argparse
import base64
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract text or structure with PyMuPDF.")
    parser.add_argument("--input", required=True, help="Path to the source PDF.")
    parser.add_argument("--output", required=True, help="Path to the output file.")
    parser.add_argument(
        "--format",
        default="text",
        choices=["text", "html", "json", "pages"],
        help="Output format.",
    )
    parser.add_argument("--ocr", action="store_true", help="Use OCR text pages when available.")
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


def page_text(page, output_format: str, ocr: bool):
    if ocr and hasattr(page, "get_textpage_ocr"):
        text_page = page.get_textpage_ocr()
        if output_format == "json":
            return page.get_text("dict", textpage=text_page)
        if output_format == "html":
            return page.get_text("html", textpage=text_page)
        return page.get_text("text", sort=True, textpage=text_page)

    if output_format == "json":
        return page.get_text("dict", sort=True)
    if output_format == "html":
        return page.get_text("html")
    return page.get_text("text", sort=True)


def to_json_safe(value):
    if isinstance(value, dict):
        return {key: to_json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [to_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [to_json_safe(item) for item in value]
    if isinstance(value, bytes):
        return {"type": "bytes", "base64": base64.b64encode(value).decode("ascii")}
    return value


def main() -> int:
    args = parse_args()
    pymupdf = import_pymupdf()
    document = pymupdf.open(args.input)

    try:
        pages = [page_text(page, args.format, args.ocr) for page in document]
    finally:
        document.close()

    with open(args.output, "w", encoding="utf-8") as handle:
        if args.format == "pages":
            # Plain text per page, index = page number - 1 (page router's per-page native executor).
            json.dump({"pages": pages}, handle)
            handle.write("\n")
            return 0

        if args.format == "json":
            json.dump({"pages": to_json_safe(pages)}, handle, indent=2)
            handle.write("\n")
            return 0

        if args.format == "html":
            handle.write("\n".join(pages))
            handle.write("\n")
            return 0

        handle.write("\n\n".join(page.strip() for page in pages if page))
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
