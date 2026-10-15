# Automatic Schema Discovery and Adaptive Assignment

> **Status: superseded.** The critical review found that this registry-first design conflates observed source structure with user intent and assumes richer canonical table/form evidence than the current implementation provides. The accepted direction is the evidence-first, schema-free design in Universal Structure Discovery PRD, with implementation tickets in Universal Structure Discovery Issues. This document remains as design history and should not guide implementation.

## Summary

DocSlurp should help a workspace learn the structured outputs its documents need without silently changing production behavior. The feature detects recurring document shapes, proposes schemas or schema improvements, lets a user edit and test them, and assigns approved immutable schema revisions to future documents.

The product term is **Workspace**, not project. Workspace ownership is the default because workspaces are DocSlurp's configuration boundary. Organizations may publish schemas into a reusable library, but schema inference and automatic matching must not cross workspace boundaries unless a user deliberately opts into an organization-owned schema.

The central safety rule is:

> Detection may create proposals. Only a user may publish a new production schema revision.

Automatic behavior may select among already-approved revisions. It must not silently add fields, change types, or promote a proposal.

## Why this is a separate feature

The current product already has several useful pieces:

- `pipeline.outputSchema` stores one inline JSON Schema-like object on a workspace.
- `structured-extract` produces a structured artifact with confidence, evidence, validation, and review policy.
- `classify-route` identifies broad document classes such as invoices, contracts, reports, and forms.
- canonical blocks and table metadata preserve page, region, row, and cell provenance.
- the correction workbench captures corrected structured JSON and recurring correction signals.

What is missing is a managed lifecycle around those pieces: named schemas, immutable revisions, discovery, document-to-schema assignment, drift proposals, preview/evaluation, and deliberate promotion.

## Product principles

1. **Workspace-first ownership.** A workspace may have several schemas because a corpus can contain invoices, statements, forms, and reports together.
2. **Contract and source layout are different.** The schema defines the desired output. Table geometry, form labels, aliases, and layout fingerprints are extraction hints attached to a revision, not the output contract itself.
3. **Suggest before changing.** Novel structure creates a proposal. Approved schemas may be matched automatically according to workspace policy.
4. **Pin every result.** Every structured result records the exact schema revision and assignment decision used to produce it.
5. **Preserve evidence.** Fields, rows, and cells retain page/block/region provenance so users can inspect why a value or inferred column exists.
6. **Fail open to normal ingestion.** Schema detection or matching failure must not block markdown extraction, indexing, or search. Structured extraction may be skipped and surfaced as unassigned.
7. **Spend deliberately.** Use deterministic structural evidence first. Use an LLM only when semantics, labels, or ambiguous types need it, and log/persist actual usage under the existing AI usage contract.

## User-facing modes

Each workspace has one schema automation mode:

| Mode | Discovery | Assignment | Production changes |
| --- | --- | --- | --- |
| `off` | No discovery work or discovery model calls | Only an explicit run/document schema | None |
| `suggest` | Create and refresh proposals | Suggest an approved revision; user confirms | None without user action |
| `automatic` | Create and refresh proposals | Automatically select among approved revisions above the configured confidence threshold | Never auto-publish a proposal |

`off` is the platform default because the feature is optional. The settings UI should recommend `suggest` when a user enables it. `automatic` is appropriate only after the workspace has approved schemas and reviewed matching behavior.

## Core domain model

### Extraction Schema

A stable named identity such as `AP Invoice`, `Lab Intake Form`, or `Monthly Holdings Rows`. It has an owner scope:

- `workspace`: available only in one workspace.
- `organization`: reusable by workspaces in the same organization after an explicit binding.

Organization schemas are a library, not inheritance. Publishing an organization revision must not automatically change bound workspaces.

### Schema Revision

An immutable snapshot containing:

- a JSON Schema output contract;
- output shape: `record`, `records`, or `composite`;
- source hints: `freeform`, `table`, `form`, or `mixed`;
- field aliases, header aliases, normalizers, validators, and review thresholds;
- table continuation hints such as expected column count and repeated-header behavior;
- optional layout fingerprints and form-label anchors;
- supporting instructions and model configuration;
- provenance: manual, accepted proposal, imported, or starter pack;
- evaluation summary and creation audit data.

A revision moves through `draft -> active -> retired`. Activating one revision does not mutate or delete earlier revisions.

### Schema Proposal

A proposed new schema or a proposed revision to an existing schema. It includes:

