# TODO

- Security council follow-ups (2026-10-28, live Ask AI assessment + council review; app-repo reports in `.scratch/council/`): the F1/F2/F3 fixes are merged on main (PRs #182, #190, #191) and production must be redeployed from current main to close them. Residual items below were found by the adversarial reviewer and remain open:
  - Gate `GET /v1/uploads/direct/sessions/:sessionId` by key type/scope: a browser key can currently read its own org's upload/run/cost status that the chat surface deliberately hides from public visitors. Add negative tests for client keys. Security boundary: draft PR + council.
  - webFetch allowlist admits URLs surfaced by same-turn webSearch results: an SEO-planting page can steer the agent's outbound fetch. Require the fetch target to be independent of model-chosen search results (or gate it behind an explicit allowlist/source). Security boundary: draft PR + council.
  - Observability for dropped instructions: browser-key `system`/`developer` messages are silently filtered on `/v1/chat/completions`; log a denied-instruction event (counted, no content) so operators can see attempted injection.
  - Add one end-to-end test that pins the composed browser-key chat ToolSet (catalog, toolset and execution layers are tested separately today).
  - Document an operator warning against embedding a server (`dslp_priv_`) key in a public page; publishable keys only for browsers/embeds.
  - Hygiene: DONE.md still describes the merged `feat/chat-app-only-settings` hardening as "draft"; update it and note council approval.

- Vision self-critique prompt never reaches the model (council info, 2026-10-29, #235): the critique call in `worker/src/stages/extract-markdown.ts` (`runSelfCritique`) passes a prompt that `resolveVisionPromptTemplate` (`worker/src/tools/vision-runtime.ts`) does not recognize as a template key, so the request falls back to the `<OCR>` template and the model transcribes the page instead of critiquing the candidate. Pre-existing quality issue; give critique its own template (or pass its text through) and test that the sent prompt is the critique prompt.

- Budget-cap admission race (council finding, 2026-10-28, #222): `enforceLiveBudgetCaps` (server/src/services/run-creation.ts) sums the month's spend outside the advisory-locked `admitRunSpend` transaction, so concurrent run creates and searches that materialize pages can all pass one under-cap snapshot and overshoot a monthly budget by roughly concurrency × per-run or `maxCreditsPerQuery` spend. Credits still gate the balance. Move the live sum inside the admission transaction after `pg_advisory_xact_lock`. Billing boundary: draft PR + council.

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
