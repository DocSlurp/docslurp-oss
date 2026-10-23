# TODO

- MCP Apps uploader: script to apply the PUT-only bucket CORS rule (R2, Tigris, S3, MinIO) idempotently.

- MCP Apps uploader: multipart uploads for files over 5 GiB. MCP `upload` forces single-part and the server rejects larger single-part files, so such files must use the CLI or SDK today.

- MCP Apps uploader: charge `getUploadStatus` and `getJob` to the `read` rate-limit bucket. The limiter classifies by URL path (`classifyRateLimitCategory`), so every `/v1/mcp` call is in `search`; this needs the classifier to see the MCP tool name.

- MCP Apps uploader: hide widget-only tools from the model with app-only visibility, if hosts support it consistently.

- MCP Apps uploader: ChatGPT `openai/widgetCSP` metadata, and verify its sandbox domain for CORS allowlisting.

- MCP Apps uploader: explicit `createWorkspace` flag on `upload`/`completeUpload`; today a workspace name that matches none creates a workspace, which a prompt-injected model can trigger.

- MCP Apps uploader: have the widget refuse presigned `putUrl` origins outside the server's `connectDomains` (and plain http outside localhost); today the CSP is the only guard.
