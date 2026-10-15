#!/usr/bin/env python3

import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Partition a PDF with unstructured.")
    parser.add_argument("--input", required=True, help="Path to the source PDF.")
    parser.add_argument("--output", required=True, help="Path to the output file.")
    parser.add_argument(
        "--strategy",
        default="fast",
        choices=["auto", "fast", "hi_res", "ocr_only"],
        help="Unstructured partitioning strategy.",
    )
    parser.add_argument(
        "--format",
        default="json",
        choices=["json", "text"],
        help="Output format.",
    )
    return parser.parse_args()


def element_to_dict(element: object) -> dict:
    metadata = getattr(element, "metadata", None)
    metadata_dict = metadata.to_dict() if metadata and hasattr(metadata, "to_dict") else {}
    return {
        "type": element.__class__.__name__,
        "text": getattr(element, "text", ""),
        "metadata": metadata_dict,
    }


def main() -> int:
    args = parse_args()
    try:
        from unstructured.partition.pdf import partition_pdf
    except ImportError as exc:
        raise SystemExit(f"missing dependency: pip install unstructured[pdf] ({exc})")

    elements = partition_pdf(filename=args.input, strategy=args.strategy)

    if args.format == "text":
        payload = "\n\n".join(getattr(element, "text", "") for element in elements).strip() + "\n"
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(payload)
        return 0

    payload = [element_to_dict(element) for element in elements]
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
