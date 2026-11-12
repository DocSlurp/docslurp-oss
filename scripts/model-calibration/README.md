# Model calibration harness

Benchmarks a candidate OpenRouter model against the production model of every LLM feature, using the
production prompt builders and parsers. The current program is MiniMax M3.1 Flash; its decision record is
`docs/evals/minimax-m31-flash/plan.md`.

- `shim.mts` wraps `globalThis.fetch`. Server helpers that hard-code their model (search helpers) are
  re-pointed per arm; every arm can override `reasoning`, `provider` routing and add output-token headroom.
  Each generation call is captured per case (latency, finish reason, reasoning/output tokens, cost, raw text)
  for both the Chat Completions and the Responses API (the AI SDK's OpenAI provider uses the latter).
- `features.mts` has one adapter per feature. Where a prompt builder is private, the prompt is copied
  verbatim from the pinned source and marked as such; re-check those copies when the source changes.
- `corpus/` is a synthetic business corpus: `facts.json` is authored, and each document was written once
  from its fact sheet (`gen-corpus.mjs`). Gold answers come from the fact sheets, never from model output.
- `cases.json` holds the authored cases. `corpus.mts` `split()` holds out about a third of every feature's
  cases by hash; choose settings on `--split dev` only and confirm on `--split heldout`.
- Vision pages are rendered from the tracked synthetic fixtures in `worker/testdata/pdf-fixtures/` and
  scored against their `doppler-md/` reference Markdown (silver: a text-layer extraction, not authored gold).
  Render the fixtures that have a reference of 40 or more words into `.cache/model-calibration/vision-pages/`
  (or `VISION_PAGES_DIR`) with `pdftoppm -r 150 -l 3 -png <fixture>.pdf <dir>/<fixture>`.

```sh
# Paid: each command has a hard budget stop. Use a minimal environment so no traces leave the machine.
env -i PATH="$PATH" HOME="$HOME" OPENROUTER_API_KEY=... TMPDIR=... \
  node_modules/.bin/tsx scripts/model-calibration/run.mts --run dev1 --features all \
  --arms incumbent,mm-minimal,mm-minimal-r512 --split dev --budget-usd 2
node scripts/model-calibration/judge.mjs --run dev1 --candidate mm-minimal-r512 --budget-usd 1 --swap-check 20
node scripts/model-calibration/report.mjs --run dev1
```

Outside a job scope the worker fails closed to non-China providers; `run.mts` sets the default organization
policy (China-based hosts allowed) unless `CHINA_PROVIDERS=0`. Raw run output stays in the ignored `runs/`.
