# TODO

- Organization isolation follow-ups (council, PR #450, 2026-11-16):
  - `quarantined_sources` (source quarantine) is keyed by `source_sha256` alone: org B's identical bytes are refused on a verdict from org A's run, which tells org B another tenant's upload of those bytes broke a parser. Look it up per organization and route a hash seen elsewhere to a fresh, disposable VM with a generic failure, instead of refusing it (sandbox owners).
  - Unsalted tenant calls still left: page-router decision and verifier requests (`worker/src/routing/decision-client.ts`, page image first) and Llama Guard output moderation (`server/src/services/chat-output-moderation.ts`, question first). Salt both once routing calibration and the moderation template are checked with a salt line, and price moderation at list rate so a cache discount never shows in another org's cost.
  - Shared caches evict across organizations (query-embedding and vector-result `TtlLruCache`, global pressure in the search response cache): one org's volume can turn another's hits into misses. Give each organization its own entry and byte budget.
  - One salt helper: server `chatSystemSaltLine` and shared `orgPromptSaltLine` differ in HKDF label and short-key handling; consolidate on one with the production refusal of a short `EVIDENCE_TAG_KEY`.
  - Private endpoints now always receive a system message (the salt). Add a per-model "no system role" registry option that moves the salt into the user turn or `cache_salt` for models whose chat template rejects the system role.

- Offline profiler follow-ups (#431): independently calibrate font/CMap Unicode fidelity and table/chart candidate accuracy; native measurements remain encoded-glyph/geometric estimates. Real-corpus full-deep coverage, refusal diagnostics and compute calibration are complete; do not infer production OCR routing from candidate counts.

- Project activity counters (0165), council follow-ups 2026-11-14:
  - Bulk chat-session delete is quadratic in a surviving project: the row-level delete trigger removes each session's turns and rewrites the same counter row per session (20,000 sessions 7.5 s against 0.3 s without the trigger; account offboarding hits it). Make it statement-level with a transition table.
  - The drift sweep's cursor is per process and restarts at the first id, so with regular deploys later projects are rarely sampled; persist or randomise it, and bisect a batch whose check timed out.
  - All 1,024 writer slots held makes search and chat writes block with no statement timeout; needs over 1,024 concurrent writing transactions or a database role doing it on purpose.
  - Document `pg_restore --data-only` into a live schema in `docs/self-host/operations.md` (triggers fire during the load: rebuild afterwards).
- Figure resume budget constants: alert on `resume.capped{reason="vm-budget"}` so a low estimate never silently drops completeness, and re-check the defaults (measured 2026-11-14) against the `resume pass … msPerPage estimateMs` log lines once the runner is on.
- First pass (sandboxed PDF batches, 2026-11-11; `DOCSLURP_FIRST_PASS`, default off). Remaining before it is on by default:
  council review of the seam, the activity and the workflow wiring (one organization per batch, the publish gate, page-count
  billing); measurement on the run (`first_keyword_searchable_at`, `fully_indexed_at`, pages per minute and per $1 through
  usage attribution, realtime fields); SDK, CLI and MCP switches for `firstPass`/`afterFirstPass`; recover the text-first
  throughput the batch's table facts cost (about +130% guest CPU on a 1,037-PDF corpus: a deferred, lower-priority phase after
  each text result would keep them off the first-searchable path); figure links rewritten to export paths; and `DOCSLURP_FIRST_PASS_MATH` stays off until the math reader follow-up above is closed.
- Doppler 705d2c7 follow-ups (council, 2026-11-10; still open at 79957e1): before anyone enables `pdftomarkdown --math`, bound the cluster x prose-run `across_bar` scan in `docslurp/doppler-md/src/math/mod.rs` (a few MB of hostile page content reaches ~21 s per page inside the page caps); retain fewer bytes per glyph in non-streaming `--math`; add tests that compare late `-f` slices with an unsliced extraction and cover consecutive empty content streams; correct the "error checks remain unchanged" comment in `pdftotext.cc` (a skipped prefix page is no longer built, so its `Page::isOk` rejection no longer hides later pages).
- Doppler security advisory tracking (council A L-B, 2026-11-05): the worker images and the VM guest run the pinned Doppler fork (`worker/doppler.json`), which does not receive Debian's poppler-utils patches (host probes stay Debian's). Before each release, and at least monthly, compare Poppler upstream security fixes and the Debian `src:poppler` tracker with the fork's base, cherry-pick or rebase in DocSlurp/doppler, and move the pin. Automate as a scheduled CI check that fails when upstream Poppler has a security tag newer than the fork's base.

