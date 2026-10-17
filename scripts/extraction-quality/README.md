# Extraction quality lab: dataset builder and scorer

Offline, deterministic oracles for three extraction artifacts: a **graph** of directed
relationships, factual **key points**, and a one-paragraph **summary**. No model or API call
is made anywhere in this directory. Evaluation integrity rules from `AGENTS.md` apply:
sources and gold live **outside** the repository, the generator and scorer are generic,
and `scripts/evaluation-integrity-judge.mjs` runs as a separate gate.

Files: `build-dataset.mjs` (compile authored specs to a frozen dataset), `score.mjs`
(scorer, review queue, CLI), `score.test.mjs` (sentinel tests on synthetic data only).
The runner may read each split's `integrity-manifest.json` (source paths and hashes) and
`<id>.txt`; both manifest forms stay stable.

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
  <id>.gold.json             {schema, labels:[{name,expected}]}: oracle. Scorer only.
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
A key point may be a string or `{ "text": "...", ...extra }` (for example a paragraph id).
A case value may be an **array of outputs** (independent generations of the same case);
each generation is scored separately and pooled. A missing case scores zero. Extra fields
are ignored. Envelope problems are diagnostics only.

## Rubric

**Primary: semantic correctness** (these decide acceptance).

| Metric | Definition |
| --- | --- |
| Graph precision / recall / F1 | Edges are `(source, predicate, target)` after entity-alias resolution. Predicted edges are de-duplicated. Recall counts gold relations covered by any frozen predicate alias, an inverse predicate with endpoints swapped, or either orientation for `symmetric` relations. Reciprocal relations are two gold edges. A reversed edge never matches a directed relation. |
| Contradicted edges (gate) | Reversed directed edges, forbidden (outdated, negated, false) relations. Any count above zero fails the case. |
| Unsupported edges | Every unmatched edge, classed `contradicted` or `unmatched` (reason `unresolved-endpoint` when an endpoint is not a gold entity). Unmatched edges are not proven false; they are queued for blind review. In `noRelations` control cases every edge is unsupported. Pooled and macro precision and recall are both reported. Deterministic recall only credits frozen predicate aliases; a reviewer can additionally credit a missed relation through a supported covering edge (see Adjudication). |
| Fact coverage | Gold atomic facts are **exhaustive** for key points. The summary is scored only on the facts flagged `salient` (a short, distinct subset: the document's purpose and its decisive facts), so long documents are not forced to exceed the `summaryWordLimit`. A fact matches when its subject/predicate/object term groups co-occur in one sentence (ordered when the fact requires order), required numbers are present, and polarity agrees. |
| Contradictions (gate) | Wrong or missing-for-anchor numbers, negation/polarity flips, authored contradiction signatures (reversed roles, outdated-as-current, wrong qualifier), forbidden claims. Any count above zero fails the case. Number and polarity flags are scorer **heuristics** (`origin: heuristic`) and a reviewer may overrule one; signatures and forbidden claims are authored label facts (`origin: authored`) and cannot be overruled by review. |
| Unsupported / unverified units | A sentence is `supported` only if it matches a fact **and** every content word and number in it lies in the lexicon of the facts it matched (their authored evidence quotes, statement, extras) or in the case entity names. Matching a fact does not hide an appended claim: leftover terms or numbers make the sentence `unverified`. A sentence matching no fact is `unverified` (listing `novelTerms` that appear nowhere in the case). |
| Soundness | supported units divided by scored units. Unverified units count against it. |
| Artifact score | F1 of fact coverage and soundness (graph: edge F1). Case score is the mean of the three artifact scores; aggregate `primary` is the macro mean across cases. |

**Secondary diagnostics** (never gate): envelope validity, summary on one paragraph (no
newline or list markers), summary within `summaryWordLimit` words, entity recall,
duplicate key points.

### Verdict ladder (deterministic matching cannot prove arbitrary claim support)

1. `fail`: any contradiction or contradicted edge, a missing case, an empty key-point or
   summary artifact, or a reviewer-confirmed unsupported or contradicted item. Without an
   accepted review verdict a flagged contradiction **always fails**, and an unreviewed
   unsupported addition is never `supported` (it keeps soundness and the
   `unsupportedUnits` target failing). Structural graph contradictions (reversed,
   forbidden, self-loop) and authored-signature flags cannot be cleared by any review;
   fix the oracle in a new dataset version instead.
2. `needs-review`: no failure, but unverified units, unmatched edges, missed facts or
   relations, or no valid review. Nothing is called supported or covered by default.
3. `pass`: no failure and a valid review file (blind: reviewer saw no candidate identity
   or deterministic verdict; independent of the dataset author) that gives an accepted
   verdict for every queued item. `pass` attests that the evidence is valid, not that
   the targets are met: `aggregate.targets` reports the frozen plan thresholds
   separately (graph precision >= 0.95 and recall >= 0.90; key-point and summary
   coverage >= 0.90; zero contradictions; zero unsupported units), computed on reviewed
   numbers when a review is supplied. `deterministic` repeats the aggregate without any
   review, so reviewed and unreviewed numbers always sit side by side.

`score.mjs --review-queue <path>` writes the queue (items shuffled, no scores, no
candidate labels, no flag detail); `--review <file>` applies verdicts.

### Adjudication (review schema v2, scorer `extraction-quality-scorer@v2`)

The queue holds four item types. Every item carries `sourceSha256` and `itemSha256`
(a hash over the item's full content and, for items that can overrule the scorer, the
exact artifact it was produced from).

| Item | Queued when | Verdicts |
| --- | --- | --- |
| `unit` | a key point or summary sentence is `unverified`, **or** it carries a heuristic contradiction flag (the two look identical to the reviewer) | `supported`, `unsupported`, `contradicted` |
| `edge` | an output edge matches no gold relation and is not structurally contradicted | `supported`, `unsupported`, `contradicted` |
| `fact` | a gold fact was not matched in a non-empty artifact | `covered`, `not-covered` |
| `relation` | a gold relation was missed **and** the graph has at least one unmatched edge that could cover it; carries the relation, its evidence quotes and the candidate edges | `covered`, `not-covered` |

```json
{ "schema": "docslurp-quality-review@v2", "reviewer": "name", "blind": true, "independentOfAuthor": true,
  "items": { "<itemId>": { "verdict": "supported", "itemSha256": "<copied from the item>",
                           "evidence": ["verbatim source quote"], "rationale": "optional",
                           "coveredBy": "<edge itemId, relation items only>" } } }
```

A bare string verdict (the `@v1` format, still accepted) works exactly as before for
`unit`, `edge` and `fact` items that the scorer did not flag. It can never overrule the
scorer. A verdict that would overrule the scorer is accepted only when **all** hold,
and is otherwise listed under `review.rejected` with a reason while the scorer's
decision stands:

- the file is `@v2`, blind and independent, with a verdict from the item's vocabulary;
- `itemSha256` matches the current queue item (`missing-binding`, `stale-binding`): the
  verdict is bound to the exact source and the exact artifact, so a changed output or
  source invalidates it;
- `evidence` has at least one verbatim quote from the case source (`missing-evidence`,
  `evidence-not-in-source`, `source-unavailable`; quotes are compared case- and
  whitespace-insensitively and must be at least 15 characters);
- relation `covered` names `coveredBy`, one of that item's candidate edges
  (`bad-covered-by`), the same review judges that edge `supported`
  (`covering-edge-not-supported`), and no edge covers two relations
  (`edge-already-covers-another-relation`).

Negative verdicts (`unsupported`, `contradicted`, `not-covered`) only lower a score, so
they need no evidence, and a stale hash is still rejected.

Effects: `supported` on a flagged unit counts it supported (`aggregate.adjudication.flagsOverruled`);
`unsupported` makes it a confirmed unsupported unit; `contradicted` (also on any unit or
edge) is a confirmed contradiction. `covered` on a relation adds it to recall; it never
changes precision, which depends on the covering edge's own `supported` verdict.
`review.adjudications` itemises every accepted verdict on a flag or relation (reviewer,
hash, evidence, covering edge); `review.rejected` itemises the rest. Held-out
`--aggregate-only` reports keep counts only.

Gold relation and evidence text appear in `relation` items so a reviewer can judge
coverage; the reviewer still never sees candidate identity or scorer decisions. Treat a
held-out queue as sensitive and never feed it back to a tuner. Heuristic detection
itself (negation cues, number matching) is unchanged: this version adds a way to
adjudicate flags, not a looser gate.

#### Migrating from `@v1` reviews

`@v1` reviews remain valid and every existing item id is unchanged, so a baseline can be
re-scored with identical deterministic numbers (`deterministic` and the unreviewed
aggregate match the `@v1` scorer apart from the added fields and the larger queue).
What changes is that previously unreviewable items now appear in the queue and stay
**open** until re-reviewed: heuristic-flagged units (blind `unit` items) and missed
relations (`relation` items). Regenerate the queue with the current scorer for every
run, give the new `unit` and `relation` items (and, preferably, all `supported` and
`covered` verdicts) to an independent blind reviewer in the `@v2` format, merge the
reviewer's `@v1` verdicts for the unchanged items if they are still valid, and re-score.
Never copy verdicts across runs: the hashes will not match and the scorer will say so.

## Commands

```
node scripts/extraction-quality/build-dataset.mjs --development dev.spec.json --heldout ho.spec.json --out <root>/version-v1
node scripts/extraction-quality/score.mjs --dataset <root>/version-v1 --split development --outputs outputs.json [--review r.json] [--review-queue q.json] [--out report.json]
node scripts/extraction-quality/score.mjs --gold <id>.gold.json --output output.json --source <id>.txt [--review r.json]   # single case; --source enables v2 overrides
node scripts/extraction-quality/score.mjs --dataset <root>/version-v1 --split heldout --outputs outputs.json --aggregate-only
node scripts/evaluation-integrity-judge.mjs --dataset <root>/version-v1
node --test scripts/extraction-quality/score.test.mjs
```

`--aggregate-only` strips case ids, unit text and per-case rows. Use it for every
held-out report.

## Known limits

Regex term-group oracles are conservative: a correct paraphrase outside the authored
alternatives is `unverified`, not wrong, so it needs blind review rather than a silent
pass. Negation is detected from a cue word list around the matched span, so a true
lexical negation ("withheld consent") or a cue outside the span raises a heuristic
flag; such a flag fails until a reviewer overrules it. Evidence quotes prove that the
cited text exists, not that it supports the claim: the reviewer's independence is
attested, not verified. Subtle swaps that reuse source vocabulary are caught only where the author wrote a
contradiction signature. Number parsing handles digits, separators, percent and English
number words. Datasets are versioned and never edited in place; a new `version-vN`
directory is required for any oracle change.
