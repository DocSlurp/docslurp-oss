# Restricted outline/clip validation R1

Validator-only tooling correction. Rounds 1–4, candidate bytes and original R4
helper remain frozen. No converter, export, candidate authoring, network, API,
Git, holdout or customer input is used by this workflow.

Use the existing pinned interpreter, with `PYTHONDONTWRITEBYTECODE=1`:

```sh
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
export PYTHONDONTWRITEBYTECODE=1
/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-runtimes/a7/venv/bin/python core/worker/test/mixed-pdf-eval/a7/validation_r1/test_validator.py
/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-runtimes/a7/venv/bin/python core/worker/test/mixed-pdf-eval/a7/validation_r1/validator.py /absolute/input.pdf
```

`revalidate.py` is a one-shot evidence workflow. It refuses to overwrite its
seal or final receipts. It verifies installed dependency files against both the
new runtime lock and the prior R4 runtime receipt, seals the implementation,
reads the six existing native PDFs, and rehashes all 59 FREEZE entries plus nine
native artifacts. Evidence belongs only in the external `validation-r1` folder.
The seal covers every immediate implementation file, including tests, this
README, runtime lock and revalidation driver. It is written before PDF revalidation.

The wrapper verifies frozen helper SHA-256
`93e8e94f53e1b1801499b839753f3ed0e04bb28310d469fbc34f8611ab370dc7`
and executes those exact bytes in memory, without importing/writing beside the
frozen file. Runtime and control font hashes are checked on every inspection.
Python optimization is refused because the frozen helper uses assertions.

## Accepted scope

One unrotated origin-zero 612 × 792 pt page; default user unit; positive font
sizes; finite, bounded coordinates; exact positive uniform similarities limited
to quarter-turn rotations, including nested graphics transforms. Identity and
uniform scaling are accepted. Rotated native labels remain in this profile.
The helper checks opaque fill text using embedded TrueType outlines, exact
GID/ToUnicode sequence binding and active axis-aligned rectangular clips.
Nonrectangular paint paths may occur but cannot establish accepted clips.
No text or outline checks are vacuously awarded to empty pages.

## Explicit refusals and limitations

All `Tz` (including 50, 100 and 200), `Ts`, `Tc`, `Tw`, `Tr`, `gs`, shorthand
text shows, nested XObjects and unknown operators refuse coverage. Nonuniform,
sheared, reflected, singular and non-quarter-turn matrices refuse coverage,
with no numerical tolerance that can admit a small shear. Nonfinite, oversized,
malformed, nonpositive rectangle geometry, parser warnings, recovery, annotations,
optional content, unsupported fonts, text rendering and clips fail closed.
Unsupported results always expose both coverage/no-miss booleans as false;
failures include type/message and instruction/operator where available.

This intentionally incomplete profile does not implement full affine outlines,
text-state support, general clip geometry, occlusions, extraction validation,
score/fixture acceptance or a security boundary for hostile customer files.
System shared libraries and OS are not hermetically pinned; interpreter and
all installed distribution files (including bundled native libraries) are hashed.
Post-read hashes detect persistent changes, not adversarial transient filesystem
replacement. Use only the authorized static local native/control inputs.

Controls contain only invented `K` text and geometry. Their source is
`test_validator.py`; they are not derived from candidate content. Tests prove
top/bottom/left/right/nested misses, positive/uniform/quarter-turn handling,
explicit unsupported-state refusals, and reproduce the frozen Tz50 false
complete result. The independent font-outline calculation gives true top
75.4130859375 pt, outside the 77 pt clip top by 1.5869140625 pt. The initial test
harness lookup failure is retained in `test-output-initial-failure.txt`.
