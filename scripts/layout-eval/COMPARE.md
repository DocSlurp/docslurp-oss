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

Each source cluster contains all capture variants, repeats and fresh blocks for
that authored page. Bootstrap samples source clusters with replacement and keeps
all paired observations together. Box matching is precomputed, so the bootstrap
is lightweight even with many regions. Output includes baseline/candidate macro
F1 over truth-present labels, pooled micro F1, candidate-minus-baseline deltas,
percentile 95% intervals and per-family counts/deltas. Repeat separately at IoU .75.

Interpret intervals as uncertainty within the generated silver corpus. Shared
procedural primitives and continuation-page document relationships remain possible
correlations beyond source_id. Small family source counts cannot establish robust
family-specific transfer. Development-selected configurations require fresh
confirmation; bootstrap does not remove selection bias or replace real documents.
