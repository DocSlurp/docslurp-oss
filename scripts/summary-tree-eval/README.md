# Summary-tree phase-0 evaluation harness

Evaluation tooling for the summary-tree plan's phase 0 ("Quality" and "Reuse").
It decides nothing about the product by itself and ships no product code.
Reports live in `docs/evals/summary-tree/`.

Everything here is generic: document names, questions, quotes and expected
answers live in case files and manifests, never in these scripts. The leakage
gate (`scripts/evaluation-integrity-judge.mjs`) checks that.

## What is and is not real

| Piece | Status |
| --- | --- |
| Chunking, contextual preambles, embeddings | Product code (`worker/src/lib/canonical-document.ts`, `embedding-runtime.ts`) with the default pipeline settings |
| Search arms `current-default`, `current`, `summary-seed` | Product `hybridSearch`, in process, over a seeded throwaway database and a local LanceDB directory |
| Retrieval scoring | Existing scorer: `scripts/retrieval-quality/eval.mjs` `score` |
| Answer check | Existing deterministic check: `scripts/multisearch-quality/score.mjs` `scoreCase` (`answer`) |
| Grouping, hashing, summary prompt | Either the product summary-tree library (`tree-product.mts`, loaded at run time from `worker/src/summary-tree` or `SUMMARY_TREE_EVAL_LIB`) or the **stand-in** (`grouping-standin.mts`, `tree.mts`) written before the library existed |
| `tree-guide`, `tree-include` | **Simulation** in `arms.mts`: the retrieval leg does not exist yet; the fusion rule is fixed in `TREE_RULE` |
| Production deadline for `guide` | Not modelled: needs the phase-0 latency experiment |

## Layout

- External eval root (`SUMMARY_TREE_EVAL_ROOT`, never inside a repository):
  `raw/` downloaded sources, `sources/` paged Markdown, `artifacts/` chunk
  artifacts, `tree/` frozen trees and per-node summaries, `cache/`, `lancedb/`,
  `runs/` raw arm outputs, `sealed/` the confirmation set.
- In the repository: `docs/evals/summary-tree/sources-manifest.json` (URL,
  licence, hashes), `development-authored.json` and `development-cases.json`,
  `confirmation-manifest.json` (hash and counts only), `results/`, the report.

## Run order

```
export SUMMARY_TREE_EVAL_ROOT=…   SUMMARY_TREE_EVAL_OUT=…   SUMMARY_TREE_EVAL_ENV=/path/.env
M=docs/evals/summary-tree/sources-manifest.json
tsx scripts/summary-tree-eval/prepare-sources.mts $M $SUMMARY_TREE_EVAL_ROOT        # verifies hashes
tsx scripts/summary-tree-eval/corpus.mts $M                                          # chunk + embed (paid, small)
tsx scripts/summary-tree-eval/cases.mts build AUTHORED $M OUTPUT [--sealed]          # verify every quote
DATABASE_URL=postgres://…/docslurp_<throwaway> node server/db/migrate.mjs
DATABASE_URL=… LANCEDB_URI=$SUMMARY_TREE_EVAL_ROOT/lancedb tsx scripts/summary-tree-eval/seed.mts $M
tsx scripts/summary-tree-eval/tree.mts $M                                            # frozen tree, stand-in grouping (paid)
SUMMARY_TREE_EVAL_TREE_DIR=tree-product tsx scripts/summary-tree-eval/tree-product.mts $M   # frozen tree, product library (paid)
DATABASE_URL=… LANCEDB_URI=… [SUMMARY_TREE_EVAL_TREE_DIR=tree-product] tsx scripts/summary-tree-eval/arms.mts CASES RUN_DIR   # all arms, raw outputs kept
tsx scripts/summary-tree-eval/report.mts RUN_DIR SUMMARY.json
[SUMMARY_TREE_EVAL_GROUPING=product] tsx scripts/summary-tree-eval/reuse.mts $M REUSE.json   # grouping + hashing only
tsx scripts/summary-tree-eval/integrity-export.mts DATASET AUTHOR CASES… [--confirmation]
node scripts/evaluation-integrity-judge.mjs --dataset DATASET --repo . --base origin/main
tsx --test scripts/summary-tree-eval/grouping-standin.test.mts
```

Every paid call is appended to `$SUMMARY_TREE_EVAL_OUT/ledger.jsonl` with real
token counts; the run stops before a call once `SUMMARY_TREE_EVAL_CAP_USD` is
reached. `seed.mts` refuses anything but a local `docslurp_*` database and a
local LanceDB directory. Drop the database when finished.

## Sealed confirmation set

`cases.mts build … --sealed` refuses to write inside a git work tree and
prints only a hash and counts. `arms.mts` refuses a confirmation file without
`--confirmation`. Run the confirmation set once, after the grouping library,
prompt, tree and fusion rule are frozen, and record the run in
`confirmation-manifest.json`. Never read it while tuning.

## Sources

Only public-domain or permissively licensed documents, recorded with URL and
licence in the manifest. Source bytes stay outside the repository. Text
sources are paged with the product's text page rule (`measuredTextPages`),
breaks on paragraph boundaries, so page citations can be scored.
