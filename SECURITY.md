# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do not open a public issue or pull request.

- Email: **legal@docslurp.io** (use the subject "Security report").
- Or use GitHub's private vulnerability reporting for this repository ("Security" tab, "Report a vulnerability"), once enabled.

Include the affected version or commit, reproduction steps and the impact you observed. We aim to acknowledge reports within 3 business days and will keep you updated until the issue is resolved. Please give us a reasonable chance to fix a problem before disclosing it, and do not access data that is not yours: test against your own self-hosted instance or account.

Supported versions: the latest release and `main`. The project is pre-release, so fixes are not backported.

## Security design notes

DocSlurp is a multi-tenant document ingestion and retrieval service. The core tenant boundary is the organization. Projects, runs, documents, chunks, artifacts, API keys and usage events are always scoped through organization or project membership checks.

### LanceDB vector isolation

LanceDB vector storage uses storage-layer tenant isolation. Every project has its own LanceDB database per embedding space, and its text chunk embeddings are written only there:

```text
<LANCEDB_URI>/<org_id>/<project_id>/vectors-<url-encoded model>-<dimensions>/chunks.lance
```

The location is derived by `VectorNamespaceManager` in `packages/shared/src/vector-namespace.ts`, which rejects any org or project id that is not a single safe path segment. Worker indexing (`worker/src/stages/index-vectors.ts`, through `worker/src/stages/lancedb-location.ts`), purge and cleanup, and server search (`server/src/search/lancedb.ts`) all use that shared contract.

The query path does not accept a user-supplied vector namespace, table name, or path. Search first resolves project access in Postgres, takes the authoritative `orgId` and the requested `projectId`, opens only that project's database, and then hydrates hits back through project-scoped Postgres document/chunk queries. A missing org or project id fails closed and returns no vector hits; a worker without both refuses to write.

A deduplicated document in another project than its source gets its own rows in its own project's database; vector rows are never shared across projects. Deleting a project drops its databases whole.

### Defense in depth

Project search also applies Postgres scoping during result hydration, so LanceDB hits must correspond to completed documents inside the requested project before they are returned. This is defense in depth; per-project LanceDB databases are the primary vector-store tenant boundary.

Findings and remediation status are tracked in a private registry.
