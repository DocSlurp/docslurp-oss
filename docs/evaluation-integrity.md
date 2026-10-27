# Evaluation integrity

DocSlurp uses evaluation datasets to measure general product behavior. They are not a source of hidden production rules.

## Hard boundary

Product code and worker-owned prompts must never encode:

- a benchmark or fixture name;
- field names or expected values copied from an evaluation schema;
- fixture IDs, filenames, hashes, image traits, or ordering used to recognize prior inputs;
- a branch, route, label, or model policy that exists only for one known evaluation set.

The same restriction applies to indirect leakage, such as a supposedly generic prompt whose enumerated fields reproduce the held-out answer schema.

## Allowed generalization

Changes may use signals available for any unseen customer document: MIME type, page geometry, OCR confidence, text density, handwriting or low-light classification, layout structure, and the workspace's runtime-provided output schema. Categories must name reusable document properties, not a benchmark domain.

A workspace may supply task-specific instructions or a schema at runtime. Worker-owned code may safely delimit and consume those inputs, but must not copy their contents into a built-in template.

## Promotion checklist

Before calling an eval-driven change a win:

1. State the general capability and the runtime signal that selects it.
2. Search the production diff for fixture names, benchmark field names, expected values, and input-recognition logic.
3. Run class-level regression checks, including cases outside the motivating failure when available.
4. Report quality, latency, and marginal cost on the same workload and scoring contract.
5. Preserve failed and eliminated hypotheses, but discard results produced after benchmark leakage.

When leakage is found, cancel the run, remove contaminated result artifacts, revert the specialized behavior, and restart from the last clean baseline.

## Dataset directory

Evaluation datasets live outside the repository in one directory named by `DOCSLURP_EVAL_DATA_DIR`. Pass a subdirectory as `--dataset` to the integrity judge.

## Independent integrity gate

Run the deterministic integrity judge independently of the quality scorer:

```sh
node scripts/evaluation-integrity-judge.mjs \
  --dataset /absolute/path/to/held-out-dataset \
  --output research/<evaluation>/integrity-report.json
```

The judge derives fixture identifiers, label names, distinctive expected values, and source-file hashes from the external dataset at runtime. It fails if source media has been copied into the repository or if production files recognize fixtures, embed labeled answers, or encode several benchmark labels together. It intentionally allows generic document capabilities and schemas supplied as runtime workspace configuration.

The default v1 deterministic tool supports an external `integrity-manifest.json` with
schema `docslurp-authored-eval@v1`. Each case supplies a distinctive `id`, hashed
`source` and `labels` artifacts (`path`, `sha256`), and authored provenance
(`kind: "authored"`, `author`, `description`, `createdAt`). Label files contain
`{"labels":[{"name":"label_name","expected":"labeled value"}]}`; expected values may
also be arrays or objects. Missing labels, provenance or hash matches fail.

The tool scans production files and additions for fixture IDs, source hashes,
distinctive answers, and groups of benchmark labels. Ordinary single-word answers
alone are insufficient evidence: they require at least two benchmark labels in
the same file. Proper multiword values and structured identifiers can trigger an
individual finding. This deterministic screen does not detect every possible
obfuscation or replace independent review. Test gold and documentation are excluded
from textual product checks, but copied source bytes are checked across all tracked
and non-ignored untracked repository files. Reports bind the verdict to the dataset
manifest hash, Git head and scanned production content hash.

**Catalog limitation:** the restored tool currently rejects every `catalog.json`
with `unsupported-catalog-schema`. It does not yet implement or claim to validate
the catalog contract below. Do not convert a generated or licensed corpus into an
authored manifest to bypass these requirements. Catalog support must implement and
test the following rules before such a dataset can receive a passing verdict.

The required contract for an `extract-eval-catalog@v1` `catalog.json` checks each entry by `source.kind`:

- `synthetic` / `generated`: the generator must exist in the repository and the asset must match its catalog sha256
  (and the `manifest.json` artifact sha256 when listed). If the bytes changed, the asset passes only when the dataset
  manifest lists it under `nondeterministic` (a glob such as `inputs/unusual-encrypted-*.pdf`, e.g. time-salted
  encryption), its reference file still matches its hash, and a structural check passes (PDF header and `%%EOF`,
  an `/Encrypt` dictionary when the asset is encrypted, the declared page count when page objects are visible).
- `licensed-real` / `real-page-extract`: real documents that cannot be regenerated. The asset must match both the
  catalog sha256 and the manifest artifact sha256, carry a license record (`id`, `redistribution`, attribution, URL or
  evidence) and an upstream URL. They must stay outside the repository: a licensed-real corpus inside the repo, or any
  repository media file with the same bytes, fails.
