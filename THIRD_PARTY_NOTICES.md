# Third-party license compatibility review

Reviewed October 7, 2026 against the checkout's manifests, Python lockfiles,
Dockerfiles, SDK imports, app copy and locally installed npm package notices.
This is a focused engineering review, not a complete distribution SBOM or a
legal clearance. Dependencies, models, fonts and assets retain their licenses;
the root SSPL/MIT split only grants rights in material DocSlurp may license.

## Unresolved release issues

| Component / evidence | Finding | Required resolution |
| --- | --- | --- |
| PyMuPDF 1.27.2.2 and PyMuPDF4LLM 0.3.4 in `worker/requirements-base.lock.txt`, full/fallback locks and worker scripts | MuPDF/PyMuPDF use AGPL or commercial terms. SSPL and a future Apache grant do not satisfy AGPL obligations for a combined derivative. Subprocess execution alone is not proof of independence. | Obtain applicable Artifex commercial rights, replace the integration, or review a compliant independent/AGPL distribution boundary before shipping this server license. No commercial agreement was verified. |
| Marker 1.7.1 / Surya 0.14.1 in full/fallback lockfiles; heavy installation on first boot | Code is GPLv3. Pinned READMEs describe CC-BY-NC-SA model weights with conditional small-company waivers that expressly exclude competition with Datalab API. Revenue/funding limits differ between Marker and Surya. DocSlurp's document ingestion service may compete. | Verify exact downloaded revisions and an applicable commercial grant, or remove/replace the affected production path. Neither SSPL nor AGPL grants rights to restricted weights. First-boot downloads still count. |
| GSAP 3.15.0 in `app/package.json` and app UI | Standard no-charge license permits commercial website/app animation, but is not MIT/SSPL and restricts competing visual animation builders. DocSlurp's observed use is ordinary UI animation. | Preserve proprietary notices and dependency terms. Review whether the shipped dashboard is a combined work whose SSPL redistribution obligations cannot be met; replace GSAP or obtain suitable permission if necessary. Do not claim GSAP was relicensed or label its commercial use itself prohibited. |
| Ghostscript, MuPDF tools, Poppler, Pandoc, ClamAV and other tools in worker images; Poppler in app image | System tools have their own copyleft/notice/source obligations. The images aggregate binaries and libraries; their license is not simply SSPL. | Inventory actual image versions and upstream copyright files, preserve corresponding source or compliant offers where required, and assess any combined-work boundary. A lean worker still contains copyleft tools. |
| Existing Apache versions and repository contributors | Earlier Apache grants survive. Multiple author identities appear in history; history does not establish assignments or relicensing authority. | Confirm rights for SSPL, MIT and future Apache grants; retain original notices. Copied third-party code cannot be relicensed by changing package metadata. |

## Phase 2 clearance inventory (open-source split gate)

Added October 15, 2026 for the open-source release plan. This
is an engineering inventory to prepare owner and counsel review. It states no
legal conclusion and clears nothing. "Likely" means expected from upstream's
public positioning and was not verified against the exact artifact. Nothing
has been deleted or replaced.

