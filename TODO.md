# TODO

- Figure resume budget constants (council #388 M3, 2026-11-13): before `DOCSLURP_FIGURE_RESUME` is on in production, measure the per-pass VM time the budget assumes (`DOCSLURP_FIGURE_RESUME_VM_MS_PER_PAGE` 50 and `_VM_MS_PER_LAUNCH` 3,000 are estimates). Run the runner on a held-back slice of partial documents (small, 1,000-page unsharded, 10K+ sharded), read the `resume pass … msPerPage estimateMs` log lines and `resume.pass_ms_per_page`, and set the defaults from the measured p95. Alert on `resume.capped{reason="vm-budget"}` so a low estimate never silently drops completeness.
- First pass (sandboxed PDF batches, 2026-11-11; `DOCSLURP_FIRST_PASS`, default off). Remaining before it is on by default:
  council review of the seam, the activity and the workflow wiring (one organization per batch, the publish gate, page-count
  billing); measurement on the run (`first_keyword_searchable_at`, `fully_indexed_at`, pages per minute and per $1 through
  usage attribution, realtime fields); SDK, CLI and MCP switches for `firstPass`/`afterFirstPass`; recover the text-first
  throughput the batch's table facts cost (about +130% guest CPU on a 1,037-PDF corpus: a deferred, lower-priority phase after
  each text result would keep them off the first-searchable path); figure links rewritten to export paths; and `DOCSLURP_FIRST_PASS_MATH` stays off until the math reader follow-up above is closed.
- Doppler 705d2c7 follow-ups (council, 2026-11-10; still open at 79957e1): before anyone enables `pdftomarkdown --math`, bound the cluster x prose-run `across_bar` scan in `docslurp/doppler-md/src/math/mod.rs` (a few MB of hostile page content reaches ~21 s per page inside the page caps); retain fewer bytes per glyph in non-streaming `--math`; add tests that compare late `-f` slices with an unsliced extraction and cover consecutive empty content streams; correct the "error checks remain unchanged" comment in `pdftotext.cc` (a skipped prefix page is no longer built, so its `Page::isOk` rejection no longer hides later pages).
- Doppler security advisory tracking (council A L-B, 2026-11-05): the worker images and the VM guest run the pinned Doppler fork (`worker/doppler.json`), which does not receive Debian's poppler-utils patches (host probes stay Debian's). Before each release, and at least monthly, compare Poppler upstream security fixes and the Debian `src:poppler` tracker with the fork's base, cherry-pick or rebase in DocSlurp/doppler, and move the pin. Automate as a scheduled CI check that fails when upstream Poppler has a security tag newer than the fork's base.

