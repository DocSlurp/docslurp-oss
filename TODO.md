# TODO

## MCP Apps upload widget follow-ups

- [ ] `STORAGE_PUBLIC_ENDPOINT`: sign upload URLs against a browser-reachable endpoint so self-hosted MinIO (`http://minio:9000`) works with the uploader.
- [ ] Script to apply the PUT-only bucket CORS rule (R2, Tigris, S3, MinIO) idempotently.
- [ ] Multipart uploads in the widget (files larger than a single PUT are shown as unsupported).
- [ ] Charge `getUploadStatus` and `getJob` to the `read` rate-limit bucket instead of `search`.
- [ ] Hide widget-only tools from the model with app-only visibility, if hosts support it consistently.
- [ ] ChatGPT: `openai/widgetCSP` metadata, and verify its sandbox domain for CORS allowlisting.
- [ ] Explicit `createWorkspace` flag on `upload`/`completeUpload`; today a workspace name that matches none creates a workspace, which a prompt-injected model can trigger.
