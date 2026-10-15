#!/usr/bin/env python3
"""Extract text from EPUB files using ebooklib."""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        import ebooklib
        from ebooklib import epub
        from bs4 import BeautifulSoup
    except ImportError as e:
        print(json.dumps({"error": f"missing dependency: {e}", "chapters": []}))
        sys.exit(1)

    try:
        book = epub.read_epub(args.input)
    except Exception as e:
        print(json.dumps({"error": str(e), "chapters": []}))
        sys.exit(1)

    chapters = []
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        title = soup.find(["h1", "h2", "h3"])
        title_text = title.get_text(strip=True) if title else item.get_name()
        body_text = soup.get_text(separator="\n", strip=True)
        chapters.append({"title": title_text, "text": body_text})

    result = {
        "chapters": chapters,
        "chapterCount": len(chapters),
        "extractor": "ebooklib",
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
