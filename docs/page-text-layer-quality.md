# Text-layer quality: is this page's text readable?

`assessTextLayer` (`packages/shared/src/text-layer-quality.ts`) decides whether the text a PDF page already carries can be
trusted, so that only pages whose layer is broken are sent to a paid vision/OCR read. It replaces the old plausibility
score (`scoreExtractionPlausibility`: characters per page, mean word length, whitespace share; it scored `(cid:72)(cid:101)…`
0.90, mojibake 1.00 and a real short invoice 0.52) and the v2 `[A-Za-z0-9]{20,}` detector (flagged git hashes and DNA, missed
Windows-1251 mojibake). Routing consumes it through `decidePageRaster`; see [page-routing-evidence.md](page-routing-evidence.md).

## Method

Free, text-only checks, then an OCR cross-check for the pages that stay ambiguous. Every check is a Unicode property or a
count; nothing reads ASCII classes, keywords or file names.

| Layer | Evidence | Verdict |
|---|---|---|
| 1. Unmapped glyphs | U+FFFD, private-use code points, `(cid:N)` runs, C0/C1 controls over non-space characters | `garbled` from 10 %, `suspect` from 2 % |
| 2. Decoding mistakes | UTF-8 read as Latin-1/Windows-1252 (a lead letter then a continuation byte shown as punctuation: `Ã©`, `â€™`, `Ð¿Ñ€`) and UTF-8 Cyrillic read as Windows-1251 (`Р°РІС‚`), over non-space characters | `garbled` from 4 %, `suspect` from 0.4 % |
| 3. Glyph-code shift | Four or more long (20+) unspaced runs of ASCII letters, digits and marks that are all upper case/digits or case-mixed, over a wide alphabet, holding a quarter of the page. Hex digests, nucleotide sequences, URLs and addresses are exempt. | `garbled` |
| 3b. Symbol soup | ASCII punctuation at 40 % of the page over 10 or more distinct marks with few letters (a shift that lands on punctuation) | `garbled` |
| 4. Letter pairs | Mean log-probability per letter pair of the page's words under a pooled letter-bigram table for the page's dominant alphabetic script (Latin, Cyrillic, Greek). The script must hold half the page's letters, so a Latin unit inside Korean text is not judged as a Latin page. Acronyms and words under 3 letters are skipped. | `suspect` below -6.85, `garbled` below -8.2 with 60+ words |
| 5. Script mixing | One word with letters of two alphabetic scripts, in a fifth of the words | `suspect` |
| OCR cross-check | A sample of the suspect pages is rendered at 100 dpi, read by Tesseract in the layer's script and compared with the layer in reading order, **precision and recall**, both at least 0.5 (`tokenAgreement`) | decides `suspect` pages: a mismatch reads the page, a match keeps the layer, no result keeps the layer and is reported |

`suspect` never causes a paid read on its own. A consistent glyph substitution (a font whose code points were assigned in order of
first use, so every mark the first layers look for is absent) is the case layer 4 exists for, and it is also the one case
that needs the image to settle. The unchecked pages of a document take the sample's verdict when it is unanimous over at least
two checked pages (a substitution is a property of a font, so it shows on every page that font set); otherwise they stay
unchecked.

### Why a bigram table and not a dictionary or a model