- Remaining host reads of customer bytes after the VM-only parser merge (#288 + #295, 2026-11-06): (1) worker format-detect decodes text-format files (`lib/text-page-count.ts`, pure TypeScript `decodeTextBytes`, no parser) to count their pages; (2) the API's intake sniffs a header (`fileFactsFor` depth `header`, magic bytes only) and decodes up to 2 MB of a text file to estimate its pages (`source-metadata.ts`); (3) `pdf-asset-cache` reads the 24-byte header of PNGs our own renderer produced. Move (1) and (2) into the parser VM (one `text-pages` entrypoint) and read raster dimensions from the VM's result instead of (3).
- VM-only parser migration acceptance: verify a packaged `parser-vm@2` image with an approved synthetic live VM test, record independent council resolution, and complete owner-approved rollout before treating existing deployments as isolated. Production startup now requires the VM provider; local namespace providers are for trusted development fixtures.



- Table-heavy unreliable reads have no per-document cap (council round 3 L4, 2026-11-11, #338; predates it): `buildEvidencePages` (`worker/src/stages/classify-route.ts`) authorizes a model read for every `table-heavy` page whose table `tableReliability` flags unreliable; only leak-only reads are capped (`tableLeakPageCap`). Billed Rich to the uploader's org, under the org and attempt guards; no cross-tenant path. Measured on the W1 corpus export (1,037 documents, 3,961 pages, routing v2, VM scans, upper bound ignoring evidence-authorized reads): 82 such pages (2.1% of pages, 9.1% of the 902 table-heavy pages) in 46 documents, at most 8 in one document. A crafted 1,000-page document of ragged tables gets 1,000 reads. Decide whether to cap them per document (like the leak cap) or bound them by the guard's page budget; routing unchanged until then.

- Chart export suggestions (2026-11-10): chat offers `chartExport` from a free lexical detector (`packages/shared/src/visual-intent.ts`) plus ingest's visual candidate counts. Escalate ambiguous turns (score just under `VISUAL_INTENT_THRESHOLD`) to the cheapest calibrated decision model, recording usage through the ledger, once the eval shows the lexical detector's misses matter.

- Realtime scope counters are never pruned (council, 2026-11-13, migration 0153): `realtime_revision_counters` keeps one folded `project:<id>` and one `run:<id>` row for every project and run that ever changed, including deleted ones. Runtime roles cannot write the table, so pruning needs a new publisher-owned `SECURITY DEFINER` function (both definer allowlists, council review). Design: called from `realtime/revision-maintenance.ts`, keyset over `(org_id, scope)`, under the per-organization fold lock (`pg_try_advisory_xact_lock(319120, hashtext(org))`), deleting only folded rows (`transaction_id = 0`) whose project or run no longer exists. Do not prune rows of finished runs that still exist: a later change (a reindex) would restart the scope at 1, and a subscriber that last saw 1 would miss it.
- Realtime row triggers still on per-page tables (council, 2026-11-13): 0153 moved `document_chunks`, `document_pages` and `page_stage_states` to statement triggers (`realtime_statement_changed()`; a 20,000-row chunk insert went from about 1.5 s to about 10 ms in the trigger). `document_page_states` (`realtime_materialization_changed()`) and `document_run_stage_states` still pay the lookup and two counter inserts per row; measure a deferred-materialization run and a many-document run, then move them the same way if the trigger shows up.
- Retire the search-session project backfill (2026-11-13, migration 0152): once every deployment has run `sweepSearchSessionProjectBackfill` to completion (it logs `nothing left`), drop the sweep and, one release after no writer omits the column, the `search_sessions_set_project_id` trigger. Until the sweep finishes on a deployment, project reads undercount sessions older than the migration.

## Summary tree build stage follow-ups (2026-11-14)

See [the stage notes](docs/document-summaries.md#summary-tree-section-summaries-for-long-documents).

- [ ] **Summary tree units in upload estimates.** The backfill estimate prices the tree's unit (one summary model call, `summaryTreeCallCredits()` of the pricing provider); the upload estimate and quote do not, so a project with the tree on is quoted without it. Add the expected units per document to `quoteUpload` / `quote` once finished builds give a calls-per-page figure.
- [ ] **Reconcile upload-stage requests with unknown provider outcomes.** Backfill now retains durable outstanding-call reservations and stops the organization until reconciliation. The ordinary upload stage still needs the equivalent durable exposure recovery. A unit is one summary call that returned. A request that fails without an answer (network, provider error) bills nothing and is bounded only by the build's retries per group and per layer; a provider that takes payment for failed requests would not be covered by a cap.
- [ ] **Content-refusal route.** Worker text calls have no fallback when the default model's host refuses output; a group refused twice leaves the document `partial`. Add a route with another host, or record the refusal as a permanent leaf-level omission.
- [ ] **Backfill jobs run one at a time.** The runner is on the maintenance leader, like graph rebuilds. Jobs now share it fairly (the organization served longest ago first, a time slice per claim, at most one running job per organization), so one project's 20,000-page document delays others by a slice, not by its whole build; throughput is still one job at a time. The lease, the per-claim owner and the per-organization limit already allow several workers: decide the fleet-wide concurrency and move the poll off the leader.
- [ ] **Backfill without a build: no automatic start.** Turning the tree on queues nothing and a run's time budget leaves documents for the job, but nothing starts a job. Decide whether enabling the tree (or a run ending with documents left) should offer one with its estimate.
- [ ] **Full-text index on the summaries table.** Maintenance builds the chunk text FTS index on every table it is handed, the summaries table included, though the tree leg only runs vector search. Skip it there.
- [ ] **Vectors-only sidecar for the scan.** The stage stream-parses the whole embed artifact (about 12 MB a second on one core). A sidecar with leaf vectors or precomputed adjacent similarities would cut that for very large documents.
- [ ] **Similarity cuts on preamble-free vectors.** Leaf vectors include the contextual preamble (page numbers), so an insertion moves cuts in heading-less documents (phase-0 reuse table). Unchanged by this stage.
- [ ] **Alert on stranded cleanup rows.** A cleanup queue row that fails `CLEANUP_ATTEMPT_LIMIT` (10) times is left in place and never retried, so a deleted document's summary rows (strict delete) or artifacts can stay behind. The sweep logs `[cleanup] status=attempt-limit-reached queue=… id=… action=manual-reconciliation-required` once at error level (`worker/src/db/superseded-purge.ts`). Wire an alert on that line (or on `attempts >= 10` in `document_cleanup_queue` / `storage_cleanup_queue`), add the count to the admin health view, and decide whether rows past the limit should retry daily instead of never.
- [ ] **Drop a project's tree without deleting its documents.** Turning the summary tree off stops serving and building but keeps every summary row and artifact until each document is deleted, superseded or archived ([data deletion](docs/data-deletion.md#the-summary-trees-table)). Add an editor-only operation that queues `summary_tree_document` removal for every document of the project (or a `vector_table` drop of its `summaries` table plus the artifact folders) and resets the tree states.
- [ ] **Trees for corrected documents.** A document with a completed correction reindex gets no tree (`skipped`, `corrected`): the build reads the run's embed artifact, which the correction does not rewrite. To build one, the correction reindex has to produce an embed artifact (or the build has to read leaves and vectors from the corrected chunks), with the tree's chunk ranges stamped against the corrected chunk set.
- [ ] **Per-call delimiter for the other worker prompts.** `buildTrustedDocumentTaskPrompt` still defaults to the fixed `<untrusted_document_content>` tag for document summary, structured extraction, propositions and graph extraction; only the summary tree uses `delimiter: "per-call"`. Move the others (each has prompt caches and evals to re-baseline).
- [ ] **Summaries-table index policy.** A ready tree requests the same background maintenance as the chunks table (compaction, vector, id and documentId indexes, full-text index). The retrieval leg should confirm which indexes it wants.

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

## Search performance follow-ups (2026-11-13 tuning loop)

- Deleted rows below LanceDB's 10% compaction threshold stay in their fragment file (hidden, not searchable): `Table.optimize` in `@lancedb/lancedb` 0.41 exposes no `materialize_deletions_threshold`. Measured locally: 1 of 100 rows deleted, text still on disk after a zero-retention optimize; 30 of 100, gone after two passes. When the binding exposes compaction options, pass threshold 0 on the erasure path (`requireLanceDbMaintenance`) and on history-prune passes (`docs/data-deletion.md`, "Known limit").
- Deletion follow-ups from the #394 council (2026-11-13): (1) nothing rebuilds community summaries deleted with a document until the project's next graph-enabled run; consider queueing a summaries-only graph job, with its cost cap, when cleanup deletes communities. (2) In-place content replacement (`server/src/services/document-review.ts` correction reindex, `worker/src/stages/materialize-pages.ts`, `worker/src/graph/legacy-keys.ts`) removes `chunk_entities` or nodes without refreshing the graph; summaries are now regenerated on the next refresh when their inputs changed, but are not deleted at once. (3) `refreshKnowledgeGraphNodes` and `refreshGraphElements` filter by node id only and cannot use the project-leading graph indexes; pass the project id. (4) A cleanup row that fails 10 times keeps its community summaries served; move the graph refresh ahead of the external deletes. (5) Check that deferred-materialized documents get a `vector_indexes` row, or the delete trigger captures no vector target for them.
- Cold first search, after the disk-cache fix (2026-11-14: `AWS_ENDPOINT_URL_S3` in the environment sent Lance past the proxy, so the cache and `[lancedb-s3]` counters saw nothing). Measure a cold search with the cache filled before doing more: `lanceIndexCold` / `lanceIndexLoad` on `[search-timing]`, `cache_hit_ratio` on `[lancedb-s3]`.
- Boot warm-up (`SEARCH_BOOT_WARM_PROJECTS`, 2026-11-14), from the #408 council: (1) API readiness now waits for bounded warm-up; warm on the separate chat executor too; (2) per-table warm-up size admission is enforced; consider stopping earlier when the shared cache nears capacity and budgeting cache per tenant; (3) native loads retain their slots across timeouts and expired queued jobs are skipped; native cancellation remains unavailable; (4) API-key keyword and hybrid sessions expire and are swept, so projects searched only that way can fall out of the ranking; (5) the candidate query groups a week of `search_sessions` with no index leading on `created_at` (bounded by a 3 s statement timeout; measure it); (6) log loaded, missing and failed tables separately; (7) measure `lanceIndexCold` after a restart to size the default of 5.
- Partitioned vector index implementation and local real-corpus recall checks are complete (see DONE.md). After reviewed deployment, perform the explicit index-only reindex per project, quiesce writers during apply, and check real search recall/cold-read telemetry. Continue validating new corpus sizes/distributions; the tested probe defaults are not a universal recall guarantee.
- Lance S3 proxy and disk cache, from the #402 council (2026-11-14): (1) active cache objects now revalidate within 30 s and idle/orphan objects expire after five minutes plus a 30 s sweep; consider immediate project-prefix erasure notifications; (2) no upstream timeout, and the buffered cache path does not abort its upstream request when the client goes away; (3) a fill buffers up to 32 MiB per request with no process-wide bound; (4) after a cache write failure the proxy fetches the same bytes twice (`meta-unavailable`) and warns only once; (5) caller authentication now uses a random session-token header and local-only credentials; no capability is present in request URLs; (6) the DynamoDB commit proxy (`lancedb-ddb.ts`, `s3+ddb://` roots with separate keys) signs any request reaching its loopback port: give it the same caller check before anyone enables that mode, and check which endpoint the DynamoDB client follows when `AWS_ENDPOINT_URL_S3` is set; (7) a per-block digest so a block altered on disk is not served; (8) limit the proxy to the operations Lance uses, and to the exact Lance root instead of its first key segment; (9) the proxy's own connection to the store ignores `HTTPS_PROXY`.
- Cold-search telemetry gaps: keyword searches load the full-text index without `lanceIndexCold`; `[lancedb-session] stats` reports `cached_mb=0.0` while the cache is in use; `index-warm` does not log index size; `[search-timing]` has no project id; the vector query runs 0.8-0.9 s after its index finished loading on a large table (cause unknown).
- Return early for a project with nothing to retrieve instead of embedding and running the legs over empty indexes.
- Size `SEARCH_MAX_CONCURRENCY` from measured pool wait now that retrieval is LanceDB-bound; size the fast lane from measured setup time (`lane`, `fastWait`, `inflight`).
- Keyword fan-out: the page leg opens one transaction per term (80 of 95 statements at 20 terms); run it once per fan-out.
- Annotate relevance once per search in `session-runner.ts` and derive the non-vector lists from it.
- Non-native path: one-statement project context read, and the cached availability read.
- Stream follow-ups from #386: open only on a non-empty `search.hits`; no `seq` gap for a stalled reader; strategy-rate charge on failure when usage is known; gate fusion in the detached-billing e2e test; lean-batch failure charge test.
- `[search-timing]`: `lanceWarm` now includes the index load when one starts; `service.version` is unset in telemetry, so latency cannot be split by deploy.
- Offline page profiles: calibrate geometric candidate accuracy on independent licensed documents, add optional local OCR/semantic analysis for image-only pages, design confidence-aware population estimates and separately budgeted damaged-xref recovery. The bounded range reader, 20,000-page/~1 GiB and 10,000-file synthetic acceptance, unruled/caption/vector candidates, rankings and strict streaming validation are implemented; see `docs/offline-page-profile-jsonl.md`.
