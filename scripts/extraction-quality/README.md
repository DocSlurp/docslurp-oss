# Extraction quality lab: dataset builder and scorer

Offline, deterministic oracles for three extraction artifacts: a **graph** of directed
relationships, factual **key points**, and a one-paragraph **summary**. No model or API call
is made anywhere in this directory. Evaluation integrity rules from `AGENTS.md` apply:
sources and gold live **outside** the repository, the generator and scorer are generic,
and `scripts/evaluation-integrity-judge.mjs` runs as a separate gate.

Files: `build-dataset.mjs` (compile authored spec to a frozen dataset), `score.mjs`
(scorer, review queue, CLI), `score.test.mjs` (sentinel tests on synthetic data only).

## Decision this supports

Whether a candidate extraction change improves the factual correctness of graph, key
points and summary without adding unsupported or contradicted claims. Development cases
screen candidates; held-out cases are scored once per selected candidate and reported as
**aggregates only**.

## Dataset layout (`<root>/version-v1/`, immutable)

```
version.json                 version, author, creation time, spec/manifest/tool hashes, counts
integrity-manifest.json      combined manifest for the integrity judge (docslurp-authored-eval@v1)
development/  heldout/       12 and 8 cases
  integrity-manifest.json    per-split manifest (sha256 of every source and label file)
  runner-inputs.json         GOLD-FREE input list: the only file a runner needs
  <id>.txt                   source document; pages separated by form feed (U+000C)
  <id>.gold.json             {labels:[{name,expected}]}: oracle. Scorer only.
  oracle-checks/<id>.json    authored reference answer + defect controls (builder self-test)
authored/<split>.spec.json   the authored spec each split was compiled from
```

Runners read `runner-inputs.json` and `<id>.txt` only. They must not open `*.gold.json`,
`oracle-checks/` or `authored/` for the held-out split. Held-out ids are opaque.

## Runner input schema (`runner-inputs.json`)

```json
{
  "schema": "docslurp-extraction-quality-inputs@v1",
  "version": "v1",
  "split": "development | heldout",
  "cases": [
    {
      "id": "string, /^[a-z0-9-]{12,}$/",
      "source": { "path": "<id>.txt", "sha256": "hex", "bytes": 0, "pages": 1,
                  "pageSeparator": "\f" },
      "summaryWordLimit": 120
    }
  ]
}
```

Each page is the text between form feeds. Ingest the file as a multi-page text document
(or split on `\f` to pages) so page-spanning and multi-window behaviour is exercised.

## Runner output schema (`outputs.json`, input to `score.mjs`)

```json
{
  "schema": "docslurp-extraction-quality-outputs@v1",
  "runId": "free text, echoed in the report",
  "split": "development | heldout",
  "cases": {
    "<case id>": {
      "graph": {
        "entities": [{ "id": "optional", "name": "string", "aliases": ["optional"] }],
        "relationships": [{ "source": "entity id or name", "predicate": "string", "target": "entity id or name" }]
      },
      "keyPoints": ["one factual claim per string"],
      "summary": "one paragraph"
    }
  }
}
```

`source`/`target` resolve first as an entity `id` from the same output, then as a name.
A missing case scores zero. Extra fields are ignored. Envelope problems are diagnostics only.

## Rubric

**Primary: semantic correctness** (these decide acceptance).

| Metric | Definition |
| --- | --- |
| Graph precision / recall / F1 | Edges are `(source, predicate, target)` after entity-alias resolution. Predicted edges are de-duplicated. Recall counts gold relations covered by any frozen predicate alias, an inverse predicate with endpoints swapped, or either orientation for `symmetric` relations. Reciprocal relations are two gold edges. A reversed edge never matches a directed relation. |
| Contradicted edges (gate) | Reversed directed edges, forbidden (outdated, negated, false) relations. Any count above zero fails the case. |
| Unsupported edges | Every unmatched edge, classed `contradicted`, `unresolved-endpoint` or `unmatched`. Unmatched edges are not proven false; they are queued for blind review. In `noRelations` control cases every edge is unsupported. |
| Fact coverage | Fraction of gold atomic facts asserted correctly by a sentence of the key points or summary. A fact matches when its subject/predicate/object term groups co-occur in one sentence (ordered when the fact requires order), required numbers are present, and polarity agrees. |
| Contradictions (gate) | Wrong or missing-for-anchor numbers, negation/polarity flips, authored contradiction signatures (reversed roles, outdated-as-current, wrong qualifier), forbidden claims. Any count above zero fails the case. |
| Unsupported / unverified units | A sentence is `supported` only if it matches a fact **and** every content word and number in it lies in the lexicon of the facts it matched (their authored evidence quotes, statement, extras) or in the case entity names. Matching a fact does not hide an appended claim: leftover terms or numbers make the sentence `unverified`. A sentence matching no fact is `unverified` (listing `novelTerms` that appear nowhere in the case). |
| Soundness | supported units divided by scored units. Unverified units count against it. |
| Artifact score | F1 of fact coverage and soundness (graph: edge F1). Case score is the mean of the three artifact scores; aggregate `primary` is the macro mean across cases. |

**Secondary diagnostics** (never gate): envelope validity, summary on one paragraph (no
newline or list markers), summary within `summaryWordLimit` words, entity recall,
duplicate key points.

### Verdict ladder (deterministic matching cannot prove arbitrary claim support)

1. `fail`: any contradiction, contradicted edge, or missing case. Reviews cannot clear a
   contradiction; fix the oracle in a new dataset version instead.
2. `needs-review`: no contradiction, but unverified units, unmatched edges, missed facts
   or no review supplied. Nothing is called supported by default.
3. `pass`: no contradiction, full coverage after review, and a review file that is
   blind (reviewer saw no candidate identity or deterministic verdict), declares
   independence from the dataset author, and resolves every queued item as supported.

`score.mjs --review-queue <path>` writes the queue (items shuffled, no scores, no
candidate labels); `--review <file>` applies verdicts:

```json
{ "schema": "docslurp-quality-review@v1", "reviewer": "name", "blind": true,
  "independentOfAuthor": true, "items": { "<itemId>": "supported | unsupported | covered | not-covered" } }
```

## Commands

```
node scripts/extraction-quality/build-dataset.mjs --development dev.spec.json --heldout ho.spec.json --out <root>/version-v1
node scripts/extraction-quality/score.mjs --dataset <root>/version-v1 --split development --outputs outputs.json [--review r.json] [--review-queue q.json] [--out report.json]
node scripts/extraction-quality/score.mjs --dataset <root>/version-v1 --split heldout --outputs outputs.json --aggregate-only
node scripts/evaluation-integrity-judge.mjs --dataset <root>/version-v1
node --test scripts/extraction-quality/score.test.mjs
```

`--aggregate-only` strips case ids, unit text and per-case rows. Use it for every
held-out report.

## Known limits

Regex term-group oracles are conservative: a correct paraphrase outside the authored
alternatives is `unverified`, not wrong, so it needs blind review rather than a silent
pass. Subtle swaps that reuse source vocabulary are caught only where the author wrote a
contradiction signature. Number parsing handles digits, separators, percent and English
number words. Datasets are versioned and never edited in place; a new `version-vN`
directory is required for any oracle change.
