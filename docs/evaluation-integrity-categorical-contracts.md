# Categorical task vocabulary in the integrity gate

A detector must know the names of its output classes. Those class names are task
vocabulary; the class assigned to a particular image region and its coordinates
are instance answers. The untyped v1 label format cannot express that distinction.
Its existing screening remains unchanged, including standalone detection of
identifier-shaped strings.

A label may now declare categorical paths explicitly:

```json
{
  "name": "regions",
  "expected": [{ "label": "category_one", "bbox": [0.12, 0.34, 0.56, 0.78] }],
  "categoricalFields": [{
    "pointer": "/*/label",
    "ontology": { "path": "ontology.json", "sha256": "<artifact SHA-256>" }
  }]
}
```

Pointers are relative to `expected`, use JSON Pointer escaping, and permit `*`
only to traverse an array. Every addressed field must exist and contain a declared
string. Overlapping declarations and category declarations on objects or numbers
fail closed. A category string appearing elsewhere, such as an extracted text
field, remains an answer to screen. Coordinates are still screened. Fixture IDs,
source hashes and copied source bytes retain their independent checks.

The external ontology artifact has this shape:

```json
{
  "schema": "docslurp-categorical-ontology@v1",
  "values": ["category_one", "category_two"],
  "contract": {
    "path": "worker/src/example-contract.ts",
    "gitCommit": "<full 40-character baseline commit>",
    "sha256": "<complete contract file SHA-256>",
    "exportName": "categories"
  },
  "provenance": {
    "author": "Contract reviewer",
    "description": "Why this is independently defined task vocabulary",
    "createdAt": "2026-10-20"
  }
}
```

The contract must be an ancestor of the gate's selected `--base`, with matching
file bytes and the exact full set of enum values. Supported syntax is deliberately
narrow: `export const categories = ["category_one", "category_two"] as const;`
(or without `as const`). The array must be valid JSON; no repository code executes.
The report records the ontology artifact hash and contract pin. This is not an
arbitrary ignore list or a file-scan exclusion.

Reviewers must establish that the chosen contract predates access to evaluation
answers. Git ancestry and hashes prove identity, not independence of authorship.
For the image layout campaign, the reviewed contract is `imageLayoutLabels` in
`worker/src/layout/image-layout.ts` at
`375851348afb5bdec606487e7276b664d35c62d8`, created before generated image answers.
The generic labels also follow the requested runtime capability. Freeze the
ontology and typed label artifacts before promotion; preserve original gate
failures and original labels. Changing this metadata must not change images,
reference geometry, selection, or scored quality results.

The gate remains a deterministic leakage screen, not a proof against arbitrary
recognition logic. Typed categories do not validate model accuracy, calibration,
or generalization. Numerical literal screening compiles a regex only after an
exact literal occurs in a file; the unchanged regex still checks boundaries.
This avoids allocating tens of thousands of unused coordinate regexes.