A word list per language is a licensing and size problem and fails on names, codes and mixed documents. A trained OCR-error
classifier (Surya's) is a model per language in the worker. Caesar and substitution ciphers keep word lengths, spaces, case,
digits and every count a structural check sees; they change which letters follow which. The table is 28x28, 35x35 and 26x26
cells of one character each, generated from aggregate bigram counts of public Wikipedia article text in nine Latin-script
languages (en, de, fr, es, pl, fi, sv, it, tr), Russian, Ukrainian and Greek (counts only, no text kept; CC BY-SA sources).
Scripts without a vowel model (Arabic, Hebrew, Indic, Thai, CJK) get layers 1 to 3b and the OCR cross-check, never layer 4.

## Calibration (measured, not assumed)

Data: Wikipedia plain-text extracts in 21 languages (en de fr es pl fi sv it tr ru uk el ar he hi th ja ko zh), cut into
364 pages of about 1,800 characters (about 200 words), fetched into a scratch directory and deleted afterwards.

- **Clean pages: 364 of 364 `ok`**, including Japanese, Korean and Chinese pages with Latin units, numbers and punctuation.
- **Held-out letter-pair separation.** Trained on 70 % of each language and tested on the rest: natural pages scored -5.0 to
  -6.0; Caesar (shift 3, 13) and random substitution of the same pages scored -7.1 to -10.4. Leave-one-language-out (the
  language never seen): natural Turkish and Polish scored -6.3 to -6.96, still above the nearest cipher (-7.1). The
  `suspect` threshold (-6.85) sits in that gap; `garbled` (-8.2) is below every natural page measured by 1.2.
- **Ciphered pages** (Caesar 1, 3, 5, 13; random substitution): every page of an applicable script was `suspect` or `garbled`
  (none `ok`); shifted-glyph ASCII text 221 of 221 `garbled` (with or without spaces).
- **Mojibake** (UTF-8 read as Latin-1, Windows-1252, Windows-1251): `garbled` or `suspect` for every page that has non-ASCII
  characters; pages that are pure ASCII are unchanged by the mistake, as they should be.
- `(cid:N)`, U+FFFD and private-use replacement: 364 of 364 `garbled`.
- Tests also cover: git hashes and a DNA page (not `garbled`), code, a Markdown table, a 12-word page, Cyrillic and Greek
  headings, math with Greek letters and operators, and a Latin unit in CJK text.

Limits, stated plainly: the calibration language set is nine Latin-script languages plus Cyrillic and Greek, not all
alphabets; the page sample is encyclopedic prose, so tables of part numbers or names score lower and become `suspect`
(the cross-check then clears them, at about 1 CPU second per checked page); the bigram thresholds should be re-fitted if a
language outside the set shows false `suspect` verdicts. The cross-check is capped at 6 pages per document.

## Sources and prior art

- Firecrawl `pdf-inspector`: rule-based garbled-text detection (replacement characters, substitution-cipher patterns,
  CID-related text) marking pages for OCR. https://cdn.jsdelivr.net/npm/@firecrawl/pdf-inspector@1.11.1/README.md
- Surya / Marker: a classifier over text samples labelling a PDF's text bad when over 20 % of samples are; Marker's
  `OCR_ALL_PAGES` escape hatch and its targeted use of the text layer. https://github.com/datalab-to/marker
- OCRmyPDF: per-page "has text" skipping (`--skip-text`), forced rasterisation (`--force-ocr`) and removal of hidden OCR
  layers (`--redo-ocr`); it does not judge a visible layer's quality. https://ocrmypdf.readthedocs.io
- PDFium's character-map-error flag: characters with no valid Unicode mapping, in runs, mark text to re-extract through OCR.
- HuggingFace FinePDFs: an OCR-quality classifier over recognised text (no layout), whose authors found score filtering
  gave no measurable downstream benefit; a third-party FinePDFs-inspired pipeline routes between direct parsing and OCR
  with an XGBoost model over 124 PyMuPDF features (secondary claim, not verified against FinePDFs itself).
- Docling's parser keeps unmapped glyphs as `gNNN` names and falls back to OCR for pages without a usable layer
  (third-party port documentation; its own decision logic was not found).

What we did not adopt: pdffonts/ToUnicode inspection as the primary signal (it needs the PDF engine; the shadow page router's
probe already carries `unmappedGlyphRatio` and `no-tounicode`), and a learned router (a model to train, host and calibrate
per language). The text-only layers are cheap enough to run on every page of every document; the OCR cross-check is the
only paid-in-CPU step and runs on suspect pages only.
