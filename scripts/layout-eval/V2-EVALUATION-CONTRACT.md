# Fresh V2 layout experiment contract

This is preparation, not launch approval. The coordinator launches serial jobs
only after the Chinese-menu pilot, instrument partial scan, master visual review,
source contracts, license audit and strict split receipts are frozen. V1 results
remain engineering history. The existing rented-host deadline and price ceiling
remain unchanged.

Start over with six independent baselines: tiny ONNX, Heron and PP-DocLayoutV3,
each on CPU and GPU. CPU quality baselines for the larger models are required;
report their speed or explicit viability failure rather than assuming tiny is the
only CPU option. Model initialization failures, timeouts and every failed attempt
remain evidence. Record exact environment/import versions. PPv3 uses its modern
Transformers environment; GPU ORT requires the CUDA12-compatible environment and
actual assigned CUDA provider. The tiny graph is fixed-batch1/graph-defined FP32.

`V2-EXPERIMENT-PLAN.json` gives bounded phases and shared command arguments. Fill
placeholders from the frozen receipts. Independent orientation, rectification and
figure-classifier arms precede a combined profile. Isolate processor, precision,
batching and model tensor dimensions. Test bytes separately from model-size
changes: smaller uploaded images may still be expanded to the same model tensor.
Do not multiply settings into a full Cartesian grid. Any extension needs a
recorded rationale, cap and development-only admission before its outputs.

Score literal supported classes, macro F1 over truth-present labels, pooled
precision/recall/F1 at IoU0.50 and0.75, per-family and capture slices, and
class-agnostic localization F1/recall. Keep generic `figure` generic; a class-agnostic
match cannot prove photo/chart/logo recognition. Preserve polygons/native reading
order when supplied, but do not score reading order against unvalidated authored
traversal. Composite internal math/text remains component annotation, not duplicate
layout gold. Unsupported classes remain explicit and are included in all-class
limitations and false-negative reporting.

Crop references use the visible polygon/bbox. Full source boxes and complete table
cells stay provenance; invisible text is not a visible extraction target. Partial
glyph cells have unknown active transcription and explicit truncation, linked to
source-known text. Photographic occlusion likewise distinguishes known source text
from visible recoverability. Report visibility strata; do not silently discard
hard or clipped cases after looking at predictions. The full-source Markdown is
never sent to a detector or crop classifier.

Five annotation confidence axes are separate evidence-ordinal ratings, not model
probabilities or sample weights. Preserve construction/agent/human review identity
and hash-bound receipts. No confidence weighting, semantic relabeling, or quality
threshold changes are permitted after model outputs are inspected. Publish
geometric/source-text construction tiers separately from reviewed semantic-label
and physical-occlusion evidence. License clearance is an independent publication
gate, not a layout quality score.

Freeze transitive metadata-only source groups before splitting: multipage
`document_id`, native/capture/crop parent, identical image bytes and shared full
photograph/illustration assets. Reused formula or font glyph assets do not join
whole papers. `compare.py --cluster-membership PATH` consumes the authoritative
source-to-component map and join receipts; resample components, keeping captures
and repeated blocks together. Report original authored sources, effective groups,
seed, replicate count and synthetic-corpus limitations. Small family/group counts
must remain visible. A development-selected confidence interval is not independent
confirmation.

Measure the actual usable resident path with `transport_benchmark.py`, using
managed local HTTP and separate coldCLI phases in the selected runtime. This
measures raw raster bytes, response JSON parsing, identity/fingerprint verification
(outside timed inference), cold model load and caller end to end. Original files
are decoded once. For derived payloads retain producer decode/resize/encode,
consumer decode/model and total separately, plus the actual payload artifact/hash.
Loopback HTTP does not measure WAN upload time. Keep startup and failures in cost
accounting; distinguish allocated GPU-host price from CPU-only market pricing.

Absolute readiness requires held-out strict macro F1 at IoU0.50 of at least0.85
and recall of at least0.90 for EACH critical class: table, photo, chart and
paragraph. Report intervals and support. Missing class coverage cannot establish
a pass. Class-agnostic localization F1/recall nonregression remains a separate
relative guard.

Only after development finalists and exact profiles are frozen may the coordinator
admit three fresh paired holdout blocks per selected CPU/GPU profile and matched
quality reference. Blocks reuse documents; they do not triple independent evidence.
Do not use held-out outputs to change settings. Run the repository evaluation
integrity judge as its own gate before any promotion. If absolute readiness or
relative localization/semantic guards fail, say no broadly ready solution was
established and retain the measured runtime tradeoffs without promoting them.
