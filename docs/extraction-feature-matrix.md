# Extraction Adapter Feature Matrix

> Living reference for choosing the right extraction tool per document type and feature requirement. Update this when adding new adapters or benchmarks.

## Quick-Reference: Tool → Best For

| Tool | Best For | Avoid For | Relative Speed | Min RAM |
|------|----------|-----------|----------------|---------|
| **pymupdf-text** | Fast bulk text, large files (>100 pg) | Tables, math, images, layout | Fastest | **128 MB** |
| **pymupdf4llm** | Born-digital PDFs → markdown | Scanned pages, complex tables, math | Fast | **256 MB** |
| **pymupdf-ocr** | Scanned pages when tesseract is available | Born-digital (wastes time), poor handwriting | Medium | **512 MB** |
| **pymupdf-regions** | Layout analysis, header/footer/sidebar/body bboxes | Content extraction alone | Fast | **256 MB** |
| **docling** | Tables, figures, structured academic docs | Very large files (>50 MB), speed-critical | Medium | **2 GB** |
| **docling-vlm** | Math, formulas, complex figures, mixed content | Cost-sensitive, batch jobs, simple text | Slow | **4 GB** |
| **kreuzberg** | General-purpose markdown, links, metadata | Complex tables, heavy academic math | Fast-Medium | **512 MB** |
| **unstructured-fast** | Speed-first chunking | Tables, images, anything non-text | Fast | **1 GB** |
| **unstructured-hi_res** | Tables with cell bboxes, forms | Large files, cost-sensitive | Medium | **2 GB** |
| **unstructured-ocr_only** | Image-only PDFs | Text-native PDFs (wastes time) | Slow | **1.5 GB** |
| **marker** | High-quality academic PDFs → markdown | General business docs, speed-critical | Medium | **3 GB** |
| **pandoc** | Office docs (docx, odt), not PDFs | PDFs (unsupported) | Fast | **256 MB** |
| **vision-runtime** | Handwriting, degraded scans, charts, diagrams | Born-digital text (overkill, expensive) | Slowest | **1 GB** + GPU |
| **TableExtractor** (adapter) | Structured table data with row/col counts | Non-tabular pages | Medium | **256 MB** |
| **ImageExtractor** (adapter) | Embedded raster images, stamps, photos | Text-only pages | Fast | **512 MB** |
| **MathExtractor** (adapter) | LaTeX equations, display/inline math | Prose, tables | Medium-Slow | **2 GB** |

### RAM Footprint Guide

| Tier | RAM | Tools | Typical Use Case |
|------|-----|-------|------------------|
| **Lightweight** | 128–512 MB | pymupdf-text, pymupdf4llm, kreuzberg, pandoc | Batch processing, large files, simple text |
| **Standard** | 1–2 GB | unstructured-fast/hi_res, docling, TableExtractor, ImageExtractor | Most production docs with tables/images |
| **Heavy** | 3–4 GB | marker, docling-vlm, MathExtractor | Academic papers, math-heavy, quality-first |
| **GPU** | 1 GB+ VRAM | vision-runtime | Handwriting, charts, degraded scans |

> **Note**: These are *minimum* estimates for single-document processing. Concurrent processing scales roughly linearly — 4 parallel docs with docling needs ~8 GB. Use `pymupdf-text` for high-concurrency services.

---

## Detailed Feature Matrix

### Legend
- **✓** = First-class support (production quality)
- **~** = Partial support (needs validation or post-processing)
- **✗** = Not supported / loses data
- **N/A** = Tool doesn't target this use case

### 1. Content Type Support

| Feature | pymupdf-text | pymupdf4llm | pymupdf-ocr | docling | docling-vlm | kreuzberg | unstructured-hi_res | marker | vision |
|---------|:----------:|:-----------:|:-----------:|:-------:|:-----------:|:---------:|:-------------------:|:------:|:------:|
| Plain text | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ |
| Markdown output | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ~ | ✓ | ~ |
| HTML output | ~ | ~ | ~ | ✓ | ✓ | ✗ | ~ | ✗ | ✗ |
| JSON structured | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| Reading order | ~ | ✓ | ~ | ✓ | ✓ | ✓ | ~ | ✓ | N/A |
| Whitespace preservation | ~ | ✓ | ✗ | ✓ | ✓ | ~ | ✗ | ✓ | N/A |
| Font/style metadata | ✗ | ~ | ✗ | ✓ | ✓ | ~ | ✗ | ~ | N/A |

