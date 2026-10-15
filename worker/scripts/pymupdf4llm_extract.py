#!/usr/bin/env python3

import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract markdown with pymupdf4llm.")
    parser.add_argument("--input", required=True, help="Path to the source PDF.")
    parser.add_argument("--output", required=True, help="Path to the output file.")
    parser.add_argument(
        "--format",
        default="markdown",
        choices=["markdown", "json"],
        help="Output format.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        import pymupdf4llm  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"missing dependency: pip install pymupdf4llm ({exc})")

    markdown = pymupdf4llm.to_markdown(args.input)

    with open(args.output, "w", encoding="utf-8") as handle:
        if args.format == "json":
            payload = {"markdown": markdown}
            if hasattr(pymupdf4llm, "to_json"):
                payload["pages"] = pymupdf4llm.to_json(args.input)
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            return 0

        handle.write(markdown)
        if not markdown.endswith("\n"):
            handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
