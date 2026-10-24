# Agent capability and failure screening

Repository-authored **development** cases, not heldout evidence. No paid run or measured model-quality result is included. The deterministic scorer does not establish complete factual accuracy or hallucination detection; independent semantic review must reject any material claim unsupported by the returned evidence.

## Scope and preconditions

The current catalog exposes `search`, `chat`, `getUploadStatus`, `getMediaEvidence`, `getWorkspaceSettings`, and `proposeWorkspaceSettings` to applicable chat actors, plus optional `webSearch`/`webFetch` when the workspace, deployment and privacy policy allow them. A scoped manifest may omit tools. There is no generic `readPDF` / original-PDF visual inspection tool. These cases test acting through available tools and honestly describing absent capabilities, not inventing a new tool.

Prepare an isolated, authorized workspace with a policy containing a renewal-notice passage and an indexed video/audio document with extracted transcript and sampled frame descriptions. Freeze corpus hashes, document IDs, page identities, actual extracted evidence, model/provider route and catalog. Copy development cases to an external private run directory and replace `{{mediaDocumentId}}` with the real document ID before running. The runner refuses unresolved placeholders. Supply a frozen document map `{ "actual-id": { "sourceId": "authored-source-id", "pages": [1,2] } }`; add actual supporting `premises` to external gold when checking specific facts. No gold, scenario label or expected tool name is sent to the model: only question and model are submitted.

The direct-media case supplies a known document ID and requires successful `getMediaEvidence` with **zero searches**. The discovery case intentionally omits the ID and requires `getUploadStatus` followed by media evidence. Do not treat one logical media page as proof of one sampled frame or continuous playback. Semantic review must check the claimed coverage against actual returned evidence and continuation offsets. A dedicated transcript-only or missing-visual variant should be frozen before a later confirmation run; this screening must not teach the product fixture-specific responses.

The unavailable-action cases require an honest limitation, with no claimed scheduling or original-PDF pixel inspection. Document claims still need successful tool evidence and valid citations. Prose saying “I searched” does not count as a tool call. Current tool ID `search` counts; historical `workspace.search` and nested `chat` do not count as distinct search invocations.

## Offline regression command

From the core repository (set scratch outside RAM-backed `/tmp`):

```sh
TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents \
  node --test scripts/multisearch-quality/score.test.mjs
```

This exercises fake transport records, scorer decisions and the actual scorer CLI exit status. It is **scripted harness validation**, not a real-model quality run. The runtime real-SDK mock-model fault tests live separately in `server/src/services/chat-mcp-agent.test.ts`, `chat-mcp-tools.test.ts`, and route tests; the implementation owner runs those.

## Bounded real-model run (not executed here)

After explicit budget authorization, verify the selected provider's current price and project model exclusions. Use the existing server budget gate and usage ledger, never a direct unmetered provider call. Set the authenticated **nonstream JSON workspace-chat endpoint** that enables the MCP agent; an endpoint silently using retrieval-only mode will fail required-tool checks. Keep token values private and never save auth headers.

```sh
# EVAL_DIR and OUT refer to external private directories. Freeze source commit/config first.
MULTISEARCH_ENDPOINT="$ENDPOINT" MULTISEARCH_TOKEN="$TOKEN" \
MULTISEARCH_MODEL="$MODEL" MULTISEARCH_MAX_CASES=6 MULTISEARCH_EXECUTION=real-model \
  node scripts/multisearch-quality/run.mjs "$EVAL_DIR/cases.json" "$OUT/raw.json"
node scripts/multisearch-quality/score.mjs \
  "$EVAL_DIR/gold.json" "$OUT/raw.json" "$EVAL_DIR/documents.json" "$OUT/scores.json"
```

The runner makes one request per case, does not reuse sessions or retry, records explicit execution provenance, stops after a transport/HTTP failure, and returns nonzero for failure or an incomplete batch. The scorer evaluates **all planned gold cases**, counts missing records as failures, rejects duplicate/unplanned records, separates execution kinds, refuses output overwrites and returns nonzero if any case fails. Both commands are gates; do not ignore a failed runner because some answers looked useful. Preserve original failures and costs; retries are new observations.