### 2. Table Support

| Feature | pymupdf-text | pymupdf4llm | docling | docling-vlm | kreuzberg | unstructured-hi_res | marker | TableExtractor |
|---------|:----------:|:-----------:|:-------:|:-----------:|:---------:|:-------------------:|:------:|:--------------:|
| Markdown tables | ✗ | ✓ | ✓ | ✓ | ~ | ~ | ✓ | ✓ |
| Multi-page tables | ✗ | ~ | ~ | ~ | ~ | ✗ | ~ | ~ |
| Cell-level bboxes | ✗ | ✗ | ~ | ~ | ✗ | ✓ | ✗ | ~ |
| Row/col counts | ✗ | ~ | ~ | ~ | ~ | ~ | ~ | ✓ |
| Nested tables | ✗ | ✗ | ~ | ~ | ✗ | ~ | ~ | ~ |
| Financial tables | ✗ | ~ | ✓ | ✓ | ~ | ✓ | ~ | ✓ |
| Invoice line-items | ✗ | ~ | ✓ | ✓ | ~ | ✓ | ~ | ✓ |
| Table → JSON data | ✗ | ✗ | ~ | ~ | ✗ | ~ | ✗ | ~ |

### 3. Image & Visual Support

| Feature | pymupdf-text | pymupdf4llm | docling | ImageExtractor | vision | marker |
|---------|:----------:|:-----------:|:-------:|:--------------:|:------:|:------:|
| Embedded raster extraction | ✗ | ✗ | ✗ | ✓ | N/A | ✗ |
| Image bbox in page | ✗ | ✗ | ~ | ~ | N/A | ✗ |
| Image classification | ✗ | ✗ | ✗ | ~ | N/A | ✗ |
| Image OCR (text-in-image) | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| Image caption/description | ✗ | ✗ | ✗ | ~ | ✓ | ✗ |
| Vector graphics → SVG | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Chart → structured data | ✗ | ✗ | ✗ | ✗ | ~ | ✗ |
| Diagram → description | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Stamp/signature detection | ✗ | ✗ | ✗ | ~ | ~ | ✗ |

### 4. Math & Specialized Content

