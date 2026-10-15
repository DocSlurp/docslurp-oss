#!/usr/bin/env python3
"""Extract main content from HTML files using trafilatura."""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        import trafilatura
    except ImportError:
        print(json.dumps({"error": "trafilatura not installed", "text": ""}))
        sys.exit(1)

    with open(args.input, "r", encoding="utf-8", errors="replace") as f:
        html = f.read()

    text = trafilatura.extract(html, include_tables=True, include_links=False) or ""

    result = {
        "text": text,
        "charCount": len(text),
        "extractor": "trafilatura",
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
