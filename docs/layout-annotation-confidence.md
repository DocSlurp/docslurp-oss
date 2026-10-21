# Annotation confidence is evidence, not probability

Each region has five separate axes: `geometry`, `semanticLabel`, `textTranscription`, `visibilityOcclusion`, and `readingOrder`. Never average them into an admission score. The schema is `scripts/layout-eval/corpus_v2/confidence.schema.json`; its scale is `evidence-ordinal-not-probability`.

| Score | Evidence anchor |
|---|---|
| 0 | Unknown: no supporting evidence for this axis. |
| 0.25 | Unverified assertion, imported claim, or unaudited output. |
| 0.5 | Authored source or automatic estimate with a recorded method. |
| 0.75 | Relevant visual inspection or measurement by a named reviewer, recorded against exact artifact hashes. Agent review is identified as agent review. |
| 1 | Construction verified AND independently validated for this axis, with both receipts. This is an evidence level, never a guarantee of correctness. |
| null | Genuinely not applicable; a specific reason is mandatory. Missing evidence is 0, not null. |

Generated glyph bounds and source text start at 0.5 with their construction evidence. An independent comparison of renderer bounds against visible ink may support 1 geometry; an unrelated successful bounds check cannot. A page-level aesthetic review does not raise every region or every axis. Semantic labels remain authored/source-derived until individually reviewed. Reading order stays 0 until explicit ordering is reviewed, even when drawing commands have an order.

Text absence may be not applicable for a pure photo. Embedded text known to exist but not transcribed is unknown, not absent. Formula LaTeX is source expression evidence; it is not ordinary prose OCR. Internal diagram mathematics belongs in parent `math_components`, retaining expression and geometry without demanding a second top-level layout box.

For a raster captured on a physical page, an exact homography only verifies its mathematical mapping. Manually calibrated physical geometry is at most 0.75 after inspection. Estimated hand coverage typically starts at 0.5; reviewed coverage may reach 0.75, with the approximation recorded. Do not turn a nominal transform into certainty about visible ink. Occluded text must distinguish source-known text from visibly recoverable text. A full-source transcript cannot make hidden text visible.

A receipt pins image, source and reference SHA256 values. Reject it as stale when any pinned artifact differs. Preserve old receipts; rerenders require new receipts. Evidence records identify actor type, actor, method, scope, independence and artifacts. Model is null when its exact identity was not exposed; do not invent it. Evidence IDs referenced by axes must exist. At 1 require both construction and independent validation evidence; JSON schema alone cannot establish independence or truth, so consumers must check receipt content.

Defaults remain pending review. No human review is inferred from an agent viewing an image. Same-author agent inspection is disclosed and does not satisfy independent validation. These scores do not authorize benchmark admission, a quality claim, or deployment.
