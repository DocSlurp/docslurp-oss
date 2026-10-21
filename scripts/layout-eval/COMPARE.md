# Paired source-cluster confirmation

`compare.py` never invokes a model. It compares retained raw predictions only.
Every baseline page/repeat must have exactly one matching candidate, and reference
content must be identical. Source IDs are mandatory: transformed captures and
repeated runs are not independent observations.

For three fresh confirmation blocks, pass corresponding files in the same order:

```bash
python scripts/layout-eval/compare.py \
  --baseline /results/base-1.jsonl /results/base-2.jsonl /results/base-3.jsonl \
  --baseline-variant original \
  --candidate /results/candidate-1.jsonl /results/candidate-2.jsonl /results/candidate-3.jsonl \
  --candidate-variant jpeg-960-q60 \
  --replicates 2000 --seed 417 --iou .5 \
  --output /results/paired-confirmation-iou50.json
```

Each connected cluster contains all capture variants, repeats and fresh blocks for
its related authored pages. Bootstrap samples connected clusters with replacement and keeps
all paired observations together. Box matching is precomputed, so the bootstrap
is lightweight even with many regions. Output includes baseline/candidate macro
F1 over truth-present labels, pooled micro F1, candidate-minus-baseline deltas,
percentile 95% intervals and per-family counts/deltas. Repeat separately at IoU .75.

Interpret intervals as uncertainty within the generated silver corpus. Unrecorded shared
procedural primitives can introduce correlations beyond the recorded joins. Small family source counts cannot establish robust
family-specific transfer. Development-selected configurations require fresh
confirmation; bootstrap does not remove selection bias or replace real documents.

The current implementation uses connected components over source IDs sharing
`metadata.template_family`, `metadata.document_id`, or an exact original image
SHA256. Supply `--cluster-membership /path/duplicate-aware-clusters.json` to use
full-manifest metadata-only joins, including links absent from a smaller screen.
The artifact schema is `layout-duplicate-aware-clusters-v1`, with
`source_to_cluster`, `clusters`, `join_receipts`, and manifest hash. Its SHA256 is
retained in the comparison. Without it, joins cover paired rows only and the
report explicitly records that limitation. Per-family point estimates use only
that family's rows even when duplicate joins connect different families.

**Corpus v1 results are engineering-only following user rejection of its visual
representativeness. No finalist selection or holdout confirmation is authorized
by these example commands.** Earlier source-only intervals are superseded by the
duplicate-aware dependence model. The development artifact has 64 authored source
IDs and 30 effective components. Do not treat three execution blocks as three
times the independent document evidence.