- Any other kind fails `catalog-source-kinds`.

Quality and integrity are separate gates. A high labeled-data score cannot compensate for a failed integrity report, and envelope/schema validity must not substitute for labeled-value correctness.

Conversation and tool traces can be backtested separately with `scripts/trace-safety-judge.mjs`. Supply an explicit policy file containing the allowed hosts and command rules for that run. The report counts observed calls, violations, tool failures, model circumvention attempts, user prompt-injection attempts, hostile instructions returned by tools, and possible unsupported success claims. Raw messages and tool payloads are not copied into the report; findings use event indexes and evidence hashes.

Deterministic matches are not mind-reading. In particular, a tool failure is not dishonesty, a user jailbreak attempt is not a model violation, and a possible unsupported success claim requires review before it can be called dishonest.

## Opt-in v2 projection contract

V1 remains the default, unchanged, including its existing exclusions and
capitalization-based standalone heuristic. Select v2 explicitly:

```sh
node scripts/evaluation-integrity-judge.mjs --version v2 \
  --dataset /absolute/path/to/authored-eval --output /path/to/integrity-v2.json
```

Do not run this example against a held-out corpus until the implementation and
projection authoring have received independent review. V2 never upgrades a v1
manifest or guesses roles. Its manifest schema is `docslurp-authored-eval@v2` or
`docslurp-source-derived-eval@v2`, with the corresponding v1 provenance structure.
Unknown fields and versions fail closed. A minimal authored manifest is:

```json
{
  "schema": "docslurp-authored-eval@v2",
  "cases": [{
    "id": "invented-larch-control-821",
    "source": { "path": "invented-larch-source.txt", "sha256": "<64 lowercase hex digits>" },
    "labels": { "path": "labels.json", "sha256": "<64 lowercase hex digits>" },
    "provenance": {
      "kind": "authored", "author": "Control writer",
      "description": "Invented control", "createdAt": "2026-10-27"
    }
  }]
}
```

`originalCaseId` is optional and remains a recognition target. Source-derived
provenance requires `kind: "source-derived"`, `questionAuthor`, `description`,
`derivedAt`, and nonempty `sources`. Each source has `publisher`, an HTTPS
`sourceUrl` without credentials, `originalPdfSha256`, `extractionMethod`, and
nonempty `pages` (`page`, `excerptSha256`). These are provenance declarations;
URLs are never fetched, and PDFs are never parsed by this gate.

Each labels artifact is a **complete authored projection**, not the v1 labels
array. Its only top-level fields are `schema`, `document`, `fields`, and `units`.
`document` contains all material being classified, including authoring metadata.
There are no inferred roles, allowlists, word-frequency lists, or silent drops.
For example, the complete labels artifact for a small row is:

```json
{
  "schema": "docslurp-integrity-projection@v2",
  "document": {
    "author": "Sample Draft Team",
    "item": "Larch pump",
    "status": "Ready For Review",
    "serial": "VellumRotor-847-TK"
  },
  "fields": [
    { "pointer": "/author", "role": "metadata" },
    { "pointer": "/item", "role": "content", "match": "contextual" },
    { "pointer": "/status", "role": "answer", "match": "contextual" },
    { "pointer": "/serial", "role": "answer", "match": "standalone" }
  ],
  "units": [{ "kind": "row", "anchor": "/item", "values": ["/status"] }]
}
```

Pointers are exact RFC 6901 JSON pointers **relative to `document`** (root `""`,
`~0` for tilde, `~1` for slash). No wildcard, parent inheritance or subtree role
exists. The source JSON pointer in the labels artifact is `/document` followed by
the pointer: `/status` becomes `/document/status`. Every scalar, including
numbers, booleans, null and empty strings, must have exactly one field declaration;
an empty array or object also needs a declaration. Empty containers and empty
strings can only be metadata. Numbers use canonical JSON serialization with safe integers; rounded/noncanonical
numeric literals (including `1.0`, `-0` or `1e3`) are rejected rather than silently
changing visible values. Duplicate JSON keys, duplicate or nonexistent field
pointers, incomplete accounting, and unknown roles fail. Object member names are
separately inventoried with their pointers and hashes; they remain candidate
observations, never inferred answers. A visible label/header that matters to an
association must also appear as a classified value in `document`.

The four roles are:

- `content`: visible context such as a row identity, header, equation label or
  graph endpoint; requires `match`.
