# Large-PDF benchmark harness (generic tooling)

`bench.mjs` and `ready-guard.mjs` are the benchmark tooling referenced by `../plan.md`. They contain no document names, queries, expected values or credentials; the corpus owner supplies `manifest.json`, `queries.json` and the source PDFs, and credentials come from a file passed with `--credentials` or `BENCH_CREDENTIALS`. The default paths below `/tmp/docslurp-large-docs` can be moved with `BENCH_ROOT`, `BENCH_CORE_DIR` and `BENCH_BASE_URL`.

```
node bench.mjs check|login|preflight|prepare|upload|watch|probe|quality|compare|report --label <run> [--go] ...
node ready-guard.mjs <label>     # cancels the run after 2 consecutive /ready failures
```

Network commands refuse without `--go`. `preflight --file <id> --budget-cents N` writes a fee-reserved cost forecast and `upload` refuses without a passing one; the forecast sets the server run cap to the budget minus the per-page base fee. The offline mock-server tests and the sampler script stay with the corpus owner because they read real fixtures and production hosts.
