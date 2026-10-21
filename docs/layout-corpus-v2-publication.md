# V2 dataset publication evidence gate

The requested dataset is being prepared for publication. It has not been publicly released. This gate reviews license/provenance evidence independently of visual quality, evaluation metrics and benchmark admission. Passing is an evidence check, not a legal guarantee.

## Staged artifacts

Canonical external directory: `/home/dan/data/docslurp-evals/layout-synthetic-v2/publication/`.

- `CONTRIBUTION-RELEASE-CANDIDATE.json`: staged CC BY 4.0 contribution declaration, attribution **DocSlurp contributors**, covering original authored synthetic text, fictional data, source layouts, annotations and contributed generated assets only to the extent rights are held. It records the coordinator's scope approval. It does not claim human authorship, exclusivity or rights over third-party material.
- `DEPENDENCY-CLEARANCES.json`: exact asset hashes, per-dependency rights, credits, modification notices, saved evidence hashes and review attribution. Generating a page does not implicitly clear an inserted image.
- `PUBLISH-MANIFEST.json`: hash-pinned candidate/native image/source/expected-Markdown/contracts, dependencies, font references, exclusion reasons and QA freshness. `publish_entries` is a rights-evidence list only; label status and any current confidence contract remain separate. No entry means public publishing has occurred.

Run after every source, asset, contract or review change:

```sh
python scripts/layout-eval/corpus_v2/publish_audit.py \
  /home/dan/data/docslurp-evals/layout-synthetic-v2 \
  --clearances /home/dan/data/docslurp-evals/layout-synthetic-v2/publication/DEPENDENCY-CLEARANCES.json \
  --output /home/dan/data/docslurp-evals/layout-synthetic-v2/publication/PUBLISH-MANIFEST.json
```

Exit 1 means at least one native page failed the rights-evidence gate; the written report still identifies all failures. The gate walks source image commands and region asset inserts, checks actual bytes against recorded hashes, requires reviewed saved rights proof and credits/change notes, and checks each QA record against the current source/image/reference/contract bytes. Changed rights receipts revoke the corresponding clearance. Unknown asset licenses fail closed.

At initial audit, 18 native pages yielded 14 rights-evidence entries; the Met, BHL and two scientific pages remained blocked pending exact saved dependency receipts. At 2026-10-21 02:01:53 UTC, reconciliation yielded **20/20 native pages rights-evidence-ready**, including the two original simulated instrument pages. Eighteen had hash-current review/confidence receipts; two had missing/stale label review. Three capture rows remained excluded pending their own transitive audit. These are dated preparation results, not a frozen final count or public release.

## Rights decisions and actual dependencies

Original synthetic editorial prose/layout and financial data were declared by the corpus author to be assistant-authored for this task rather than copied real articles. Diagrams and fictional examples must retain their source commands. Factual museum metadata is identified separately. Each new author must state which prose/data/composition is original and which is quoted, copied or inserted.

Built-in image generation assets retain prompt, tool, source image path, date where available and exact output hash. The staging declaration covers contributed rights only. [OpenAI's current terms](https://openai.com/policies/terms-of-use/) assign output rights as between OpenAI and the user to the extent permitted, but do not establish uniqueness, erase third-party rights or turn an AI scene into a documentary photograph. Preserve AI disclosure and applicable terms; do not claim a blanket rights warranty.

For the Met artwork, the [specific object API](https://collectionapi.metmuseum.org/public/collection/v1/objects/436535) identifies `isPublicDomain: true` and the exact primary-image URL. The [Met Open Access policy](https://www.metmuseum.org/policies/image-resources) makes designated images available under CC0. A saved, hashed object receipt must match the actual inserted image provenance. Retain artist, work/title/date, accession/credit and source link even when credit is not legally required by CC0.

The BHL fern scan requires actual item/page rights evidence and exact scan identity. A public URL, an 1892 date or the unverified phrase “public domain” in a local note is insufficient. Keep it blocked until the underlying institutional item record is saved and reviewed.

Magna Carta's current photograph remains inspiration-only with unconfirmed image rights. It is excluded from the publication set, even if the medieval text itself is old. Do not export the inspiration directory or copy its files through a blanket glob. The three separate National Archives founding-document scans likewise are not native authored publication entries; any future release of them requires their own rights/transcript/label audit.

Scientific formula rasters are original typesetting, not third-party page crops. Each needs a source expression/rendering receipt tied to its bytes, renderer/version/fontset and font-license notices. Academic reference PDF/page captures remain inspiration references rather than automatically redistributable dataset content. Preserve any actual CC BY reuse with original creator/source/license and modification notices.

## Export rules

Prepare a new explicit allowlisted release directory from the current manifest; never publish the whole external corpus tree. Include only selected current page images, source/annotation/expected-output files, dependency receipts, dataset contribution declaration and an `ATTRIBUTION.md` mapping each source and insert to its status and change notes. Review any source JSON absolute local paths before release and rewrite to release-relative paths without losing original provenance hashes. Stage a final integrity manifest after path rewriting.

Use [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) for the original dataset contributions only, with attribution “DocSlurp contributors.” Retain third-party CC0/public-domain status and individual CC BY notices; do not claim exclusive copyright or relicense public-domain material. CC BY requires appropriate credit, a license link and disclosure of modifications. The dataset notice does not change the repository's code license. Generator scripts and product code retain existing repository licenses, including SSPL where applicable; export source JSON and generated data separately from a generator-code release.

Do not bundle font binaries as dataset assets. Existing URW Base35/Nimbus system fonts are not CC0: the [upstream license](https://github.com/ArtifexSoftware/urw-base35-fonts/blob/master/LICENSE) is AGPL with a document-font exception. Treat source JSON font paths/hashes as reproducibility references and provide installation/version/license notes. A source/font binary distribution requires its own appropriate notices; the dataset CC BY label cannot override it. Retain STIX/Matplotlib notices for scientific typesetting receipts where applicable.

Captures need their own transitive review: parent source group and hashes, scene-generation or camera provenance, scene asset rights, calibrated transform, foreground/occlusion masks, visible-text contract, output hashes and QA. Until audited, capture rows are listed as excluded/unreviewed and are not native `publish_entries`. Capture variants never become independent original documents through licensing or changed lighting.

## Ground-truth confidence stays separate

The corpus owner is adding geometry, semantic-label, text, reading-order and occlusion confidence axes. Hash-bound per-region receipts live under `qa/confidence/`; the audit checks those against current image/source/reference bytes and lists each receipt hash. Treat 0, 0.25, 0.5, 0.75 and 1 numbers as ordinal **evidence ratings**, with a named basis, reviewer and artifact hashes; they are not calibrated probabilities, accuracy percentages or measured extraction scores. Use `null` plus a reason for a non-applicable axis. A source-derived text/formula/cell can have strong source evidence while its semantic grouping or capture visibility remains uncertain. Preserve that distinction and unresolved findings.

The publication audit records current QA hashes and passes through the confidence contract; it does not manufacture ratings, validate semantics, score quality or upgrade a pilot to gold. A rights-ready page can still have stale QA, clipped tables, unvalidated reading order or low-confidence labels. Report those as separate blocking decisions before selecting an evaluation or public release slice.