- proposal kind: `new-schema`, `add-field`, `remove-field`, `change-type`, `change-required`, `add-alias`, `repeating-group`, or `table-continuation`;
- proposed contract and extraction-hint diff;
- support count and percentage;
- representative document/page references, never merely model rationale;
- confidence and reasons;
- estimated impact on recent documents;
- status: `open`, `accepted`, `rejected`, or `superseded`.

Rejecting a proposal should suppress the same suggestion until materially new evidence appears.

### Schema Assignment

A document pins one exact schema revision. Assignment precedence is:

1. manual document override;
2. explicit schema in the run/API request;
3. workspace automatic match among approved bindings;
4. workspace default revision;
5. no structured extraction.

The assignment records match confidence, reasons, candidate scores, decision source, and who overrode it. Reprocessing against a different revision creates a new result; it does not rewrite the historical assignment.

For v1, one composite revision should cover one document. Page-range or packet-subdocument assignments can follow later; table continuation across pages is handled inside the document's schema.

## Discovery pipeline

Add a `schema-detect` stage after vision/canonical reconciliation and before `structured-extract`. It should be enabled only when schema automation is not `off` or when a run explicitly requests discovery.

### 1. Collect structural observations

Use existing artifacts before calling a model:

- canonical block types, page numbers, coordinates, and reading order;
- table rows, column counts, cell types, and x-coordinate bands;
- PDF form field names and values when available;
- OCR/form label-value pairs;
- classification label and per-page route;
- corrected structured data and field aliases from the correction workbench;
- active schema match features.

Persist structural summaries and hashes, not a second uncontrolled copy of raw document contents.

### 2. Detect a document shape

Infer the output and source shape independently:

- a one-record invoice is `record` output sourced from `form` or `mixed` content;
- a multi-page ledger is `records` output sourced from `table` content;
- a report with metadata plus several row groups is `composite` output sourced from `mixed` content.

Candidate fields and types should start from deterministic evidence. An LLM may propose semantic names and descriptions for anonymous labels such as `Column 3`, but the proposal must retain the original header/label as an alias and expose that uncertainty.

### 3. Match or cluster

First compare the observation with approved workspace bindings. Matching signals may include:

- normalized label/header overlap;
- field presence and inferred types;
- table column count and geometry;
- document classification;
- layout fingerprint for repeated form templates;
- validation success on a dry-run sample.

If no approved revision clears the threshold, add the document observation to a workspace-local candidate cluster. Create a proposal only after enough consistent evidence exists. A single document may produce a user-requested proposal, but it should be labeled low-support.

Recommended initial thresholds:

- automatic assignment: confidence at least `0.90`;
- suggestion: confidence at least `0.70`;
- automatic proposal creation: at least 3 similar documents and 80% field/header agreement.

These are product defaults and should be measurable/configurable rather than hard-coded into prompts.

### 4. Extract and validate

`structured-extract` consumes the pinned assignment instead of reading an unversioned `pipeline.outputSchema`. The result envelope adds:

- `schemaId` and `schemaRevisionId`;
- assignment source and confidence;
- field/row/cell evidence;
- validation summary;
- proposal/drift signals discovered during extraction.

### 5. Observe drift

After extraction, aggregate schema-level observations such as field coverage, type mismatches, validation errors, manual corrections, and new aliases. These observations create improvement proposals; they never edit an active revision.

## Continued tables without header rows

This is a first-class use case, not a generic LLM prompt detail.

For adjacent table pages, build a table-family fingerprint from column count, normalized x-coordinate bands, inferred cell types, row density, and nearby captions. A later page may inherit headers from the nearest compatible prior table when:

- pages are contiguous or within a small configured gap;
- column geometry and count are compatible;
- cell types remain compatible;
- there is no stronger conflicting header;
- a confidence threshold is met.

The output should be one logical `rows` array with each row retaining its source page and cell evidence. Repeated headers are removed only when they match the active header aliases. Ambiguous continuations stay separate and enter review rather than being force-merged.

Important review diagnostics:

- pages joined or rejected;
- inherited header source page;
- per-column match score;
- rows dropped as repeated headers;
- low-confidence or shifted columns.

## Forms

Support three form sources through the same output contract:

1. native PDF form fields;
2. scanned key/value forms recovered from OCR and layout;
3. semi-structured forms whose labels move but remain semantically stable.

Native field names, visible labels, and user-friendly schema keys should remain distinct aliases. Layout anchors can improve matching, but the schema must continue to work when the same form is rescanned, translated, or slightly repositioned.

## Schema improvement suggestions

Suggestions should be concrete diffs with evidence and predicted impact. Useful initial rules include:

