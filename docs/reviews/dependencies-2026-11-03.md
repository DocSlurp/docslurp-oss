# Dependency upgrade, 2026-11-03

Upgrade the npm workspace to current compatible stable releases. SimpleWebAuthn moves to 14; CLI, SDK and search compatibility packages compile with TypeScript 7. Other updates include AI SDK, AWS SDK, Better Auth, Langfuse, Mastra, Pi, PDF.js, PGlite, parse5, Stripe and Vitest.

## Compatibility decisions

- Keep TypeScript 6 in the root/server: the combined Astro application requires its compiler API and splitting compiler peers creates multiple Better Auth instances. Independent CLI/SDK packages use 7.0.2. The Algolia test and evaluation integrity judge explicitly import `typescript-compiler-api` (an alias of 6.0.3).
- Keep OpenTelemetry SDK 2: current Langfuse 6.1.0 requires `@opentelemetry/core` and `sdk-trace-base` 2.x. The 3.x migration also replaces the logs API and trace provider packages.
- Keep OpenAI SDK 6.49.0: current PostHog AI 8.18.2 requires OpenAI 6.
- Keep Postgres.js 3.4.9 with its existing patch. Version 4 removes `sql.array()` (105 call sites), changes parameter inference and rewrites connection internals. That needs a separate SQL migration and patch review.
- Python requirements, container base images and package-manager major versions are outside this npm workspace update.

## Security council

Two independent agents reviewed both repository diffs against tenant, identity, secrets and untrusted-file boundaries:

- `review_dependencies`: found stale Better Auth startup guard and TypeScript compiler API incompatibility. Compared installed Better Auth 1.7.14/1.7.15 source against the upgrade contract. MFA, passkey, magic link, OTP hashing, adapter, cookies and sessions retain their assumptions. Dispatch now preserves accumulated response headers before after-hooks; OAuth credential/JWKS requests refuse redirects. No further source-level security regression found.
- `adversarial_dependencies`: confirmed the compiler API break and required real auth negative tests and malformed PDF coverage. Found no demonstrated new auth bypass or tenant exposure. Existing in-process PDF parsing remains a known isolation gap; this change does not expand that execution boundary.

Resolutions: explicit legacy compiler API alias; updated Better Auth guard/contract; real-handler auth regression run (120 passed, 1 skipped); malformed PDF regression tests (3 passed). Both reviewers confirmed the companion Astro patch server hunk is fixed upstream. Human merge approval remains required.

## Validation

Core typecheck and build passed. Shared suite: 946 passed. SDK: 126 passed, 1 skipped. Core scripts: 136 passed, including integrity judge tests. Auth candidate suite: 120 passed, 1 skipped. Malformed PDF: 3 passed. Full server/worker results are recorded in the pull request; the broad suites are not claimed green here.

Final local reconciliation: the broad worker run reported 2,732 passed, 71 skipped, three failed tests and one setup timeout. The failures used the combined app install, which does not apply core's Postgres parameter-cache patch. Installing core with `pnpm install --frozen-lockfile` and rerunning all three affected files passed 15/15 tests. The broad server run reported 3,570 passed, 83 skipped and 15 failures in two mock-based files while dependency relinking was in progress; those files passed 29/29 with the stable install. These broad runs are not clean full-suite passes. Database credit/ledger tests passed; native Postgres contention tests were skipped without the opt-in environment.