| Feature | pymupdf-text | pymupdf4llm | docling | docling-vlm | MathExtractor | marker | kreuzberg |
|---------|:----------:|:-----------:|:-------:|:-----------:|:-------------:|:------:|:---------:|
| Inline math ($...$) | ✗ | ~ | ✓ | ✓ | ✓ | ~ | ~ |
| Display math ($$...$$) | ✗ | ~ | ✓ | ✓ | ✓ | ~ | ~ |
| LaTeX source extraction | ✗ | ✗ | ✗ | ~ | ~ | ✗ | ✗ |
| MathML output | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Code blocks (```) | ✗ | ~ | ✓ | ✓ | N/A | ~ | ✓ |
| Syntax highlighting | ✗ | ✗ | ✗ | ✗ | N/A | ✗ | ✗ |
| Chemical notation | ✗ | ✗ | ✗ | ~ | N/A | ✗ | ✗ |
| QR code content | ✗ | ✗ | ✗ | ✗ | N/A | ✗ | ✗ |

### 5. Layout & Structure

| Feature | pymupdf-text | pymupdf4llm | pymupdf-regions | docling | unstructured-hi_res | marker | kreuzberg |
|---------|:----------:|:-----------:|:---------------:|:-------:|:-------------------:|:------:|:---------:|
| Header detection | ✗ | ~ | ✓ | ✓ | ~ | ~ | ~ |
| Footer detection | ✗ | ~ | ✓ | ✓ | ~ | ~ | ~ |
| Sidebar/marginia | ✗ | ~ | ✓ | ~ | ~ | ~ | ✗ |
| Multi-column reading order | ✗ | ~ | ~ | ✓ | ~ | ✓ | ~ |
| Form field detection | ✗ | ✗ | ~ | ~ | ~ | ✗ | ✗ |
| Rotated text | ✗ | ✗ | ✗ | ~ | ~ | ~ | ✗ |
| Page-level bbox | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Paragraph-level bbox | ✗ | ✗ | ~ | ✓ | ✓ | ✗ | ✗ |
| Word-level bbox | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |

### 6. Performance & Operational

| Metric | pymupdf-text | pymupdf4llm | docling | docling-vlm | kreuzberg | unstructured-hi_res | marker | vision |
|--------|:----------:|:-----------:|:-------:|:-----------:|:---------:|:-------------------:|:------:|:------:|
| Pages/sec (approx) | 50-100 | 20-40 | 5-15 | 0.5-2 | 10-25 | 3-10 | 5-15 | 0.1-0.5 |
| Memory footprint | Low | Low-Med | Medium | High | Low | Medium | Medium | Very High |
| **Min RAM** | **128 MB** | **256 MB** | **2 GB** | **4 GB** | **512 MB** | **2 GB** | **3 GB** | **1 GB** + GPU |
| Streams output | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| GPU required | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Optional |
| Local only (no API cost) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ |
| Docker-friendly | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ |
| Python dependency | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ~ |

---

## Document Type → Recommended Adapter Stack

### Invoice / Financial Statement
**Goal**: Exact table cells, numeric accuracy, line-item extraction

| Priority | Tool | Role |
|----------|------|------|
| 1 | **unstructured-hi_res** | Primary: table bboxes + cell structure |
| 2 | **docling** | Fallback: markdown tables + figures |
| 3 | **pymupdf4llm** | Fast fallback: markdown + raw text |
| 4 | **TableExtractor** | Structured output: row/col counts + markdown |

**Routing rule**: `table-heavy` route → `unstructured` primary, `docling` fallback

---

### Academic Paper (LaTeX-born)
**Goal**: Preserve equations, citations, figures, section hierarchy

| Priority | Tool | Role |
|----------|------|------|
| 1 | **docling-vlm** | Primary: math, figures, complex layout |
| 2 | **marker** | Alternative: high-quality academic markdown |
| 3 | **MathExtractor** | Structured: LaTeX blocks with confidence |
| 4 | **ImageExtractor** | Embedded figures → descriptions |

**Routing rule**: `formula-heavy` or `report` → `docling-vlm` primary, `marker` fallback

---

### Scanned Document / Image PDF
**Goal**: Recover text from scans, handwriting, degraded pages

| Priority | Tool | Role |
|----------|------|------|
| 1 | **vision-runtime** | Primary: VLM page analysis for handwriting/degraded |
| 2 | **pymupdf-ocr** | Fallback: tesseract OCR on rendered pages |
| 3 | **ImageExtractor** | Extract embedded scan images for re-OCR |

**Routing rule**: `handwriting-or-degraded` → `vision` primary, `pymupdf-ocr` fallback

---

### Multi-column Magazine / Report
**Goal**: Correct reading order across columns, extract figures

| Priority | Tool | Role |
|----------|------|------|
| 1 | **marker** | Primary: best multi-column reading order |
| 2 | **docling** | Fallback: figures + structured layout |
| 3 | **pymupdf4llm** | Fast fallback: basic markdown |
| 4 | **pymupdf-regions** | Layout analysis: detect column boundaries |

**Routing rule**: `complex-layout` or `multicolumn` → `marker` primary, `docling` fallback

---

### Code Documentation / API Docs
**Goal**: Preserve code blocks, syntax, inline code

| Priority | Tool | Role |
|----------|------|------|
| 1 | **kreuzberg** | Primary: excellent code block preservation |
| 2 | **docling** | Fallback: structured sections + code |
| 3 | **pymupdf4llm** | Fast fallback: basic markdown |

**Routing rule**: `code-heavy` → `kreuzberg` primary, `docling` fallback

---

### Form / Intake Document
**Goal**: Extract field labels, values, checkbox states

| Priority | Tool | Role |
|----------|------|------|
| 1 | **unstructured-hi_res** | Primary: form elements + bboxes |
| 2 | **docling** | Fallback: layout-aware markdown |
| 3 | **vision-runtime** | Rescue: unreadable fields |

**Routing rule**: `form` → `unstructured` primary, `vision` for degraded fields

---

### Image-heavy Catalog / Brochure
**Goal**: Extract product images with captions, minimal text

| Priority | Tool | Role |
|----------|------|------|
| 1 | **ImageExtractor** | Primary: extract all embedded images |
| 2 | **vision-runtime** | Generate descriptions per image/page |
| 3 | **pymupdf-text** | Extract captions and surrounding text |

**Routing rule**: `image-heavy` → `ImageExtractor` + `vision` for descriptions

---

### Large Batch Processing (>100 pages, >50 MB)
**Goal**: Speed, memory efficiency, acceptable quality

| Priority | Tool | Role |
|----------|------|------|
| 1 | **pymupdf-text** | Primary: fast text for all pages |
| 2 | **pymupdf4llm** | Upgrade: select pages with tables/layout |
| 3 | **vision-runtime** | Rescue: only flagged degraded pages |

**Routing rule**: Large files → `pymupdf-text` default, selective heavy-tool rerun

---

## Known Pain Points & Mitigations

| Pain Point | Affected Tools | Mitigation |
|------------|---------------|------------|
| Tables split across page breaks | pymupdf4llm, kreuzberg, marker | Use `TableExtractor` + heuristic stitching |
| LaTeX ligatures (fi, fl, ff) | pymupdf-text, pymupdf4llm | Use `docling-vlm` or post-process normalization |
| Inline images with captions | All text extractors | Use `ImageExtractor` + `vision` for captioning |
| Handwriting mixed with print | pymupdf-ocr, tesseract | Use `vision-runtime` with handwriting prompt |
| Watermarks / stamps | All extractors | `pymupdf-regions` helps identify non-body text |
| QR codes | All extractors | Not yet supported; needs dedicated detector |
| Vector diagrams (flowcharts) | All extractors | Not yet supported; needs SVG converter |
| Nested tables | unstructured, docling | Flatten or use `TableExtractor` recursive parser |
| Multi-page table continuation | All | `TableExtractor` needs multi-page stitching logic |
| OCR on rotated pages | tesseract, pymupdf-ocr | Pre-deskew with `pymupdf-regions` rotation detection |

---

## Adapter Maturity Roadmap

| Adapter | Status | Next Milestone |
|---------|--------|----------------|
| pymupdf-text | Production | Stable |
| pymupdf4llm | Production | Stable |
| pymupdf-ocr | Production | Add deskew pre-processing |
| pymupdf-regions | Production | Add rotation detection |
| docling | Production | Reduce memory footprint |
| docling-vlm | Beta | Add batching for multi-page |
| kreuzberg | Production | Add table bbox support |
| unstructured-hi_res | Production | Optimize for large files |
| marker | Alpha | Add to runner scripts |
| **TableExtractor** | Implemented | Add unstructured backend, cell bboxes |
| **ImageExtractor** | Implemented | Add image classification + vision descriptions |
| **MathExtractor** | Implemented | Add MathML output option |
| **ContractAssembler** | Implemented | Add per-region quality scoring |
| vision-runtime | Production | Add structured-output prompts for charts |

---

## How to Use This Matrix

1. **Classify your document** with `ClassifyRouteStage` → get `pageRoutes`
2. **Look up the document type** above → see recommended tool stack
3. **Check the feature matrix** for specific needs (e.g. "do I need cell bboxes?")
4. **Configure routing** in `defaultRoutingConfig` or pass custom overrides
5. **Run extraction** and validate against expected signals in `fixtures.json`
6. **Iterate** — if quality is low, check the pain points table and add a fallback

---

*Last updated: 2025-04-22*