- a field appears in at least 80% of matched documents but is absent from the schema;
- a required field is missing in a sustained share of otherwise valid documents;
- a value consistently violates its declared type but matches a safer widened type;
- several keys form a repeating group and should become an array;
- a new label/header is a strong alias for an existing field;
- a table family repeatedly continues onto headerless pages;
- users repeatedly make the same structured-data correction.

The UI should show support, counterexamples, affected documents, validation deltas, and estimated reprocessing cost before acceptance.

“Similar projects” should initially mean one of:

- other documents in the same workspace;
- organization schemas deliberately published into the organization library;
- DocSlurp-owned starter schemas built without customer content.

Cross-customer learning should be deferred until there is an explicit privacy model, opt-in, aggregation threshold, and proof that no source values or tenant-identifying labels can leak.

## UI design

### Workspace navigation

Add **Schemas** as a first-class workspace settings section rather than hiding the feature below the current raw `outputSchema` textarea. Keep a compact schema health card on the workspace cockpit showing:

- active schemas;
- assigned document coverage;
- open proposals;
- validation pass rate;
- documents needing schema review;
- structured extraction cost and latency.

### Schema list

Each row/card shows name, scope, active revision, source/output shapes, matched document count, last used time, validation pass rate, override rate, open proposals, and status.

### Schema detail and editor

Provide four tabs:

- **Fields**: visual field/array/object builder with types, aliases, validators, required state, and review policy.
- **Source patterns**: table continuation, form labels, layout fingerprints, and classification/match rules.
- **Test**: choose recent documents, dry-run a draft, compare old/new outputs, and show field-level evidence and cost.
- **History**: immutable revisions, changelog, author/proposal source, eval deltas, activate, retire, and rollback-by-new-revision.

Raw JSON remains an expert escape hatch. Editing an active revision always creates a draft.

### Proposal review

Show a contract diff, extraction-hint diff, supporting/counterexample documents, confidence, validation impact, and estimated backfill cost. Actions are `Accept as draft`, `Reject`, and `Not this schema`. Acceptance should not activate or backfill until the user explicitly chooses those actions.

### Document override

The document inspector shows the assigned revision, why it matched, other candidates, and `Override and reprocess`. Manual correction remains separate from schema editing: correcting one result should not directly mutate the shared schema.

## API surface

Suggested resource-oriented endpoints:

```text
GET    /v1/workspaces/:workspaceId/schemas
POST   /v1/workspaces/:workspaceId/schemas
GET    /v1/schemas/:schemaId
POST   /v1/schemas/:schemaId/revisions
POST   /v1/schemas/:schemaId/revisions/:revisionId/activate
POST   /v1/schemas/:schemaId/revisions/:revisionId/retire
POST   /v1/schemas/:schemaId/revisions/:revisionId/evaluate

GET    /v1/workspaces/:workspaceId/schema-proposals
POST   /v1/schema-proposals/:proposalId/accept
POST   /v1/schema-proposals/:proposalId/reject

GET    /v1/documents/:documentId/schema-assignment
PUT    /v1/documents/:documentId/schema-assignment
POST   /v1/documents/:documentId/structured-reprocess
```

Run creation may accept `schemaRevisionId` or `schemaMode: "workspace" | "none"`. It must not accept arbitrary organization schema IDs without the normal organization/workspace access check and an explicit workspace binding.

For live runs, schema detection and proposal events should flow through the existing progress/SSE channel. Polling the same resources remains the non-streaming fallback.

## Persistence model

Recommended tables:

### `extraction_schemas`

Stable identity and ownership: `id`, `org_id`, nullable `workspace_id`, `name`, `slug`, `description`, `created_by_user_id`, timestamps, and archive state. A non-null workspace ID means workspace-owned; a null workspace ID means organization-owned.

### `extraction_schema_revisions`

Immutable revision data: `id`, `schema_id`, monotonically increasing `revision`, lifecycle status, `json_schema`, `output_shape`, `source_hints`, `extraction_config`, `provenance`, `change_summary`, `created_by_user_id`, and timestamps. Enforce uniqueness on `(schema_id, revision)` and at most one active revision per schema.

### `workspace_schema_bindings`

Deliberate availability and matching policy: `workspace_id`, `schema_id`, optional pinned active revision, priority, default flag, match rules, automatic threshold, and enabled state. This prevents organization schema updates from silently changing workspace behavior.

### `document_schema_assignments`

Historical decision record: `document_id`, `run_id`, `schema_revision_id`, decision source, confidence, reasons, candidate summary, overridden-by user, and timestamps. Do not replace old assignments when reprocessing; identify the current result separately.

