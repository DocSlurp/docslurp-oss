#!/usr/bin/env python3
"""Extract sheets from XLSX as CSV using openpyxl.

Default mode writes every sheet as CSV (the fallback spreadsheet extractor).
`--structure-only` is the cheap sidecar used for citation locators: it records where the table sits (first/last row and
column, header row, absolute data-row numbers) and only the header rows as CSV, with a bounded scan so a sheet whose
declared dimension is A1:XFD1048576 cannot spin for the whole timeout.
"""
import argparse
import csv
import io
import json
import sys


MAX_ROW_NUMBERS = 1_000_000
# Structure-only scan bounds. Exceeding them sets `truncated`, which makes the consumer fall back to table-level ranges.
STRUCTURE_MAX_ROWS = 200_000
STRUCTURE_MAX_COLS = 512
STRUCTURE_MAX_EMPTY_RUN = 5_000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--structure-only", action="store_true")
    args = parser.parse_args()

    try:
        import openpyxl
    except ImportError:
        with open(args.output, "w") as f:
            json.dump({"error": "openpyxl not installed", "sheets": []}, f)
        sys.exit(1)

    wb = openpyxl.load_workbook(args.input, read_only=True, data_only=True)
    sheets = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        buf = io.StringIO()
        writer = csv.writer(buf)
        # Absolute positions: iterate from A1 so row/column numbers match what a spreadsheet user sees.
        first_row = first_col = None
        last_row = last_col = 0
        data_rows = []
        truncated = False
        empty_run = 0
        kwargs = {"min_row": 1, "min_col": 1, "values_only": True}
        if args.structure_only:
            kwargs.update(max_row=STRUCTURE_MAX_ROWS, max_col=STRUCTURE_MAX_COLS)
        for row_number, row in enumerate(ws.iter_rows(**kwargs), start=1):
            filled = [i for i, c in enumerate(row, start=1) if c is not None and (not isinstance(c, str) or c.strip() != "")]
            if not filled:
                empty_run += 1
                if args.structure_only and first_row is not None and empty_run >= STRUCTURE_MAX_EMPTY_RUN:
                    truncated = True
                    break
                if not args.structure_only:
                    writer.writerow([""] * len(row))
                elif first_row is None or row_number <= first_row:
                    writer.writerow([""] * len(row))
                continue
            empty_run = 0
            first_row = row_number if first_row is None else first_row
            first_col = min(filled) if first_col is None else min(first_col, min(filled))
            last_row = row_number
            last_col = max(last_col, max(filled))
            # Structure-only keeps just the rows up to the header (the first non-empty row); data rows are numbers only.
            if not args.structure_only or row_number == first_row:
                writer.writerow([str(c) if c is not None else "" for c in row])
            if row_number != first_row:
                if len(data_rows) < MAX_ROW_NUMBERS:
                    data_rows.append(row_number)
                else:
                    truncated = True
        if args.structure_only and not truncated:
            # Rows past the scan limit exist when the sheet declares more than we looked at.
            declared = getattr(ws, "max_row", None)
            truncated = isinstance(declared, int) and declared > STRUCTURE_MAX_ROWS and last_row >= STRUCTURE_MAX_ROWS - STRUCTURE_MAX_EMPTY_RUN
        sheets.append({
            "name": sheet_name,
            "csv": buf.getvalue(),
            "firstRow": first_row,
            "firstCol": first_col,
            "lastRow": last_row if first_row else None,
            "lastCol": last_col if first_row else None,
            "headerRow": first_row,
            "dataRows": data_rows,
            "truncated": truncated,
        })

    with open(args.output, "w") as f:
        json.dump({"sheets": sheets, "sheetCount": len(sheets), "extractor": "openpyxl"}, f)


if __name__ == "__main__":
    main()
