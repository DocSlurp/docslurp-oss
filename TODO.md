# TODO

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