| Item | Status | Needed | Owner decision |
| --- | --- | --- | --- |
| YOLO26 weights, 36 files (`.pt`, `-cpu/-gpu/-mps.onnx`; `seg`, `pose`, `doclaynet`; n/s/m) in `models/yolo26/`, about 1.2 GB, tracked in the private repo; produced by `models/ultralytics_yolo.py` | Ultralytics YOLO code and weights are likely AGPL-3.0 unless an Ultralytics enterprise licence applies. The `doclaynet` variants presumably derive from DocLayNet training data (its own dataset licence applies); the repo does not record how they were trained or obtained. No production worker path loads them (only `models/*.py` scripts). Weights are now pinned in `models/weights.manifest.json` and fetched on first use, so the public tree can exclude them. | Confirm what licence the weights were obtained under (pretrained from Ultralytics vs trained here); either buy the Ultralytics enterprise licence, retrain/replace with a permissively licensed layout detector, or drop the weights and scripts from the public export. Pick a host for the fetch base URL only after this is decided. | Weights stay out of the public tree until resolved. Decide: enterprise licence, replace, or remove. |
| PyMuPDF 1.27.2.2 / PyMuPDF4LLM 0.3.4 (AGPL-3.0 or Artifex commercial) | In `worker/requirements-base.lock.txt` and, per `docs/worker-image.md`, now baked into the production worker image's `/app/.venv` as a base parser. SSPL plus a future Apache grant does not match AGPL obligations; subprocess use alone is not proof of independence. The MIT `native-pdf` engine is the planned replacement but has not passed its promotion gate. | Artifex commercial licence, replacement (finish the `native-pdf` promotion), or a counsel-reviewed AGPL boundary. Decide whether the public worker image ships it. | Blocker for publishing the worker image and `worker/requirements*.lock.txt`. Choose commercial licence vs replacement vs exclude from the public build. |
| Docling vendor bundle (`worker/requirements-bundle-docling.txt`, `worker/vendor-bundles.json`): `docling`, `docling-core`, `docling-parse`, `docling-ibm-models`, CPU `torch`/`torchvision`, `transformers`, plus layout (heron), TableFormer and RapidOCR torch weights baked into the bundle | Bundles are built by `scripts/vendor-bundles/` and published by `.github/workflows/vendor-bundles.yml`; none are in the git tree (`artifacts` is empty until pinned). Docling code is likely MIT and the IBM models likely Apache-2.0/CDLA-permissive, but exact model revisions and every transitive wheel in the 1.7 GiB bundle (33,740 files) were not inventoried. | Per-bundle SBOM and licence report (for example `pip-licenses` on the build venv) and a per-model revision/licence table; ship the licence files inside the bundle; keep bundle contents out of the source export. | Decide whether bundle scripts and manifest are public. Approve the model list once the report is reviewed. |
| Unstructured vendor bundle (`unstructured[pdf,docx,pptx,xlsx,doc,odt,epub,md,rtf]`, `unstructured-inference`, spaCy `en_core_web_sm` 3.8.0, hi_res layout model, CPU torch) | Same build/publish path as Docling; 2.0 GiB unpacked. Unstructured is likely Apache-2.0 and `en_core_web_sm` likely MIT, but the hi_res layout weights and the extras' transitive licences (PDF, OCR and Office parsers, possible copyleft system tools) were not verified. | As Docling: SBOM, model revision table, check for copyleft transitive dependencies. | Same as Docling. Decide whether to keep Unstructured on the default path at all. |
| Marker 1.7.1 / Surya 0.14.1 | Code GPLv3, model weights CC-BY-NC-SA with conditional small-company waivers that exclude competing with Datalab's API (see the main table). Locked in the full/fallback lockfiles and installed on first boot of heavy workers. | A commercial grant for the exact weights revisions, or removal/replacement of the production path. First-boot downloads still count. | Keep, license or remove. Until decided, exclude the full/fallback lockfiles and the first-boot install path from the public export, or default them off with a clear notice. |
| GSAP 3.15.0 (`app/package.json`) | Used only in the private frontend (`app/`), which is not in the public tree. Standard no-charge licence is not MIT/SSPL. Not redistributed by the public export. | Re-check if the frontend ever opens or is distributed (for example a self-host UI). | None now; revisit with the "self-host UI" decision. |
| Container and system tools (Ghostscript, MuPDF tools, Poppler, Pandoc, ClamAV, Tesseract, fonts, PDFium) in worker and app images | Copyleft/notice/source obligations apply to the images. No inventory of exact versions or upstream copyright files exists. | Per-image SBOM (for example Syft) and a notice bundle (`/usr/share/doc`), plus source offers where required, before any public image is built from the public tree. | Decide who publishes public images (GHCR from the public repo, per the ticket) and who owns source-offer compliance. |
| Other model weights and catalogs (Jina CC-BY-NC evaluation models, PP-OCRv6, embedding models loaded via Transformers, `models/` catalogs) | PP-OCRv6 and the Apache-2.0 Jina v2 production embeddings are documented above. Non-commercial Jina models are evaluation-only and are guarded by `NON_COMMERCIAL_MODE`. Revision-level inventory of every default model is incomplete. | A single table of default model ids, revisions, licences and the download point at runtime. | None beyond approving the table once complete. |
| Contributor identities in git history (2,485 commits at 2026-10-15) | Dan Levy under three addresses, one of them a GitHub noreply (about 2,467 commits), `zeldamcbotface`/`Zelda` (11 commits; an automation identity), and `Claude` (7 commits, AI-generated authorship). The fresh-history export publishes none of this history, but the licence grant still depends on who owns the code. No CLA, DCO or assignment records exist. | Confirm the copyright holder named in `LICENSE` ("DocSlurp, Inc. and contributors") actually holds the rights: assignment or work-for-hire for the owner's own work, confirmation that the Zelda identity is the owner's or a contractor under agreement, and a position on AI-assisted code. Do not publish contributor emails. | Confirm rights and name the licensor. Choose CLA vs DCO for external contributions. |
| 0.1.x Apache-2.0 releases on npm (`@docslurp/sdk` 0.1.1 to 0.1.3, `@docslurp/cli` 0.1.1 to 0.1.3) | Published under Apache-2.0 and not revocable; later versions are MIT (SDK) and SSPL (CLI). `@docslurp/compat-algolia-server` 0.2.0 (now `@docslurp/contrib-algolia-server`) was published as MIT; its package metadata and LICENSE now say SSPL for the next release (see `docs/licensing.md`). | Keep the Apache texts and NOTICE in all packages (already done). Decide whether the next contrib-algolia-server release really moves to SSPL, or the root LICENSE moves it to the MIT list. | Confirm SSPL vs MIT for `contrib-algolia-server`. |

Sources verified during the review:
[PyMuPDF licensing](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright),
[Marker 1.7.1 code license](https://github.com/datalab-to/marker/blob/v1.7.1/LICENSE),
[Marker 1.7.1 model conditions](https://github.com/datalab-to/marker/blob/v1.7.1/README.md#commercial-usage),
[Surya 0.14.1 code license](https://github.com/datalab-to/surya/blob/v0.14.1/LICENSE),
[Surya 0.14.1 model conditions](https://github.com/datalab-to/surya/blob/v0.14.1/README.md#commercial-usage),
[GSAP standard license](https://gsap.com/community/standard-license/).

## Native PDF engine (MIT)

The optional in-process native PDF engine (`DOCSLURP_PDF_ENGINE`, extractor id
`native-pdf`) is a native PDF engine (MIT License), installed as a private,
pinned binary package rather than vendored source. The package carries its own
`LICENSE` file, which stays in `node_modules` inside every image that installs
it; that is how its MIT notice is satisfied. Code, public docs and the extractor
catalog use the neutral `native-pdf` id. It is intended to replace PyMuPDF and
PyMuPDF4LLM (AGPL) on the default PDF path once it passes the promotion gate.

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
