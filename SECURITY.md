# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do not open a public issue or pull request.

- Email: **legal@docslurp.io** (use the subject "Security report").
- Or use GitHub's private vulnerability reporting for this repository ("Security" tab, "Report a vulnerability"), once enabled.

Include the affected version or commit, reproduction steps and the impact you observed. We aim to acknowledge reports within 3 business days and will keep you updated until the issue is resolved. Please give us a reasonable chance to fix a problem before disclosing it, and do not access data that is not yours: test against your own self-hosted instance or account.

Supported versions: the latest release and `main`. The project is pre-release, so fixes are not backported.

## Security design notes

DocSlurp is a multi-tenant document ingestion and retrieval service. The core tenant boundary is the organization. Workspaces, runs, documents, chunks, artifacts, API keys and usage events are always scoped through organization or workspace membership checks.

### LanceDB vector isolation

LanceDB vector storage uses storage-layer tenant isolation. Each organization's text chunk embeddings are written to exactly one live LanceDB table:

```text
chunks_org_<sha256(org_id)[0:32]>
```

The raw organization id is never embedded in the table name. The table name is derived by `VectorNamespaceManager` in `packages/shared/src/vector-namespace.ts`, and both worker indexing (`worker/src/stages/index-vectors.ts`) and server search (`server/src/search/lancedb.ts`) use that shared contract.

The query path does not accept a user-supplied vector namespace, table name, or table prefix. Search first resolves workspace access in Postgres, extracts the authoritative `orgId`, opens only that exact LanceDB table, and then hydrates hits back through workspace-scoped Postgres document/chunk queries. A missing org id fails closed and returns no vector hits.

Archives and malformed lookalike tables, such as `chunks_org_<hash>_archived_<timestamp>` or `chunks_org_<hash>_malformed`, are not live search tables.

### Defense in depth

Workspace search also applies Postgres scoping during result hydration, so LanceDB hits must correspond to completed documents inside the requested workspace before they are returned. This is defense in depth; LanceDB table isolation is the primary vector-store tenant boundary.

Findings and remediation status are tracked in a private registry.
