# Restricted outline/clip validator R3

R3 is a new validator-only namespace. R1, R2, the frozen R4 checker, all R4
artifacts and independent-review controls remain unchanged. It applies two
corrections without changing candidate bytes, expected geometry or tolerances.

After W/W*, the next parsed operator must be a supported path terminator
(n/S/s/f/F/f*/B/B*/b/b*), with its normal operand validation. Any intervening
operator, including another subpath, state change or clipping operator, refuses
coverage. An unterminated clip also refuses coverage. The frozen checker still
validates the original clip path; unsupported compound/nonrectangular clips
remain unsupported. This deliberately rejects malformed/deferred ordering rather
than implementing additional clipping semantics.

## Precision and result semantics

MuPDF get_texttrace origins are rounded floating-point observations. The review
control with raw Tm y=710.00001 demonstrates a real 0.0000040625 pt mathematical
excursion while the trace-derived helper result has positive slack. The test
recomputes this example from raw operands and actual embedded glyph bounds.
This is one counterexample, not a global error estimate.

No justified global arithmetic/trace error bound has been established for this
restricted profile. R3 therefore takes the explicitly incomplete-evidence route:

- `mechanismCoverageComplete` describes the guarded operator/font/clip mechanisms.
- `traceObservation.noMissesAtReportedPrecision` describes only the rounded
  helper observation. The full unchanged helper result is retained as
  `frozenResult`, not promoted to a mathematical proof.
- `precision.exactConservationEvidenceComplete` is always false, and
  `precision.mathematicalNoOutlineClipLoss` and
  `precision.justifiedGlobalErrorBoundPt` are null.
- The legacy top-level `completeForObservedMechanisms` and
  `noOutlineClipMisses` gates remain false even for supported observations.
  False here means affirmative conservation evidence is withheld, not that a
  loss was proved. Status `observed-exact-incomplete` makes this explicit.

The frozen comparison threshold remains zero. No tolerance has been widened,
no near-boundary heuristic is substituted, and measured native clearance is not
used as a global bound. Even inputs with large observed clearance have incomplete
exact-conservation evidence. The CLI returns 2 for supported observations whose
exact evidence is incomplete, and 1 for refusal/unsupported. It never returns
an exact-conservation success. The revalidation driver returns 0 only for
successful collection of the expected incomplete observations and preservation
receipts, not for mathematical conservation or candidate acceptance.

## Preserved profile and tests

Signed nonzero rectangles retain endpoint/all-corner checks. The one-page,
origin-zero letter frame, default text state, positive uniform quarter-turn
similarities, embedded TrueType opaque fill and rectangular clip restrictions
remain. Tz including 50/100/200, nonuniform/sheared/singular/reflected/oblique
matrices, gs, unknown state, nested XObjects and unsupported fonts/paths refuse
coverage. Zero-area, malformed, nonfinite, oversized and precision-collapsed
rectangle geometry remains refused.

Tests retain signed paint/clip equivalence, reversed clipping loss, Tz/shear
counterexamples and native-style quarter-turn observations. Added controls cover
both deferred-hole regressions, other intervening operators, canonical W/W* n
with all four rectangle signs, and the independent precision counterexample.
Only invented controls are authored or read; no rasterizer/converter is run.

Use the pinned runtime with bytecode writing disabled:

```sh
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
export PYTHONDONTWRITEBYTECODE=1
/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-runtimes/a7/venv/bin/python core/worker/test/mixed-pdf-eval/a7/validation_r3/test_validator.py
```

The one-shot revalidation driver seals all R3 implementation files before reading
the six static originals. It binds the task-start preservation snapshot, R4
FREEZE 59 entries, nine native artifacts, R1/R2/R4 source/evidence/seals and
independent-review evidence. It checks the interpreter, installed distribution
files/bundled libraries, font and verified helper bytes before and after.
Receipts refuse overwrite. File hashes and recorded timestamps are local evidence,
not authenticated historical clocks or protection from transient replacement.
System libraries/OS and immutable in-memory dependencies are outside the pin.

There is no claim of full affine support, general clip geometry, visibility,
occlusion handling, exact zero loss, extraction quality, fixture/score acceptance,
security for hostile customer files or approval. No Git/network/APIs/delegation,
converter, candidate authoring/export or LaTeX/MathML presentation revision is
part of this change.
