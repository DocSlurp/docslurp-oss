# Benchmark-Informed Coverage

This fixture set is synthetic, but the cases were selected to mirror the failure modes that show up repeatedly in popular document parsing and multimodal RAG benchmarks.

- [DocLayNet](https://github.com/DS4SD/DocLayNet): layout diversity across titles, paragraphs, lists, tables, figures, and marginal content.
- [PubTables-1M](https://github.com/microsoft/table-transformer): dense tables, structure recovery, and page-spanning table continuity.
- [OmniDocBench](https://github.com/opendatalab/OmniDocBench): block/span parsing, inline formulas, varied layouts, and richer annotation targets.
- [olmOCR-Bench](https://huggingface.co/datasets/Voxel51/olmOCR_bench): OCR-style page-to-text extraction from visually rich PDF pages.
- [OHR-Bench](https://github.com/opendatalab/OHR-Bench): downstream RAG sensitivity to OCR errors across plain text, tables, formulas, charts, and reading order.
- [MMLongBench-Doc](https://github.com/mayubo2333/MMLongBench-Doc): long multimodal PDFs with text, tables, charts, and images.
- [Open RAG Benchmark](https://github.com/vectara/open-rag-bench): multimodal PDF understanding for end-to-end RAG evaluation.

## Fixture Mapping

- `tables-multipage-financials.pdf`: page-spanning financial tables with repeated headers and continuation markers.
- `academic-latex-ligatures.pdf`: formula-heavy academic prose with ligature-prone vocabulary and code-style math text.
- `image-heavy-ocr.pdf`: OCR-first invoice and approval-note pages composed as raster images inside the PDF.
- `multicolumn-figures-report.pdf`: two-column technical report layout with figure captions, a chart image, and side notes.
- `form-rotated-notes.pdf`: form fields, checkboxes, rotated text, handwritten-style marks, and operational annotations.

## Why Generate Instead Of Vendor

The public benchmarks above are excellent for large-scale evaluation, but they are a poor fit for committing directly into this repository because they are large, frequently redistributed via separate dataset hosts, and may bundle source PDFs with different licensing terms. The local corpus here is intentionally small, deterministic, and safe to commit while still exercising the same parser failure classes.
