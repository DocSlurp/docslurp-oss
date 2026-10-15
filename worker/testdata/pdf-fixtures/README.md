Opt-in PDF evaluation corpus for difficult extraction cases.

Tracked here: only the synthetic PDFs written by `generate-fixtures.mjs` (they regenerate byte-identically, so
they are ours and licence-clean). Third-party PDFs (course catalogs, a census scan, mixed-media samples) are
**not** in git: `edge-fixtures.json` references them by relative path and `pnpm fixtures:fetch` downloads them
into the gitignored `.cache/fixtures/pdf/` from `../third-party-fixtures.manifest.json` (url, sha256, licence,
attribution per file). `pnpm fixtures:fetch --check` verifies the cache offline, `--remote` HEADs every url.
Files with no recorded upstream (`source: "private-mirror"`) need the private mirror (`DOCSLURP_ASSET_MIRROR` + `DOCSLURP_ASSET_S3_*`, read-only team key; see docs/licensing.md); the benchmark CLIs
skip fixtures that are absent and say so. Never copy fetched files into this directory or commit them.

Add fixture PDFs matching the entries in `fixtures.json` here. The TypeScript benchmark harness can be run with:

```bash
cd worker
pnpm benchmark:kreuzberg
```

Generate the synthetic corpus locally with:

```bash
cd worker
node testdata/pdf-fixtures/generate-fixtures.mjs
```

Run the deterministic document-routing eval with:

```bash
cd worker
pnpm eval:document-routing
```

The routing eval uses `document-routing-eval-v1.json` to assert page routes,
extractor hints, OCR authorization, and document playbooks for handwriting,
image-only scans, forms, contiguous tables, formulas, and a born-digital
negative control. It runs LiteParse locally with OCR disabled, makes no hosted
AI calls, and reports quality, fixture pass rate, and p95 routing latency. Use
`--tags handwriting,scanned` to select a subset or `--output <path>` to retain a
JSON report. Fixture-specific expectations belong in the manifest only; do not
copy them into production routing heuristics.

The generated set is intentionally synthetic rather than copied from public benchmarks. That keeps the repo small, avoids licensing ambiguity around redistributing benchmark PDFs, and still covers the failure modes those benchmarks emphasize.

Recommended fixture categories:

- tables and tables split across page breaks
- LaTeX-heavy academic PDFs
- ligature-heavy born-digital PDFs
- image-heavy scans with text inside images
- complex multi-column layouts
- handwriting or signatures
- rotated sidebars, forms, and marginalia

See `SOURCES.md` for the benchmark families used to choose these cases.
