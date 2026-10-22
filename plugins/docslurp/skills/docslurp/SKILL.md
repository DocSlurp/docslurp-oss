---
name: docslurp
description: Use when the user wants to search, question, upload or check documents stored in DocSlurp, or asks about content in their DocSlurp workspaces (PDFs, Office files, EPUBs, images, audio, video). Covers choosing search vs chat, the presigned upload flow, and citing pages.
---

# DocSlurp

DocSlurp stores documents as page-by-page Markdown in **workspaces**. Every organization has a default workspace, and every tool uses it when `workspaceId` is omitted, so only pass `workspaceId` (a slug such as `legal-contracts`) when the user names a workspace or `listWorkspaces` shows the content lives elsewhere.

## Answer a question about documents

- Prefer `search` with `{ "q": "..." }`. It returns cited passages without generating anything; answer from them yourself. For several angles on one question, send one call with `queries` (up to 20) instead of several calls.
- Use `chat` only when the user asks for DocSlurp's own answer, or wants the workspace's configured answer style. It runs a model and spends credits. Pass the returned `sessionId` to continue the same conversation.
- If a search returns `noMatch`, say nothing relevant was found rather than guessing. Try a rephrased query, or `suggestQueries` for wording that has worked before.

Cite every claim with the document name and page number from the result metadata, for example "(Master Services Agreement, p. 4)".

## Upload files

1. Call `upload` with `files` metadata (`filename`, `sizeBytes`, `mimeType`), up to 10 per call. Never pass file bytes or local paths as tool arguments. For web documents, pass `urls` instead; those start ingesting immediately and skip steps 2 and 3.
2. PUT each file's raw bytes to its `putUrl` with the declared Content-Type, for example `curl -sS -X PUT -H "Content-Type: application/pdf" --data-binary @report.pdf "$PUT_URL"`. Presigned URLs are short-lived credentials: don't print, log or reuse them.
3. Call `completeUpload` with the `sessionId` and `fileIds`. Ingestion starts only after this call.
4. Call `getUploadStatus` with the returned `runId` until pages are searchable, then search.

Uploads go to the default workspace unless the user names one. Send `workspaceName` only when the user asks for a new workspace. Ingestion spends credits; for large batches, call `uploadEstimate` first and tell the user the estimate.

## Inspect a workspace

`listWorkspaces` shows each workspace's slug, document and page counts and processing status. `getUploadStatus` explains how files processed: searchable pages, failures, vision use, cost and speed. Report those numbers when the user asks why something isn't findable.
