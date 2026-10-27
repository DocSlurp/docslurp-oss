# Third-party license compatibility review

Reviewed October 7, 2026 against the checkout's manifests, Python lockfiles,
Dockerfiles, SDK imports, app copy and locally installed npm package notices.
This is a focused engineering review, not a complete distribution SBOM or a
legal clearance. Dependencies, models, fonts and assets retain their licenses;
the root SSPL/MIT split only grants rights in material DocSlurp may license.

## Unresolved release issues

| Component / evidence | Finding | Required resolution |
| --- | --- | --- |
| **Fully resolved 2026-10-15.** PyMuPDF 1.28.2 and PyMuPDF4LLM 0.3.4 (was in `worker/requirements-base.lock.txt`, the full/fallback locks, worker scripts, the eval-corpus builders and research rigs under `scripts/`, and `mupdf-tools` in `Dockerfile.full`) | MuPDF/PyMuPDF use AGPL or commercial terms. The production worker, its requirements files and locks and all three worker Dockerfiles no longer contain or import either package; PDFs use Kreuzberg, Poppler and the optional private `native-pdf` engine (MIT). The dev/eval scripts that authored, rasterised and redacted PDFs (`raster-eval`, `math-fidelity`, `external-corpora`, `page-router`, `remote-perf`, `routing-suite`, `routing-capacity`, `multimodal-eval`, `models/test_doclaynet.py`, CI's `equation-tools` job) now run on `scripts/pdfkit`, built from pypdf (BSD-3-Clause), pypdfium2/PDFium (Apache-2.0 OR BSD-3-Clause), reportlab (BSD-3-Clause, base-14 metrics), fontTools (MIT), WeasyPrint (BSD-3-Clause) and pdfplumber (MIT); see "Developer-script PDF toolkit" below. The `mupdf-tools` apt package (the MuPDF `mutool` binary, same engine) is gone from `Dockerfile.full`, the CLI setup scripts, the prerequisite check, the runner and the `pdf-tooling` catalog. See `internal research notes`. | None. Residual, third-party only: the pinned external ParseBench harness and the GLM-OCR SDK import PyMuPDF themselves, so the owner-run research hosts that install them (through the evaluation harness bootstrap scripts) still `pip install pymupdf` in isolated environments. No DocSlurp code, image, lock or CI job does. Frozen historical identifiers (`native:pymupdf` ledger target ids and recorded provenance rows in `scripts/page-router` and `scripts/remote-perf`, one fixture table cell) keep the old name because renaming would orphan the recorded results. |
| Marker 1.7.1 / Surya 0.14.1 (removed 2026-10-15) | Code is GPLv3 and the model weights are CC-BY-NC-SA with conditional small-company waivers that exclude competition with the Datalab API. The managed dependency was dropped on 2026-10-13 (Pillow security refresh); on 2026-10-15 the remaining adapter code was removed too: the `marker_single` runner plans, the `marker-pdf` entry in the PDF tooling catalog, the `marker` extractor in `extractor-benchmark-cli.ts`, and the Surya OCR 2 MLX profile in `local-vision-models.ts`. No lockfile, weight, install path or default references them. | Resolved by removal. Re-adding either needs a commercial grant for the exact weights revisions first; `parsebench-benchmark-cli.ts` still lists `surya` only as a module name inside the external ParseBench harness it patches (it does not install or download Surya). |
| GSAP 3.15.0 in `app/package.json` and app UI | Standard no-charge license permits commercial website/app animation, but is not MIT/SSPL and restricts competing visual animation builders. DocSlurp's observed use is ordinary UI animation. | Preserve proprietary notices and dependency terms. Review whether the shipped dashboard is a combined work whose SSPL redistribution obligations cannot be met; replace GSAP or obtain suitable permission if necessary. Do not claim GSAP was relicensed or label its commercial use itself prohibited. |
| Ghostscript, Poppler, Pandoc, ClamAV and other tools in worker images; Poppler in app image | System tools have their own copyleft/notice/source obligations. The images aggregate binaries and libraries; their license is not simply SSPL. | Inventory actual image versions and upstream copyright files, preserve corresponding source or compliant offers where required, and assess any combined-work boundary. A lean worker still contains copyleft tools. |
| Existing Apache versions and repository contributors | Earlier Apache grants survive. Multiple author identities appear in history; history does not establish assignments or relicensing authority. | Confirm rights for SSPL, MIT and future Apache grants; retain original notices. Copied third-party code cannot be relicensed by changing package metadata. |

## Phase 2 clearance inventory (open-source split gate)

Added October 15, 2026 for the open-source release plan. This
is an engineering inventory to prepare owner and counsel review. It states no
legal conclusion and clears nothing. "Likely" means expected from upstream's
public positioning and was not verified against the exact artifact. Nothing
has been cleared by this inventory alone; YOLO26 has since been dropped and the third-party test PDFs removed from the tree (see the YOLO26 and third-party test PDF rows).

| Item | Status | Needed | Owner decision |
| --- | --- | --- | --- |
| YOLO26 weights (Ultralytics, AGPL-3.0) | **Resolved 2026-10-15: dropped.** An unused layout experiment (`models/*.py`); no worker, server or app code ever loaded it and `ultralytics` was never a worker dependency. Removed the scripts, the weights manifest and fetcher, and the private-mirror ONNX copies; the bytes remain only in private git history. | None. |
| PyMuPDF 1.28.2 / PyMuPDF4LLM 0.3.4 (AGPL-3.0 or Artifex commercial) | **Fully resolved (2026-10-15).** Removed from `worker/requirements*.txt` and locks, all worker Dockerfiles, every worker code path and now every dev/eval script and CI job: the scripts run on `scripts/pdfkit` (pypdf, pypdfium2/PDFium, reportlab, fontTools, WeasyPrint, pdfplumber: all BSD-3-Clause, Apache-2.0 or MIT, versions and licence files verified from upstream), with true content-removal redaction on PDFium page objects. `scripts/native-pdf-ab` lost its PyMuPDF baseline arm and comparison script, and `scripts/legacy-pymupdf-probe` is now `scripts/legacy-page-probe` on pdfkit. `mupdf-tools` is removed from `Dockerfile.full` and everywhere else. The public export is unaffected either way: the dev scripts, `models/*.py` and the evaluation docs are not exported, and the exported `vendor-bundles/build.sh` smoke test writes its PDF by hand. | None. | Cleared. Choose whether to publish `scripts/pdfkit` (not exported today; it is optional, licence-clean tooling). |
| Docling vendor bundle (`worker/requirements-bundle-docling.txt`, `worker/vendor-bundles.json`): `docling`, `docling-core`, `docling-parse`, `docling-ibm-models`, CPU `torch`/`torchvision`, `transformers`, plus layout (heron), TableFormer and RapidOCR torch weights baked into the bundle | Bundles are built by `scripts/vendor-bundles/` and published by `.github/workflows/vendor-bundles.yml`; none are in the git tree (`artifacts` is empty until pinned). Docling code is likely MIT and the IBM models likely Apache-2.0/CDLA-permissive, but exact model revisions and every transitive wheel in the 1.7 GiB bundle (33,740 files) were not inventoried. | Per-bundle SBOM and licence report (for example `pip-licenses` on the build venv) and a per-model revision/licence table; ship the licence files inside the bundle; keep bundle contents out of the source export. | Decide whether bundle scripts and manifest are public. Approve the model list once the report is reviewed. |
| Unstructured vendor bundle (`unstructured[pdf,docx,pptx,xlsx,doc,odt,epub,md,rtf]`, `unstructured-inference`, spaCy `en_core_web_sm` 3.8.0, hi_res layout model, CPU torch) | Same build/publish path as Docling; 2.0 GiB unpacked. Unstructured is likely Apache-2.0 and `en_core_web_sm` likely MIT, but the hi_res layout weights and the extras' transitive licences (PDF, OCR and Office parsers, possible copyleft system tools) were not verified. | As Docling: SBOM, model revision table, check for copyleft transitive dependencies. | Same as Docling. Decide whether to keep Unstructured on the default path at all. |
| Marker 1.7.1 / Surya 0.14.1 | Removed (see the main table): no code path, lockfile entry, weight or install step remains. | None unless it is ever re-added. | Cleared by removal. |
| GSAP 3.15.0 (`app/package.json`) | Used only in the private frontend (`app/`), which is not in the public tree. Standard no-charge licence is not MIT/SSPL. Not redistributed by the public export. | Re-check if the frontend ever opens or is distributed (for example a self-host UI). | None now; revisit with the "self-host UI" decision. |
| Container and system tools (Ghostscript, Poppler, Pandoc, ClamAV, Tesseract, fonts, PDFium) in worker and app images | Copyleft/notice/source obligations apply to the images. No inventory of exact versions or upstream copyright files exists. | Per-image SBOM (for example Syft) and a notice bundle (`/usr/share/doc`), plus source offers where required, before any public image is built from the public tree. | Decide who publishes public images (GHCR from the public repo, per the ticket) and who owns source-offer compliance. |
| Other model weights and catalogs (Jina CC-BY-NC evaluation models, PP-OCRv6, embedding models loaded via Transformers, `models/` catalogs) | PP-OCRv6 and the Apache-2.0 Jina v2 production embeddings are documented above. Non-commercial Jina models are evaluation-only and are guarded by `NON_COMMERCIAL_MODE`. Revision-level inventory of every default model is incomplete. | A single table of default model ids, revisions, licences and the download point at runtime. | None beyond approving the table once complete. |
| Third-party test PDFs (formerly `worker/testdata/pdf-fixtures/`, 14 files, about 120 MB); removed from git 2026-10-15 | 5 CU Boulder catalogs (2021-22, 2023-24, 2024-25, 2025-26 and a 50-page cut of 2024-25): licence `LicenseRef-All-Rights-Reserved`, link-only per `scripts/raster-eval/public-licenses.json`; each upstream URL now pinned and verified to return the exact committed bytes (the old URLs in `data/curated-docs/sources.json` 404ed and were fixed). `us-census-1790-sample.pdf`: a 9-page merge of 1790 census scans, probably public domain (US federal publication) but the exact source was not recorded. 8 `mixed-media-and-langs/*.pdf` samples: collected from the web and re-saved through macOS Preview; **source and licence unknown**. The 11 synthetic fixtures (`academic-*`, `form-*`, `image-heavy-*`, `kreuzberg-*` (our own names), `multicolumn-*`, `tables-*`) and the two copies in `packages/evals/fixtures/assets` are generated by `generate-fixtures.mjs` (regenerated byte-identical on 2026-10-15) and stay in git. | Pinned in `worker/testdata/third-party-fixtures.manifest.json` and fetched by `pnpm fixtures:fetch` into `.cache/fixtures/pdf` (url + sha256 + licence + attribution). The census and mixed-media files have no upstream url yet: re-identify their sources and replace them with upstream pins or synthetic equivalents, or keep them on the private mirror (uploaded 2026-10-15, `DOCSLURP_ASSET_MIRROR`) and never export them. | Not exported. Identify sources for the 9 unlicensed-unknown files or delete them. |
| Contributor identities in git history (2,485 commits at 2026-10-15) | Dan Levy under three addresses, one of them a GitHub noreply (about 2,467 commits), `zeldamcbotface`/`Zelda` (11 commits; an automation identity), and `Claude` (7 commits, AI-generated authorship). The fresh-history export publishes none of this history, but the licence grant still depends on who owns the code. No assignment records exist for the history. External contributions will be covered by the new `CLA.md` (draft, 2026-10-15), which does not retroactively cover existing history. | Confirm the copyright holder named in `LICENSE` ("DocSlurp, Inc. and contributors") actually holds the rights: assignment or work-for-hire for the owner's own work, confirmation that the Zelda identity is the owner's or a contractor under agreement, and a position on AI-assisted code. Do not publish contributor emails. | Confirm rights and name the licensor (entity name and jurisdiction of "DocSlurp, Inc."). CLA chosen over DCO (2026-10-15); counsel to review `CLA.md` and `TRADEMARK.md`. |
| 0.1.x Apache-2.0 releases on npm (`@docslurp/sdk` 0.1.1 to 0.1.3, `@docslurp/cli` 0.1.1 to 0.1.3) | Published under Apache-2.0 and not revocable; later versions are MIT (SDK) and SSPL (CLI). `@docslurp/compat-algolia-server` 0.2.0 (now `@docslurp/contrib-algolia-server`) was published as MIT and stays MIT (root `LICENSE` MIT list, 2026-10-15). | Keep the Apache texts and NOTICE in all packages (already done). | None. |

Sources verified during the review:
[PyMuPDF licensing](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright),
[Marker 1.7.1 code license](https://github.com/datalab-to/marker/blob/v1.7.1/LICENSE),
[Marker 1.7.1 model conditions](https://github.com/datalab-to/marker/blob/v1.7.1/README.md#commercial-usage),
[Surya 0.14.1 code license](https://github.com/datalab-to/surya/blob/v0.14.1/LICENSE),
[Surya 0.14.1 model conditions](https://github.com/datalab-to/surya/blob/v0.14.1/README.md#commercial-usage),
[GSAP standard license](https://gsap.com/community/standard-license/),
[pypdf](https://github.com/py-pdf/pypdf/blob/main/LICENSE),
[pypdfium2 licensing](https://github.com/pypdfium2-team/pypdfium2#licensing),
[WeasyPrint](https://github.com/Kozea/WeasyPrint/blob/main/LICENSE),
[pdfplumber](https://github.com/jsvine/pdfplumber/blob/stable/LICENSE.txt).

## Developer-script PDF toolkit (`scripts/pdfkit`)

Added October 15, 2026. A small in-repo toolkit used only by dev and eval scripts (never by the worker, the app or a
shipped image) to author, inspect, rasterise and redact PDFs. Licences were read from each project's repository
`LICENSE` / SPDX headers and the installed wheel metadata on 2026-10-15; the pins are in `scripts/pdfkit/requirements.txt`.

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| [pypdf](https://github.com/py-pdf/pypdf) | 6.20.1 | BSD-3-Clause | PDF object model: pages, annotations, forms, attachments, AES-256 encryption, merging |
| [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) with bundled PDFium | 5.14.0 (PDFium 156.0.8076.0) | Apache-2.0 OR BSD-3-Clause; PDFium BSD-style; the wheel ships the notices for FreeType (FreeType Project License), ICU, lcms2, libjpeg-turbo, OpenJPEG, libpng, zlib and others in `BUILD_LICENSES/` | Rendering, text and glyph boxes, page objects, redaction engine |
| [reportlab](https://www.reportlab.com/opensource/) | 5.0.1 | BSD-3-Clause | Base-14 font metrics only |
| [fontTools](https://github.com/fonttools/fonttools) | 4.67.0 | MIT | TrueType subsetting and metrics for embedded fonts |
| [WeasyPrint](https://github.com/Kozea/WeasyPrint) | 70.0 | BSD-3-Clause (needs the system Pango library, LGPL, dynamically linked; plus pydyf, tinycss2, cssselect2 under BSD-3-Clause) | HTML/CSS pagination and SVG to PDF |
| [pdfplumber](https://github.com/jsvine/pdfplumber) and pdfminer.six | 0.11.10 / 20260107 | MIT | Ruled-table detection |
| [cryptography](https://github.com/pyca/cryptography) | 50.0.2 | Apache-2.0 OR BSD-3-Clause | AES-256 for pypdf |
| Poppler `pdftocairo` | system | GPL, separate process only | Glyph-outlined SVG of a page (the same way the worker already uses Poppler) |

Considered and not used: pikepdf (MPL-2.0, not MIT/Apache/BSD; `routing-suite` stopped using it too), pdf-lib (no
rendering, text extraction or content-stream redaction), pdf.js (needs a browser or Node harness for what PDFium does in
process), qpdf (Apache-2.0 but a CLI with no authoring or rendering), MuPDF-family libraries (AGPL).

Redaction removes content, it does not cover it: PDFium page objects (text runs, images, paths, including ones nested in
form XObjects) that intersect a redaction rectangle are deleted and the content stream is regenerated. Text is removed per
PDFium text object (at least half of the run inside a rectangle), which is coarser than per-glyph redaction.

Other tooling retained as is: CairoSVG 2.9.1 (LGPL-3.0) rasterises authored SVG equations in `scripts/math-fidelity/common.py`
(not a PDF library; evaluation-only environment, not distributed).

## Native PDF engine (MIT)

The optional in-process native PDF engine (`DOCSLURP_PDF_ENGINE`, extractor id
`native-pdf`) is a native PDF engine (MIT License), installed as a private,
pinned binary package rather than vendored source. The package carries its own
`LICENSE` file, which stays in `node_modules` inside every image that installs
it; that is how its MIT notice is satisfied. Code, public docs and the extractor
catalog use the neutral `native-pdf` id. It replaced PyMuPDF and
PyMuPDF4LLM (AGPL) in the worker on 2026-10-15; without the engine the worker falls back to
Kreuzberg and Poppler.

### Optional OCR models and CJK fonts

Worker images built with `DOCSLURP_NATIVE_PDF_OCR_MODELS=1` or
`DOCSLURP_NATIVE_PDF_CJK_FONTS=1` (off by default) also contain runtime assets
fetched and sha256-verified by `scripts/fetch-native-pdf-assets.mjs`. Their
license and notice files are installed next to them under `/opt/native-pdf/`.

- **PP-OCRv6 small detector, recognizer and dictionary** (`/opt/native-pdf/ocr-models`,
  ~30 MB): Apache-2.0. Model copyright Baidu (PaddleOCR, Copyright (c) 2016
  PaddlePaddle Authors); ONNX conversions by RapidOCR (Copyright (c) 2021
  RapidOCR Authors); RTen files and distribution from the `pylopdf-ocr-models`
  0.1.0 PyPI package (Copyright 2026 Yusuke Hayashi), mechanically converted
  without changing graph or weights. The package `NOTICE` is shipped as
  `NOTICE.txt`. Sources: <https://github.com/PaddlePaddle/PaddleOCR>,
  <https://github.com/RapidAI/RapidOCR>, <https://pypi.org/project/pylopdf-ocr-models/0.1.0/>.
- **Noto Sans and Noto Serif CJK JP, KR, SC and TC subset fonts**
  (`/opt/native-pdf/fonts`, 8 files, ~54 MB): SIL Open Font License 1.1,
  from <https://github.com/notofonts/noto-cjk> (`Sans/SubsetOTF`,
  `Serif/SubsetOTF`), as packaged in the `pylopdf-fonts-{jp,ko,zh-cn,zh-tw}`
  0.1.1 PyPI packages. Shipped unmodified, used only for rendering; the OFL
  text is shipped as `LICENSE-OFL-1.1.txt`.

## Non-commercial model weights

`jinaai/jina-ocr-v1` and `jinaai/jina-embeddings-v5-omni-small`/`-nano` are
CC-BY-NC-4.0. They are used only by evaluation scripts in
evaluation scripts, which refuse them unless `NON_COMMERCIAL_MODE=true`
(`model_licensing.py`). Production Jina embeddings (`jina-embeddings-v2-base-en`,
`jina-embeddings-v2-base-code`) are Apache-2.0.

## App and SDK compatibility findings

- SDK documentation, CLI/SDK READMEs and release documentation previously
  advertised Apache-2.0 for both packages. They now distinguish MIT SDKs from
  the SSPL CLI. The hosted terms preserve published software license rights.
- The API lives in `server/` (`@docslurp/server`, SSPL like the dashboard that mounts it). Shared contracts have an explicit MIT exception.
  SDK and client adapter source imports were inspected for server/worker
  dependencies; no such runtime imports were found. The server-side Algolia
  adapter is separately SSPL. The WordPress plugin is a separately licensed
  MIT HTTP integration, which is GPL-compatible for WordPress consumers.
- The core published SDK and CLI have no runtime npm dependencies. Embed SDK
  dependencies include Apache-2.0 Transformers/LanceDB and MIT React. Model
  weights loaded through Transformers require a separate revision/license
  check; the library license does not cover every downloadable model.
- Local npm-store metadata was predominantly MIT, Apache, ISC, BSD and 0BSD.
  This store includes historical versions and development-only packages and
  is not an exact production dependency graph. No blanket clearance follows.
  JSZip offers an MIT alternative to GPL; use MIT and preserve its notice.
  MPL dependencies require applicable file-level notices/source obligations.
- Missing npm `license` fields were checked against installed text: base-64
  supplies MIT; json-bignum supplies MIT/legacy `licenses` metadata; unionfs
  supplies Unlicense; flatbuffers supplies Apache text; callsite's README
  says MIT but lacks a standalone license file in the inspected installation.
  Verify a complete copyright/permission notice for callsite before distribution.
- Font licenses, bundled PDFium/Tesseract/native notices, model catalogs and
  generated/vendor assets still need an exact artifact-level inventory.
  `docs/video/integration` has its own UNLICENSED private package metadata
  and Remotion terms; the root license does not replace explicit notices.

The changes ship DocSlurp license/NOTICE texts with package allowlists and
containers and expose human-readable UI/CLI notices. They do not remove
parsers, buy commercial licenses, or claim that third-party obligations are
resolved. Track outstanding clearance and packaging work in TODO.md.

## Vendored shadcn Tailwind stylesheet (MIT)

`app/src/styles/vendor/shadcn-tailwind.css` preserves `dist/tailwind.css` from
the published shadcn 4.21.4 package without its component-generator runtime
dependencies. Copyright (c) 2023 shadcn; the original MIT notice is retained
in `LICENSES/shadcn-MIT.txt`. The file header records the package source and
original stylesheet SHA-256. Other shadcn-derived components retain their
existing provenance and notices.

## landrun (Landlock sandbox provider, MIT)

The `landlock` parser sandbox provider runs parsers through landrun
(https://github.com/Zouuup/landrun), a separate process downloaded as a
prebuilt release binary into the worker images. Pinned version v0.1.17, MIT
(Copyright (c) 2025 Armin ranjbar; the LICENSE at tag v0.1.17 was checked).
Releases before v0.1.12 were GPL-2.0 and must not be used. URL and sha256 per
architecture (amd64, arm64) are pinned in `worker/sandbox-tools.json` and
verified at image build. The binary needs glibc 2.38 or newer (Debian trixie,
not bookworm).

## Public Suffix List (MPL-2.0)

`server/src/lib/public-suffix-data.ts` is generated from the Public Suffix List
(https://publicsuffix.org/list/public_suffix_list.dat, ICANN and private
sections) by `server/scripts/update-public-suffix-list.mjs`. The list is
licensed under the Mozilla Public License 2.0; the generated file keeps the MPL
notice, and the list version and commit are recorded in its header. It is used
only as data, to refuse browser-key allowed websites that are shared public
suffixes. Refresh it by running the script and committing the result.