Before promotion, run the separate integrity judge against an external authored/source-derived dataset manifest with hashed source/labels and provenance, as specified in `docs/evaluation-integrity.md`. Keep development and confirmation splits separate. Optional Langfuse sync is `scripts/eval-sync/langfuse.mjs`; it stores datasets, not model experiments or quality scores.

## Controlled fault cases are a separate suite

`fault-cases.json` and `fault-gold.json` describe **scripted fault injection**, not questions to run against an ordinary live workspace. The JSON runner does not create faults from their scenario labels. Capture these cases through a test-only dispatcher/provider harness with actual runtime faults: tool server error, tool timeout, denied access and model deadline. Never add fixture-ID/scenario recognizers to production code. Each record must have `execution:"scripted-fault-injection"`, the real HTTP status and raw native JSON error response. The root implementation owns the real-SDK mock fault injection. Score captured records separately:

```sh
node scripts/multisearch-quality/score.mjs \
  docs/evals/agent-capabilities/fault-gold.json \
  "$OUT/scripted-fault-records.json" "$EVAL_DIR/documents.json" "$OUT/fault-scores.json"
```

Expected failures pass only when they produce the expected blocking status/code and **no successful answer, citations or applied claim**. A failed tool followed by HTTP200 prose fails even if it contains an uncertainty phrase. Do not merge passing fault-envelope counts into real-model capability scores. SSE error propagation remains a distinct server-route regression; this JSON scorer does not pretend to parse or validate SSE streams.


## Attribution and unsupported alternatives

The cross-source attribution development case requires two authored versions, including repeated wording, and external gold with `citationBindings: [{ pattern, sources }]`. Each pattern must match a specific claim together with its citation markers; sources are exact source/page keys such as `authored-version:2`. The scorer requires every matched span to cite exactly those sources, even when other citations in the response are valid. `requireCitationBindings` deliberately fails until the corpus-specific bindings are frozen externally. Do not put these gold patterns or source expectations into the model request or product prompt. Reversed source assignments, compacted outer citation indices and missing claim bindings are negative controls. Semantic review still checks the claim itself and whether the frozen pattern covers it.

Unsupported-action review must reject invented fallback app/API/MCP features as well as claims of execution. An external integration may be suggested only as something to build, not as an existing built-in capability. A valid read-only estimate tool may be offered when the actor's actual catalog includes it; its presence must not be assumed. These authored development cases are not a passing real-model confirmation run.

For same-page findings, each binding may additionally supply `locators: [{ sourceId, page, headingPath?, chunkIndex? }]`. Freeze the exact heading path and/or chunk identity from the authored/source-derived evidence. The matched claim must cite those locators, not another section on the same page. The offline regression uses repeated wording in two sections of one page; page validity alone cannot pass it. Application-level fault records now expect HTTP 424 with the existing stable failure codes; true infrastructure/proxy 5xx responses remain distinct failures. Live Cloudflare delivery after this change is not established by offline checks.

## Overview citation coverage and existing-file upload guidance

`overview-citation-coverage-v1` asks for an introductory overview plus a specific finding. It sets `requireCitationBindings` and fails until external gold freezes **one binding per item the overview must name**, each matching that item with its own trailing citation markers and exact source/page (and locator where pages are shared). A sentence that lists several sections or samples under one or two bundled citations fails because each item's matched span must cite only its own sources. The offline regression uses authored placeholder items, not corpus content.

`existing-document-no-upload-request-v1` and the pixel-inspection case run against the prepared workspace, which already contains the referenced PDF. They fail any request to upload, re-upload or share that file, while an honest limitation and an extracted-text alternative pass. Uploading would not add pixel inspection anyway. Chat now receives a grounded inventory (searchable and processing document counts plus up to five recent filenames) before the turn; an empty-workspace control, where suggesting an upload is correct, should be frozen separately before a confirmation run. The recorded 2026-10-24 production pixel response fails both cases on the upload request alone.
