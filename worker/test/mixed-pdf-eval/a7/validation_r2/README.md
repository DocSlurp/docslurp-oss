# Restricted outline/clip validator R2

Validator-only extension in a new namespace. R1 and every R4 artifact remain
unchanged. Signed nonzero PDF `re` extents describe an ordinary rectangle;
they do not introduce text scaling or an affine transformation. The frozen R4
helper already maps all four corners and computes min/max bounds correctly.
R2 validates those extents and delegates to those exact verified helper bytes.
No helper, expected-value or comparison-threshold change is made.

The rectangle preflight checks all operands, exact decimal endpoints, the
floating endpoints used by the frozen helper, every corner mapped through the
accumulated graphics matrix, and both bottom-up and top-down min/max bounds.
Nonfinite, out-of-profile (absolute magnitude >= 1e9), malformed, zero-area or
runtime-collapsed geometry refuses coverage. Negative width/height is accepted.

The rest of the R1 profile remains: one origin-zero unrotated letter page,
default text state, positive uniform quarter-turn similarities, embedded
TrueType opaque fill text, rectangular clips. All Tz including 50/100/200,
Ts/Tc/Tw/Tr/gs, unknown operators, nonuniform/sheared/singular/reflected or
oblique matrices, nested XObjects and unsupported fonts/clips remain refused.
The zero comparison threshold is still owned by the unchanged frozen helper.

Run using the existing pinned interpreter:

```sh
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
export PYTHONDONTWRITEBYTECODE=1
/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-runtimes/a7/venv/bin/python core/worker/test/mixed-pdf-eval/a7/validation_r2/test_validator.py
```

Tests use only independently invented K text and geometry, in the external
validation-r2/controls directory. The four width/height sign combinations are
checked for both painted and clipping rectangles with exact bound/result
comparison. Reversed top/bottom/left/right/tip clipping must still report loss.
All R1 counterexamples remain, including the independently computed Tz50 top
75.4130859375 pt versus clip top 77 pt, and its false-complete frozen result.
No existing expectation or tolerance is relaxed.

`revalidate.py` is a one-shot driver that refuses to overwrite receipts. It
rechecks all 59 R4 FREEZE entries and nine native artifacts, all R1 code/reports/
controls/seals, and all R4 code/artifacts against the task-start snapshot. It
verifies the existing runtime against the prior R4 receipt and the byte-exact
runtime lock copied from R1, then seals every new implementation file before
reading the existing six PDFs. Final receipts recheck protected artifacts,
new sealed code, helper and runtime/dependency bytes after inspection. The
runtime lock binds the interpreter, installed distribution files including
bundled native libraries, and the control font. Embedded candidate font hashes
are retained by the unchanged frozen checker.

Results are restricted outline-vs-clip observations, without extraction,
fixture/score acceptance or occlusion claims. This is local offline tooling,
not a hostile-customer-file security boundary. System libraries and OS remain
outside a hermetic pin; before/after hashes do not defeat transient adversarial
filesystem replacement. Full affine outlines and general clip geometry remain
unsupported. No Git, network, APIs, delegation, converters, PDF rewrites,
candidate authoring or candidate exports are used.
