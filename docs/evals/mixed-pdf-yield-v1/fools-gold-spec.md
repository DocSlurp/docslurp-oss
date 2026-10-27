# Mixed document reconstruction spec

Mode: synthetic. Format: PDF; ten US-letter pages per source family.
Content: invented operational reports, equipment guidance, engineering briefs,
inspection records, procurement summaries and research-style discussions.
No real organization/person names or invented claims about real entities.
This is a source-free structural specification. Do never inspect earlier fixtures.

## Global look

Three independent geometries: single-column report; two-column technical briefs;
report with side panel and chart. Noto Sans / Noto Serif embedded fonts, 10–11 pt
body, 14–18 pt headings, 40–48 pt margins. Use realistic restrained accent colors,
running page numbers and footer. Body should fill roughly 60–80% of usable height.
No corpus IDs, generator disclosures, sample disclaimers or placeholder language
inside the file or metadata. Realistic title and export metadata; provenance outside.

## Blocks in reading order

Every page has stable block IDs and authored bounding boxes in PDF top-left points.
1. Heading and short identifying subtitle: 8–18 words.
2. Body: two or three paragraphs, 140–220 words total. Describe a specific internally
   consistent decision, observations and qualifications; vary prose across families.
3. Technical block: a genuine ReportLab Table or HTML table with 4–7 rows and
   3–5 columns, explicit cell strings and header row. Some pages instead contain
   prose only, or a properly plotted vector chart with data and legend. Preserve
   table cells, chart data and applicable formulas in gold separately. Across each
   ten-page family, at least four pages also include a compact monospaced technical
   rule and aligned numeric matrix. These coexist with the table/chart, not replace
   them. Use invented, internally consistent equations with operators, parentheses,
   subscripts or exponents and a stated interval or constraint. Author the literal
   printed expression and its semantic representation before rendering. Include
   these blocks in native, section-raster and hard-scan variants; never leave all
   formula arrays empty. Provide close-up previews of native and scanned technical
   blocks and validate that all symbols survive rendering without clipping.
4. Discussed-document inset: independently authored document excerpt, visually
   distinguished border/header, 40–80 words plus 25–45 words of surrounding
   commentary. On selected pages it is an embedded screenshot, never selectable text.
5. Caption/footer: concise and relevant. Decorative text-free figures may be present.

## Difficulty features

Keep coherent reading order in gold. For each source family derive six ten-page
documents. All gold representations must agree on block order: section strings,
expected Markdown and readingOrder place chart labels at the chart position before
its caption. Chart blocks explicitly reference their literal title, axes, ticks and
legend; plotted values remain separate data, not invented printed words. Then create
documents with exactly 0,2,4,6,8,10 hard-scanned pages. Independently cross three
layouts with section raster fractions 0,.2,.4,.6,.8,1 in every 18-family block.
Hard scans: controlled 85–125 DPI, mild skew, blur, contrast and JPEG degradation;
log realized parameters and selected page IDs. Other pages can rasterize individual
sections, outline one text section as vectors, include optional hidden/occluded decoy
text, overlapping images, and 90-degree rotation. Excluded decoys belong in gold.
Gold describes rendered material only. No lost text from textbox overflow or clipping.
Full rasterization must start with a blank page containing only the scan pixels;
painting a scan over a still-extractable native page fails this requirement. Section
rasterization must remove underlying text for that section while preserving the rest.
Check native extraction on the resulting scan is empty (except separately declared
OCR text layers, which are a different test class). Gold includes every meaningful
printed header, footer, caption, axis/legend label and inset title; never infer gold
from extractor output. Build the complete authoring model before rendering; persist
it before raster conversion. Gold sections and paragraphs are strings; retain their
geometry separately as blocks. PDF hard suffixes are percentages, never page counts.
Full generation must route all families to the declared splits and emit a complete
hashed corpus manifest. Hash actual file bytes, never a JSON object containing its
own hash. Vary native producer and PDF storage profile independently of hard share.
Apply transformations only after saving authored reference Markdown, paragraphs,
section strings, cell rows, expected reading order, geometry and source layout.

## File profile

Vary actual production paths: ReportLab native PDF and an HTML/LibreOffice export
path where available; record actual producer rather than merely changing its label.
PDF Producer must identify the actual production software and version, not a generic
department export string. Preserve its original software identity when later tools
rewrite the file and record compositor/rewrite history separately. Realistic title
and author fields may describe the invented organization. Documented software
metadata is intentional producer diversity, not a placeholder to disguise.
Use QPDF to cross classic xref/object streams and linearized/unlinearized storage
without changing visuals. At least versions 1.4, 1.7; object streams only >=1.5.
No encryption. Embed fonts. Keep image masks where authored. Record file profiles.
Compare storage variants with pixel_diff against their own base; intended degradation
is checked against transformation spec rather than a no-change pixel threshold.

## Dataset identity and delivery

90 families, first54 train, next18 tune, last18 heldout. All derivatives remain in
their family split. Use fixed random seeds and world.json values shared within each
family, never across splits. Before full expansion, create three training prototypes
(one per layout) and render previews for independent audit. Accept only after skill
score.py and visual judge gates pass; no self-declared passing scores.

Each page reference includes expectedMarkdown, sections, paragraphs, tables (rows
including header), formulas, excludedText, bbox, stable pageId and canonical content
hash. Preserve native build sources and gold before rasterization. Each case manifest
includes id,family,split,pdf,labels,sha256,labelHash,sourceLayoutHash,hardPercent,
baseRegionRasterShare,pages (realized transformation metadata), layout,genre,producer.
Case names use mixed-source-NNNN-hard-NNN; these are external paths only, never content.
Save immutable difficulty plans alongside source content. Case exclusions must bind
exactly to authored decoys and realized transformations; they may not introduce new
reference content. Keep page identities stable and describe coordinate transforms
explicitly. The coordinator validates these bindings before sealing labels.
Emit source references under sources/, PDFs under inputs/SPLIT/, labels under
labels/SPLIT/. Corpus schema mixed-pdf-authored@v2. Never write customer files or
call model APIs from generator code. Do never open heldout outputs for manual inspection.
