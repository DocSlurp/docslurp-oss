#!/usr/bin/env python3
"""Markdown from Office Open XML files, run in the parser sandbox like every other host parser.

--kind docx  Pandoc's docx reader (`--sandbox`, no network or file access beyond the input), then the source context
             body extraction omits (headers, footers, comments, link targets; office_context.py).
--kind pptx  python-pptx: one page per slide, separated by form feeds so page alignment holds (slide count = pages).
             Slide title as a heading, body text, tables as GFM tables, speaker notes.
--kind xlsx  openpyxl (read-only, cached values, formulas never evaluated): one GFM table per sheet, then the formula
             and source context appendix (office_context.py).

Nothing here OCRs, renders, runs macros, evaluates formulas or follows links. Output is bounded.
"""
import argparse
import os
import subprocess
import sys

# The sibling modules (office_context.py, xlsx_formula_context.py) live next to this script, in the root-owned scripts
# directory; resolve them from there even under `python3 -I`.
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

MAX_OUTPUT_CHARS = 64_000_000
MAX_SLIDES = 10_000
MAX_SHEET_COLS = 512
PANDOC_TIMEOUT_S = 240


def cell(value):
    """One GFM table cell: pipes escaped, line breaks kept as <br>."""
    text = "" if value is None else str(value)
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\r\n", "\n").replace("\r", "\n").strip().replace("\n", "<br>")


def gfm_table(rows):
    """Rows (lists of strings) as a GFM table, the first row as its header. Empty when there are no rows."""
    rows = [row for row in rows if any(c.strip() for c in row)]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(padded[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines += ["| " + " | ".join(row) + " |" for row in padded[1:]]
    return "\n".join(lines)


def heading_text(text):
    return " ".join(text.split())


def context_appendix(path):
    """office_context.py's appendix, or empty when the file has none or it cannot be read (never fails the body)."""
    try:
        if SCRIPTS_DIR not in sys.path:
            sys.path.insert(0, SCRIPTS_DIR)
        from office_context import office_context
        return office_context(path).rstrip()
    except Exception as error:  # noqa: BLE001 - the appendix is optional; the body is the extraction
        print(f"[office-markdown] source context unavailable: {type(error).__name__}", file=sys.stderr)
        return ""


def docx_markdown(path):
    result = subprocess.run(
        ["pandoc", "--sandbox", "-f", "docx", "-t", "gfm", "--wrap=none", "--", path],
        capture_output=True, timeout=PANDOC_TIMEOUT_S, check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr.decode("utf-8", "replace")[-2000:])
        raise SystemExit(f"pandoc exited {result.returncode}")
    return result.stdout.decode("utf-8", "replace").rstrip()


def safe(fn, default=None):
    """python-pptx accessors raise on unusual shapes (NotImplementedError, ValueError, KeyError...)."""
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def shape_blocks(shape, depth=0):
    """Markdown blocks of one shape, groups flattened (bounded depth)."""
    if depth < 6 and safe(lambda: shape.shape_type, None) == 6 and safe(lambda: shape.shapes, None) is not None:
        return [block for child in safe(lambda: list(shape.shapes), []) for block in shape_blocks(child, depth + 1)]
    if safe(lambda: shape.has_table, False):
        rows = safe(lambda: [[cell(c.text) for c in row.cells] for row in shape.table.rows], [])
        table = gfm_table(rows)
        return [table] if table else []
    if not safe(lambda: shape.has_text_frame, False):
        return []
    body = safe(lambda: shape.is_placeholder and shape.placeholder_format.type is not None and int(shape.placeholder_format.type) in (2, 7), False)
    lines = []
    for paragraph in safe(lambda: list(shape.text_frame.paragraphs), []):
        text = safe(lambda: "".join(run.text for run in paragraph.runs) or paragraph.text, "")
        text = " ".join((text or "").split())
        if not text:
            continue
        level = safe(lambda: int(paragraph.level), 0) or 0
        lines.append(("  " * min(level, 8) + "- " + text) if body or level > 0 else text)
    if not lines:
        return []
    return ["\n".join(lines)] if body else ["\n\n".join(lines)]


def pptx_markdown(path):
    from pptx import Presentation

    prs = Presentation(path)
    pages = []
    for number, slide in enumerate(prs.slides, start=1):
        if number > MAX_SLIDES:
            raise SystemExit(f"presentation exceeds {MAX_SLIDES} slides")
        title_shape = safe(lambda: slide.shapes.title, None)
        title = heading_text(safe(lambda: title_shape.text_frame.text, "") or "") if title_shape is not None else ""
        blocks = [f"## {title}" if title else f"## Slide {number}"]
        for shape in safe(lambda: list(slide.shapes), []):
            if title_shape is not None and safe(lambda: shape.shape_id == title_shape.shape_id, False):
                continue
            blocks += shape_blocks(shape)
        if safe(lambda: slide.has_notes_slide, False):
            notes = safe(lambda: slide.notes_slide.notes_text_frame.text.strip(), "")
            if notes:
                blocks += ["### Notes", notes]
        pages.append("\n\n".join(blocks))
    return "\n\f\n".join(pages)


def xlsx_markdown(path):
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sections = []
    for name in workbook.sheetnames:
        sheet = workbook[name]
        rows, empty_run = [], 0
        for row in sheet.iter_rows(min_row=1, min_col=1, max_col=MAX_SHEET_COLS, values_only=True):
            filled = [i for i, c in enumerate(row, start=1) if c is not None and (not isinstance(c, str) or c.strip() != "")]
            if not filled:
                empty_run += 1
                continue
            # A run of empty rows inside the data is one empty row, whatever its length: a stray cell far down the
            # sheet must not become thousands of empty table rows. Rows end at their last non-empty cell.
            if empty_run and rows:
                rows.append([])
            empty_run = 0
            rows.append([cell(c) for c in row[:max(filled)]])
        first = min((min(i for i, c in enumerate(row) if c.strip()) for row in rows if any(c.strip() for c in row)), default=0)
        table = gfm_table([row[first:] for row in rows])
        sections.append(f"## {heading_text(name)}" + (f"\n\n{table}" if table else ""))
    return "\n\n".join(sections)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=["docx", "pptx", "xlsx"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        body = {"docx": docx_markdown, "pptx": pptx_markdown, "xlsx": xlsx_markdown}[args.kind](args.input)
    except ImportError as error:
        raise SystemExit(f"missing dependency: {error.name}")
    if args.kind in ("docx", "xlsx"):
        appendix = context_appendix(args.input)
        if appendix:
            body = f"{body}\n\n{appendix}" if body else appendix
    if len(body) > MAX_OUTPUT_CHARS:
        raise SystemExit(f"markdown exceeds {MAX_OUTPUT_CHARS} characters")
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(body + "\n")


if __name__ == "__main__":
    main()