- `answer`: a scored value; requires `match`. At least one answer is required.
- `metadata`: authoring information; never an answer target. Literal occurrences
  are retained with reason `authoring-metadata`. This does not exempt artifact
  byte copies, manifest IDs, recognition fields, or hashes.
- `recognition`: a literal input-recognition token of at least eight characters;
  always blocking on a match. It cannot carry `match` or participate in units.

Before accepting any `content`, `answer` or `recognition` target, validation
requires well-formed UTF-16: lone high/low surrogates, including embedded or reversed
pairs, refuse as `ill-formed-unicode-target` before scanning. Authored manifest
recognition IDs use the same check. UTF-8 scanner text cannot contain isolated
surrogates, so these targets cannot protect evidence. Valid surrogate pairs and
literal U+FFFD remain supported unchanged. No replacement, normalization or extra
escape decoding occurs: JSON `"\ud800"` is rejected as an isolated surrogate, but
JSON `"\\ud800"` is supported literal backslash-u text and matches only that text.
Metadata remains an inventoried authoring role, not an answer target; trusted role
and source-completeness limitations still apply.

`match` is exactly `contextual` or `standalone`. Standalone values must be at least
8 UTF-16 code units and satisfy a mechanical identifier test (letter/number
separated by `_ . : / @ -`, mixed letters/digits, camel case, or at least eight
digits), or contain at least 48 code units and eight whitespace-separated words.
Capitalization and title case alone never qualify. This is eligibility, **not a
claim that a phrase is unique**; authors and reviewers still own classification.
Short ordinary phrases must be contextual. An authored `standalone` declaration
cannot bypass the eligibility test. Eligible content and answers both remain
strong standalone leakage evidence; comments and executable syntax do not exempt
them in v2.

Every contextual field must participate in at least one supported unit. Each
expanded unit has distinct existing pointers, only content/answer roles, and at
least one answer. Repeated or substring-equivalent member values are rejected as
`ambiguous-unit-members`, using the same `/iu` Unicode literal equivalence as the
scanner, conservatively without word boundaries. Locale lowercasing is not an
equivalent test: `soup` and `ſoup`, for example, are indistinguishable to `/iu`.

Before a unit counts toward contextual coverage, validation enumerates its at most
six literal orderings. At least one must fit the unchanged 256 UTF-16 code-unit /
three-line window with **disjoint** members. The width includes the members plus
any single-space gaps required by the matcher's Unicode word boundaries. The line
lower bound counts embedded LF characters; if the last member ends with LF, that
terminal LF occupies the preceding line, matching the scanner's `end - 1`
convention. No source text is inspected to make this decision. An unsupported
layout refuses with `infeasible-evidence-unit`, even if other feasible units cover
its fields. Passing this check establishes only that a literal arrangement could
fit the window; it does not establish semantic relevance.

There are exactly four unit shapes (no extra keys):

```json
[
  { "kind": "row", "anchor": "/item", "values": ["/status", "/amount"] },
  { "kind": "header-value", "header": "/header", "value": "/value" },
  { "kind": "equation", "label": "/equation/label", "expression": "/equation/expression" },
  { "kind": "graph", "from": "/edge/from", "relation": "/edge/relation", "to": "/edge/to" }
]
```

This last block shows unit shapes, not a complete artifact: every referenced
pointer must be present and classified. A row expands into **one pair per cell**
(anchor + value), so copying a partial row can block. A header/value pair preserves
its association; an equation counter alone does not implicate unrelated code.
A graph requires all three members. Define separate units for independently
meaningful partial associations instead of assuming graph inference. If a row
identity repeats across rows, the representation must supply distinguishing
visible identity text. Within a projection, distinct anchor pointers with `/iu`-
equivalent complete values refuse as `ambiguous-row-identity` before repository
scanning, even on clean code. The same anchor pointer may protect multiple cells
of one row. Extra fields elsewhere do not disambiguate an identity automatically;
this contract has no implicit multi-field identity or inferred row semantics.

