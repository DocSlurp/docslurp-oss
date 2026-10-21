# Clean-acquisition view for CPU precheck analysis

`common-clean-v1` selects **23 existing native pages: 16 development and seven holdout, across 20 original source clusters**. It is a metadata-only view of the frozen32 corpus. It adds no new independent evidence and does not establish that 99% of traffic is clean; that remains an unmeasured user hypothesis.

External artifacts live at `/home/dan/data/docslurp-evals/layout-synthetic-v2/common-clean-v1/`: `candidates.jsonl`, `dev.jsonl`, `holdout.jsonl` and `RECEIPT.json`. The receipt pins the original frozen manifest, condition index, sidecars and source/image/reference artifacts. Records, splits and source groups remain unchanged. It excludes the eight capture/quality/crop derivatives and the manual historical silver. Creating a holdout manifest does not run models on it.

Selection requires positive **page-scoped** `digital`, `born-digital` and `aligned` assertions on a native page, with current hash-bound construction evidence and no declared acquisition degradation. Ancestor conditions or flat tag unions cannot substitute for current page evidence. Tag absence is not treated as proof of perfection. All selected pages are synthetic native renders; this slice adds zero independently acquired perfect-scanner originals.

Acquisition and layout difficulty are separate axes. Clean originals include invoices, menus, timetables, academic formulas, dense classifieds, diagrams, bilingual forms and mind maps. They remain in the slice: upright sharp source rendering does not imply simple reading order, easy semantic classification or reliable tiny-model predictions. Keep content-class distributions and source groups visible when comparing a CPU precheck or fallback route. Historical QA found no additional native acquisition exclusions justified by current evidence.

Rebuild without raster or annotation changes:

```sh
python scripts/layout-eval/corpus_v2/build_common_clean_slice.py \
  /home/dan/data/docslurp-evals/layout-synthetic-v2
python -m unittest discover -s scripts/layout-eval/corpus_v2 -p test_common_clean_slice.py
```

The four focused tests cover unchanged records/splits and dense content, scoped versus ancestor/flat evidence, exclusion of explicitly blurred pages, and rejection of source-group leakage. The builder performs no prediction, model selection, production routing change or held-out evaluation. Test a tiny CPU route on development first; the existing holdout remains governed by the frozen experiment protocol. Reusing this view does not turn it into a new validation set.

After the frozen experiment, genuinely new common-case coverage should prioritize independently authored or rights-cleared sources rather than reskins of existing pages:

- Ordinary one- and two-column letters, reports and word-processor exports, with headers/footers and sparse inline pictures.
- Everyday invoices, purchase orders, receipts, schedules and simple menus, covering both whitespace-aligned and ruled tables, wrapped descriptions and empty cells.
- Routine academic pages with restrained inline/display math, references, a small figure or table, and varied real typography.
- Plain forms and multilingual everyday text with familiar paragraph/table structure, including script and glyph coverage checked before rendering.
- Actual clean flatbed/scanner acquisitions of separately sourced or printed originals, retaining acquisition settings, image hashes, source transcripts and region/cell geometry; do not relabel a digital crop as a real scan.
- A small measured acquisition ladder for each selected source: native export and clean real scan first, then clearly labeled controlled degradations. Keep every encoding and capture of that source in one split.

These are coverage recommendations, not generated files or a proposed traffic mixture. Acquire actual service telemetry before assigning representative frequencies or choosing a production fast-path acceptance threshold. Report false accepts and fallback costs separately from throughput; clean acquisition alone cannot justify automatic acceptance.