### `schema_proposals`

Workspace-local proposed schema/revision diff, evidence summary, confidence, support/counterexample counts, status, suppression fingerprint, source document references, decision user, and timestamps.

### `schema_observations`

Aggregated structural and quality evidence keyed by workspace, document, and optional schema revision: field/header presence, inferred types, table/layout fingerprints, validation outcome, correction signals, and hashes needed for clustering. Keep raw values in governed document artifacts, not this learning table.

Structured result metadata should be queryable in Postgres even if the full output remains an object-storage artifact. At minimum persist result ID, artifact URI, schema revision, policy, confidence, validation counts, and cost/latency rollups.

## Migration from `pipeline.outputSchema`

This project is pre-release, so prefer the clean v1 model over preserving two permanent configuration paths:

1. Convert each non-empty inline `pipeline.outputSchema` into a workspace-owned `Imported workspace schema` revision.
2. Bind and activate that revision for the workspace.
3. Change `structured-extract` to consume a document assignment.
4. Remove `pipeline.outputSchema` after the migration and update advanced automation requests to reference a revision or provide an explicitly ephemeral run schema.

An ephemeral run schema may remain useful for one-shot APIs, but its full contract must be snapshotted into the run and result so it is reproducible.

## Permissions, privacy, and audit

- Workspace viewers may inspect schemas and results; editors may create drafts and manual assignments; admins may activate/retire revisions and publish to the organization library.
- All create, edit, activate, retire, bind, accept/reject, override, and reprocess actions write audit events.
- Schema discovery respects workspace privacy mode. `local-only` and `strict-privacy` must not send observations to hosted models.
- Treat document content, field labels, and schema descriptions as untrusted content and reuse the trusted document task boundary.
- Do not expose sample values in org-wide catalog cards or proposal notifications.
- Every LLM call logs and persists actual token usage. Detection-specific metrics should distinguish schema matching, proposal generation, and evaluation.

## Success metrics

- assignment coverage: documents assigned to an approved revision;
- automatic assignment precision, measured from user confirmations/overrides;
- proposal acceptance and rejection rate;
- manual override rate by schema revision;
- field coverage, validation pass rate, and needs-review rate;
- headerless table continuation precision and row-alignment error rate;
- correction recurrence before and after a revision;
- discovery/extraction latency and cost per document;
- time from first matching document to an approved schema.

Avoid optimizing proposal volume. A quiet system with a few high-confidence proposals is better than a noisy one users learn to ignore.

## MVP and rollout

### Phase 1: managed schemas

- named workspace schemas and immutable revisions;
- visual editor plus raw JSON;
- document assignments and explicit run overrides;
- migrate inline `outputSchema`;
- pin revision metadata into results;
- test a draft against selected documents.

### Phase 2: suggest-only discovery

- add `schema-detect` and structural observations;
- propose schemas for native tables, headerless continued tables, native PDF fields, and scanned key/value forms;
- proposal review and workspace schema health UI;
- no automatic assignment by default.

### Phase 3: approved automatic assignment

- match documents only to approved workspace bindings;
- confidence thresholds and candidate diagnostics;
- correction-driven improvement proposals;
- org library publishing and explicit workspace binding;
- optional backfill with forecast and approval.

## MVP acceptance criteria

- With automation `off`, ingestion performs no schema discovery work or discovery model calls.
- A workspace can own multiple schemas, and every structured result identifies an immutable revision.
- A user can create, edit, test, activate, retire, and manually assign a schema without editing workspace pipeline JSON.
- In `suggest` mode, novel documents can create proposals but cannot alter active extraction behavior.
- In `automatic` mode, only approved revisions can be selected automatically, and low-confidence documents remain unassigned or use the explicit default.
- A multi-page table with missing later-page headers can produce one row collection with inherited-column provenance and review diagnostics.
- Native and scanned forms can produce editable proposals whose fields retain label/page/region evidence.
- A user can override an assignment and reprocess without destroying the prior result.
- Discovery failure does not block normal markdown/search ingestion.
- Tenant access checks, audit events, privacy routing, actual AI token usage, cost, and latency are covered by focused tests.

## Explicit non-goals for v1

- silently learning from or sharing structure across customer organizations;
- automatic promotion of newly detected schemas;
- mutating an active schema in place;
- treating model confidence alone as evidence of a schema match;
- packet splitting or multiple independent page-range schemas in one document;
- a full relational database designer or arbitrary ETL transformation language.
