# Document versions and retention

Uploading a file whose workspace, folder path and filename match an earlier upload creates a new version of the same document. Search, chat and suggestions only ever see the newest version. Older versions stay readable until retention removes them.

## Version identity

A document's version key is, in order:

1. `canonicalId`, when you supply one on upload.
2. Otherwise `path:` plus a hash of the workspace id, the normalized folder path and the filename.

Normalization applies Unicode NFC, case folding, `\` to `/`, collapsed repeated slashes, and trimmed slashes and whitespace. A `..` segment, or a path longer than 1024 characters, is rejected.

- The same filename in two folders of one workspace gives two independent chains, both live.
- The same filename in two workspaces gives two chains.
- Identical bytes still create a new version. Content-hash deduplication shares stored artifacts between the copies, but the upload is not skipped.
- Re-uploading while the previous version is still processing is safe: the newer upload becomes current when it finishes, and a late older one is superseded on arrival.

Pass the folder with `path`:

```ts
await client.upload({ files: [file], path: "contracts/2026" });
```

```bash
docslurp upload nda.pdf --workspace legal --path contracts/2026
```

HTTP, MCP and drag-and-drop folder uploads carry the same `path`.

## Retention

Retention is the number of versions kept per document, counting the current one.

| Setting | Effective value |
| --- | --- |
| Workspace override | Used when set. |
| Organization setting | Used when the workspace has no override. |
| Default | 2 (current plus one earlier version), for every organization. |

Valid overrides are 1 to 100; `null` clears an override.

```ts
await client.setRetention({ orgId }, 5);                       // organization default
await client.setRetention({ workspace: "legal" }, 10);          // workspace override
await client.setRetention({ workspace: "legal" }, null);        // inherit again
```

Both calls `PATCH` `retainDocumentVersions` on `/v1/organizations/:id` or `/v1/workspaces/:id`. Lowering the value takes effect at the next purge, which archives or purges the extra versions.

## Archived versions

A retained version that is no longer current is archived: browsable, never searchable.

- Removed: chunks, vector rows, graph evidence, staleness rows and deferred page vectors and maps.
- Kept: page text, Markdown artifacts and page images.
- A version past the retention count is purged and listed only as a tombstone that cannot be opened.

Retained page text and Markdown count toward index storage.

Only completed versions take a retention slot. A superseded failed, cancelled or blocked version is always purged, and a queued or in-flight re-index never evicts an archived version.

Retention works the same for every organization, on hosted and self-hosted deployments: there are no plans. Archived versions still hold their files, so on docslurp.io they are billed as storage (25 credits per GB-month); the billing page shows what retained versions cost.

## Upgrading existing data

A one-time migration gives every live document without a version key a chain and keeps only the newest completed version per chain current. Older rows had no folder, so same-named files count as one chain only when `previous_version_id` links them. Where old links crossed workspaces, the migration does not follow them, so it leaves more legacy duplicates live than the new upload rules would. Re-uploading a file supersedes its legacy duplicate going forward.

## Version picker

`GET /v1/documents/:id/versions` (SDK `listDocumentVersions`) returns the whole chain, newest first, as entries with `documentId`, `versionNumber`, `createdAt`, `status`, `isCurrent`, `archived`, `purged`, `pageCount`, `sourcePath`, `filename` and `sizeBytes`.

The reader modal and the inspector header show a picker ("v3 · current", "v2 · 12 Oct", "v1 · purged"). A source replaced by a configuration re-index and cancelled re-index attempts are not listed: a re-index is not a new version to a reader. Choosing a version loads that version's pages only. Reprocessing or deleting a past version asks which version to act on, defaulting to the current one; reprocessing a past version makes it the current version. Citations open the version they cite; if it was purged, the reader opens the current version with a notice.
