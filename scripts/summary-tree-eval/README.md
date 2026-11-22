# Summary-tree phase-0 evaluation harness

The product-backed arm runner and local API harness belong to the former API distribution.
See their [pre-retirement instructions](https://github.com/DocSlurp/docslurp-oss/blob/19a28640/scripts/summary-tree-eval/README.md)
when reproducing those evaluation runs.


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
| `product-guide`, `product-include` | Real product retrieval over frozen summaries seeded into the separate Lance table, with real readiness, fusion, context cap and provisional deadline |
| Production deadline for `guide` | Product arms enforce the provisional constants; production calibration still needs the phase-0 latency experiment |

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

## Zero-cost local product replay

```sh
export TMPDIR=/path/to/configured/scratch
export TMP="$TMPDIR" TEMP="$TMPDIR"
export SUMMARY_TREE_EVAL_ROOT=/path/to/existing/external/cache
export SUMMARY_TREE_EVAL_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
pnpm exec tsx scripts/summary-tree-eval/run-local.mts \
  docs/evals/summary-tree/development-cases.json /path/to/new/external/run
```

The admin URL must be loopback-only and allow creating a disposable database.
An existing env file may instead be named by `SUMMARY_TREE_EVAL_ADMIN_ENV`; only
its `DATABASE_URL` is read, and the same loopback check applies. No existing
application tables are changed. This creates a migrated disposable local database and fresh Lance directory,
seeds cached `tree-product` summaries, and runs the three zero-build baselines
and `product-guide`/`product-include`. It permits no provider spend: cache misses
refuse, and answer generation is off. The database and fresh Lance directory are
removed on exit; raw responses, timings and the summary stay in the output directory.

The original `tree-*` arms remain labelled simulations for comparison with
historical reports. Frozen trees may predate current build constants: retain
that distinction in the report. Product `include` returns ten real chunks plus
separately capped summaries. Its strict component scores those ten chunks; its
mapped diagnostic scores the complete returned evidence, including summaries
mapped to leaves, so that component has a larger candidate budget and is not a
like-for-like top-ten retrieval score. Local timings are not S3 calibration.
