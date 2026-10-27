# Math encoding equivalence

`mathEncodingScorer` in `worker/test/mixed-pdf-eval/mastra-score.mjs` compares
mathematical expressions across supported encodings. It uses a shared structural
AST rather than a bag of words or substring matching. The local CLI is
`worker/test/mixed-pdf-eval/score_math.py`; neither route calls a model.

Supported subsets include explicit ASCII arithmetic, LaTeX, UnicodeMath,
presentation MathML and Office Math Markup Language (OMML). The format mappings
follow [MathML Core](https://www.w3.org/TR/mathml-core/) and Microsoft's
[MathML](https://learn.microsoft.com/en-us/office/math/mathml),
[LaTeX](https://learn.microsoft.com/en-us/office/math/latex) and
[OfficeMath](https://devblogs.microsoft.com/math-in-office/officemath/) references.
The input is an expression or math XML fragment, not an entire Office archive.

## Comparison contract

Fractions, roots, parentheses, scripts, common operators and supported alphabet
styles normalize structurally. Decimal lexical differences can represent the
same exact rational value; no floating-point rounding is used. Variable case,
operand order, grouping, numerator/denominator, subscript/superscript positions
and relation type remain significant. An equality is distinct from an
approximation. Bold or double-struck mathematical alphabets are not blindly
folded into ordinary letters.

Unknown commands, unsupported structures and ambiguous identifiers return an
explicitly unscorable result with `score: null`. They do not acquire a perfect
score or a numeric wrong-answer penalty. Sums, general functions, macros and
matrices are not currently supported. This is encoding equivalence, without
general algebraic simplification or unstated domain assumptions.

MathML presentation is authoritative; a hidden annotation cannot repair a
changed visible expression. XML parsing refuses declarations or constructs
outside its documented restricted profile and never resolves external entities.
A single leading XML 1.0 declaration and the supported OMML paragraph-alignment
wrapper are accepted; DTDs, entities, other processing instructions and unknown
properties remain refused.
Inputs are bounded to 32,768 characters, 2,048 tokens/nodes and depth 48. The
scoring CLI additionally limits requests to 128 KiB and batches to 32 pairs.

## Local use

The CLI reads JSON from stdin:

```json
{
  "reference": "\\frac{x+2}{y-3}",
  "candidate": "(𝑥+2)÷(𝑦−3)",
  "referenceEncoding": "latex",
  "candidateEncoding": "unicode"
}
```

Run it with `python worker/test/mixed-pdf-eval/score_math.py`. Encodings default
to `auto`. For a batch, supply `pairs`, each with these fields and an optional
unique `id`. The aggregate is the minimum pair score only when every pair is
supported; otherwise it remains null. Results retain canonical structures,
issues, supported-pair counts and scorer/normalizer hashes.

For the Mastra CLI, use a request file with `mode: "math"`, `reference`, `text`
and optional encoding fields. Set `MIXED_PDF_PYTHON` and run
`node worker/test/mixed-pdf-eval/mastra-score.mjs request.json`. Unsupported
expressions raise an explicit unscorable error in Mastra's numeric interface.
The existing page scorer remains available through the default/page mode.

## Evidence scope

The scorer grades expression pairs supplied to it. It does not locate a formula,
establish occurrence ownership, prove visibility or distinguish an operative
formula from a quotation. Those require independent evidence. Page-level
formula acceptance and routing-policy promotion remain closed while that
evidence is incomplete. Correct encoding alone never clears those gates.

Tests use invented expressions and format fragments, with both equivalent
cross-format pairs and changed signs, cases, grouping, relations and operands.
No dataset contents or held-out predictions are part of the normalizer.

Normalizer version 1.0.3 passes 34 test methods covering 1,115 subcases. The
integrated focused suite passes 106 tests, including CLI regressions for the
independent reviewers' counterexamples. Review-driven changes preserve nested
script bases, coalesce compatible Office Math runs, honor MathML text styles,
and refuse baseline XML script markup, unsupported double-struck italic letters,
and invalid XML characters. These corrections supersede the initial 97-test run;
the independent re-review remains a separate gate.