- Remaining host reads of customer bytes after the VM-only parser merge (#288 + #295, 2026-11-06): (1) worker format-detect decodes text-format files (`lib/text-page-count.ts`, pure TypeScript `decodeTextBytes`, no parser) to count their pages; (2) the API's intake sniffs a header (`fileFactsFor` depth `header`, magic bytes only) and decodes up to 2 MB of a text file to estimate its pages (`source-metadata.ts`); (3) `pdf-asset-cache` reads the 24-byte header of PNGs our own renderer produced. Move (1) and (2) into the parser VM (one `text-pages` entrypoint) and read raster dimensions from the VM's result instead of (3).
- Reuse base VM OCR on retry (real-Modal validation N8, 2026-11-06): when the activity retries after a failure that follows the VM OCR (for example a storage reset on the Markdown write, F7), the base OCR runs again. The customer is charged once (page charges keep their ids), but provider cost doubles. Escalation reads are already reused (`ocr_escalation_reads`, 0129). Persist the base OCR page text per document, source hash and settings (object storage, not a table row per page), reuse it on retry, and drop it when the document completes.
- VM-only parser migration acceptance: verify a packaged `parser-vm@2` image with an approved synthetic live VM test, record independent council resolution, and complete owner-approved rollout before treating existing deployments as isolated. Production startup now requires the VM provider; local namespace providers are for trusted development fixtures.

- Vision self-critique prompt never reaches the model (council info, 2026-10-29, #235): the critique call in `worker/src/stages/extract-markdown.ts` (`runSelfCritique`) passes a prompt that `resolveVisionPromptTemplate` (`worker/src/tools/vision-runtime.ts`) does not recognize as a template key, so the request falls back to the `<OCR>` template and the model transcribes the page instead of critiquing the candidate. Pre-existing quality issue; give critique its own template (or pass its text through) and test that the sent prompt is the critique prompt.

- Budget-cap admission race (council finding, 2026-10-28, #222): `enforceLiveBudgetCaps` (server/src/services/run-creation.ts) sums the month's spend outside the advisory-locked `admitRunSpend` transaction, so concurrent run creates and searches that materialize pages can all pass one under-cap snapshot and overshoot a monthly budget by roughly concurrency × per-run or `maxCreditsPerQuery` spend. Credits still gate the balance. Move the live sum inside the admission transaction after `pg_advisory_xact_lock`. Billing boundary: draft PR + council.

- Table-heavy unreliable reads have no per-document cap (council round 3 L4, 2026-11-11, #338; predates it): `buildEvidencePages` (`worker/src/stages/classify-route.ts`) authorizes a model read for every `table-heavy` page whose table `tableReliability` flags unreliable; only leak-only reads are capped (`tableLeakPageCap`). Billed Rich to the uploader's org, under the org and attempt guards; no cross-tenant path. Measured on the W1 corpus export (1,037 documents, 3,961 pages, routing v2, VM scans, upper bound ignoring evidence-authorized reads): 82 such pages (2.1% of pages, 9.1% of the 902 table-heavy pages) in 46 documents, at most 8 in one document. A crafted 1,000-page document of ragged tables gets 1,000 reads. Decide whether to cap them per document (like the leak cap) or bound them by the guard's page budget; routing unchanged until then.

- Chart export suggestions (2026-11-10): chat offers `chartExport` from a free lexical detector (`packages/shared/src/visual-intent.ts`) plus ingest's visual candidate counts. Escalate ambiguous turns (score just under `VISUAL_INTENT_THRESHOLD`) to the cheapest calibrated decision model, recording usage through the ledger, once the eval shows the lexical detector's misses matter.

- Realtime scope counters are never pruned (council, 2026-11-13, migration 0153): `realtime_revision_counters` keeps one folded `project:<id>` and one `run:<id>` row for every project and run that ever changed, including deleted ones. Runtime roles cannot write the table, so pruning needs a new publisher-owned `SECURITY DEFINER` function (both definer allowlists, council review). Design: called from `realtime/revision-maintenance.ts`, keyset over `(org_id, scope)`, under the per-organization fold lock (`pg_try_advisory_xact_lock(319120, hashtext(org))`), deleting only folded rows (`transaction_id = 0`) whose project or run no longer exists. Do not prune rows of finished runs that still exist: a later change (a reindex) would restart the scope at 1, and a subscriber that last saw 1 would miss it.
- Realtime row triggers still on per-page tables (council, 2026-11-13): 0153 moved `document_chunks`, `document_pages` and `page_stage_states` to statement triggers (`realtime_statement_changed()`; a 20,000-row chunk insert went from about 1.5 s to about 10 ms in the trigger). `document_page_states` (`realtime_materialization_changed()`) and `document_run_stage_states` still pay the lookup and two counter inserts per row; measure a deferred-materialization run and a many-document run, then move them the same way if the trigger shows up.
- Retire the search-session project backfill (2026-11-13, migration 0152): once every deployment has run `sweepSearchSessionProjectBackfill` to completion (it logs `nothing left`), drop the sweep and, one release after no writer omits the column, the `search_sessions_set_project_id` trigger. Until the sweep finishes on a deployment, project reads undercount sessions older than the migration.

## Quarantine scanner snapshots (2026-11-11, `perf/quarantine-latency`, flags off)

- [ ] Enable `DOCSLURP_QUARANTINE_SCAN_SNAPSHOT` on production (council reviewed in PR #339; batch flag removed) and
  measure `quality=fast` and `quality=auto` 1-page uploads before/after
  (performance/quarantine-latency-2026-11-11/results.md).
- [ ] Optional hardening (council M1): run the intake inspection in a plain parser session, so a parser-tool exploit never
  shares a VM with clamd. One document per session already bounds it to the document that ran the exploit.
- [ ] Build the scanner snapshot in the background when freshclam updates the signatures (today the first scan after an
  update waits about 34 s for the build), and share one snapshot across workers instead of one build per worker process.
- [ ] Residual after the nested-archive walk (PR #339, council round 4, 2026-11-11): a ZIP or RAR is now found behind up
  to 4 KiB of leading bytes, or by a ZIP end record in a member's last 64 KiB. One deeper inside a member, with no end
  record near its end, is still not walked, while libclamav's embedded-file scan may open it and skip a ZIP64 member
  there. Nested 7z, tar, CAB, bzip2, xz and the other formats ClamAV opens are accepted with an
  `archive-nested-uninspectable` warning (a ZIP64 or RAR inside them is ClamAV's alone to judge); walking tar and the
  others in the VM would close that. A PDF embedded in a DOCX/EPUB member with an empty user password is scanned by
  libclamav alone (no qpdf copy). Extractors never open nested members; they are only served back with the original.
- [ ] Q3 (concurrent quarantine and extraction): split quarantine into the intake inspection (stays first: format-detect
  reads its verified file facts) and the malware scan, and gate every served artifact on a clean verdict before running
  the scan beside extraction. Coordinate with the first-pass plan's quarantine precondition.

## ClamAV definitions in parser VMs (2026-11-06)

- [ ] Each parser VM spends 11–12 s staging the ClamAV definitions, and staging is serialized per worker (council W #7), so VM
  starts queue behind it (real-Modal W run). Evaluate a parser image with the definitions baked in (rebuilt and re-pinned on
  each signature update) or a Modal Volume holding them, either with the same freshness check the VM runs today (signature
  date within `maxSignatureAgeHours`, failing closed). Measure VM start time and memory against today's per-VM staging
  before choosing.

## Error recovery audit (2026-10-28)

- [ ] [#218](https://github.com/DocSlurp/docslurp-oss/issues/218) Error recovery: Give document failures actionable, structured reasons — Deferred by council: add trusted producer codes, a persisted stage/retryability contract, migration and DTO redaction together. Do not infer public retry policy from diagnostic strings. The app now distinguishes unavailable diagnostics from absent diagnostics.

- SAML replay (council finding, 2026-10-28): `createSamlRequestCacheProvider` (server/src/routes/sso.ts ~517-560) accepts any unexpired `sso_auth_requests` row without checking `consumed_at`, and `removeAsync` is a no-op, so a captured signed SAMLResponse can be replayed through a fresh RelayState until the row expires. Implement `consumeAsync`/`saveIfAbsentAsync`, set node-saml 5.2's `rejectReplayedAssertions: true`, and bind InResponseTo to the consumed RelayState. Security boundary: draft PR + council.

- SAML issuer check: `idpIssuer: samlMetadata.issuer ?? undefined` (sso.ts:968) disables the issuer check when IdP metadata has no `entityID`; reject such metadata instead. Add a signed SAMLResponse round-trip test with wrong-issuer, multiple-Issuer and unsigned negatives.

- MCP Apps uploader: script to apply the PUT-only bucket CORS rule (R2, Tigris, S3, MinIO) idempotently.

- MCP Apps uploader: multipart uploads for files over 5 GiB. MCP `upload` forces single-part and the server rejects larger single-part files, so such files must use the CLI or SDK today.

- MCP Apps uploader: charge `getUploadStatus` and `getJob` to the `read` rate-limit bucket. The limiter classifies by URL path (`classifyRateLimitCategory`), so every `/v1/mcp` call is in `search`; this needs the classifier to see the MCP tool name.

- MCP Apps uploader: hide widget-only tools from the model with app-only visibility, if hosts support it consistently.

- MCP Apps uploader: ChatGPT `openai/widgetCSP` metadata, and verify its sandbox domain for CORS allowlisting.

- MCP Apps uploader: explicit `createWorkspace` flag on `upload`/`completeUpload`; today a workspace name that matches none creates a workspace, which a prompt-injected model can trigger.

- MCP Apps uploader: have the widget refuse presigned `putUrl` origins outside the server's `connectDomains` (and plain http outside localhost); today the CSP is the only guard.

## Table coverage gaps (2026-11-01)

- [ ] Validate full OCR/vision → canonical storage → retrieval → renderer coverage for scans and rotated pages; native-only comparison currently fails.
- [ ] Evaluate general borderless-table and orientation recovery on independent held-out documents, preserving ambiguous source text.
- [ ] Expand the table parity corpus to degraded scans, diverse financial layouts and cross-page continuation before broad parity claims. See docs/evals/table-preservation-2026-11-01.md.

- Issue 319 durable chat follow-up: integrate the authorized operation provider with the realtime host and first-party client; supervise/drain the dedicated executor; add explicit subagent/retry/dependency launch APIs and link existing Temporal job results; finish council review and matched recovery/load acceptance before enabling the flag. See docs/durable-chat-operations.md.

## Env and flag cleanup (2026-11-13)

- [ ] Fail-open escape hatches (security-sensitive, council review): `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED`, `DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS`, `QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING`, `DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB` (`scripts/start-worker.sh` turns it on by default outside production) and `WORKER_ALLOW_SLOT_MISMATCH`. For each, either refuse it at startup when `NODE_ENV=production` (with a negative test) or delete it, and record who still needs it (tests, local development).
- [ ] Rename names that hide their meaning, updating `.env.example`, docs and any deploy config that sets them: `CHAT_INGEST_REPORT_NATURAL` (chat may answer "how did my files process?" with the ingest report), `MEDIA_CAPACITY_HOST_CLASS_APPROVED`, `DOCSLURP_DEFERRED_PROFILES`, `VISION_ORG_UNCHARGED_LIMIT_CENTS` and `SKIP_RUN_BUDGET_GUARDS_IN_DEV`. Pick names that say what the switch does.
- [ ] Rename the `TEST_PRIVATE_GPU1_TOKEN`/`TEST_WORKER_GPU1_TOKEN` fixtures in `packages/shared/src/__tests__/private-endpoints.test.ts` so the names don't embed a machine number.
- [ ] Drop the `PERPLEXITYAI_API_KEY` alias once production sets `PERPLEXITY_API_KEY` (app `TODO.md`, "Env and flag cleanup").