Matching is case-insensitive literal matching with Unicode letter/number/underscore
boundaries. All members must have nonoverlapping occurrences within **256 UTF-16
code units and three occupied LF-delimited lines**, in any order. Every boundary-
valid occurrence start is enumerated, including self-overlaps (`go go` in `go go go`
has starts 0 and 3). Iteration advances by one Unicode code point from the previous
start, rather than past the previous match. Every occurrence is recorded under
the observation/work limits; exhausting a limit refuses instead of omitting
candidates from a passing report. The scan uses anchored windows,
not Cartesian products or whole-file cooccurrence. It does not normalize equation
syntax, infer table geometry, understand graph direction, decode escaped strings,
or infer synonyms. A contextual finding means literal proximity under an authored
unit, not proven semantic equivalence or intent. Occurrences too far apart are
retained as insufficient standalone evidence; they do not create an unresolved
semantic question. Overlapping occurrences that would otherwise fit a unit produce
`unresolved-context-ambiguity` and block promotion. Unsupported or inherently
ambiguous projections block before scanning. There is no override that clears
ambiguities or findings: revise the general contract and obtain review.

## V2 audit and operational limits

The report includes a complete `projection` ledger of field roles, source pointers,
value hashes, object member-name hashes, expanded units, labels artifact hashes,
and provenance hashes. Every literal candidate occurrence is retained in
`observations` with path, working-tree origin, UTF-16 offsets, physical line,
case/pointer/role, decoding mode, evidence hash and reason, including candidates that do not become
findings. Findings reference observation indexes where applicable. Raw values are
not emitted; these are raw **occurrence observations**, not a transcript of answers.
Treat the report as sensitive eval evidence: pointers can contain label names.
Its dataset hash binds the manifest, whose hashes bind the source and projection;
its production hash binds every scanned file's path and bytes, and it records HEAD.

V2 scans full current files, including unchanged committed baselines, non-ignored
untracked files, tests, docs, Markdown and comments. It applies recognition and
answer checks everywhere, without v1's textual path exclusions. Exact whole-file
byte copies of **either source or labels artifacts** block in every path, including
binary files. Both artifact hashes remain recognition targets. There is no
baseline grandfathering. Removing leaked content can repair the current snapshot;
deleted historical bytes are not scanned. Files ignored by Git and not tracked
are outside this scan, as is Git history. It is not a forensic audit or an atomic
filesystem snapshot. The coordinator must keep the tree stable during promotion.

Fixed fail-closed limits (no per-run weakening) are exported as `LIMITS`:

- 2 MiB per JSON contract, 16 MiB per source/labels/repository file; 128 MiB total
  artifact reads and independently 128 MiB total repository bytes.
- 200 cases; 5,000 fields and 10,000 expanded units per projection; 16 row cells;
  depth 32 and 50,000 parsed JSON nodes; 2,048 code units per literal.
- 50,000 aggregate term/provenance associations, 20,000 repository files,
  50,000 candidate observations, and 2 billion scan-work units (text code units
  multiplied by distinct literal count, summed across files; empty files count as
  one code unit, plus matched code units including overlaps). Projection validation
  independently has a 2 million code-unit comparison budget (the sum of source
  and target literal widths for each ambiguity comparison); runtime contextual
  search has a separate 2 million step/comparison budget. Both use `contextWork`;
  neither budget can be weakened per run.
- Files must be regular files or symlinks resolving to regular files within their
  permitted root. Escaping/dangling repository symlinks block. Text files without
  NUL bytes must decode as UTF-8. Repository decoding explicitly uses
  `ignoreBOM: true` to preserve an initial U+FEFF in both strict and replacement
  modes, including in occurrence offsets and evidence hashes. A valid initial
  scalar is never removed from either the scanned text or a declared target.
  JSON contract parsing is unchanged. NUL-bearing files also receive literal checks
  after UTF-8 decoding with invalid sequences replaced, explicitly recorded as
  `utf8-replacement`; adding a binary marker cannot disable ID/answer recognition. Invalid/unsupported inputs or a limit reached always block, never truncate
  evidence into a passing verdict.

R1 regressions use only the reviewers' explicitly supplied invented controls:
impossible individual/combined widths and line counts; `go go` and `aba aba`
overlap window edges; repeated row identities; and Unicode literal-equivalence
collisions. Benign counterparts retain distant occurrences, distinct row
identities, feasible boundary layouts and metadata observations. These checks do
not make proximity proof of a semantic dependency: unrelated nearby literals can
still refuse, while semantic copies beyond the literal window can pass.

Authored eval artifacts are trusted source inputs. This validation cannot prove
that an author faithfully included every visible source value or correctly marked
metadata. Review those declarations independently before corpus use. It introduces
no customer-byte parsing, production parser change or ingestion boundary expansion.
Literal matching can miss reformatting, obfuscation, encoded binary payloads,
partial artifact copies and semantic paraphrases, and can flag unrelated nearby
literals. Strong findings and unresolved ambiguities block this deterministic gate;
passing still requires independent review and says nothing about extraction quality.
