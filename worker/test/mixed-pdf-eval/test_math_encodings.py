"""Invented in-memory controls only; no corpus, held-out data or network access."""

import itertools
import unittest

from math_encodings import (
    MAX_DEPTH, MAX_LENGTH, MAX_NODES, MAX_TOKENS, VERSION,
    compare_math, normalize_math,
)

M = "http://www.w3.org/1998/Math/MathML"
O = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def mathml(body):
    return f'<math xmlns="{M}">{body}</math>'


def omml(body):
    return f'<m:oMath xmlns:m="{O}">{body}</m:oMath>'


def run(text, normal=False):
    props = '<m:rPr><m:nor/></m:rPr>' if normal else ''
    return f'<m:r>{props}<m:t>{text}</m:t></m:r>'


def fraction(numerator, denominator):
    return f'<m:f><m:num>{numerator}</m:num><m:den>{denominator}</m:den></m:f>'


def script(base, sub=None, sup=None):
    kind = 'sSubSup' if sub is not None and sup is not None else ('sSub' if sub is not None else 'sSup')
    parts = f'<m:e>{base}</m:e>'
    if sub is not None:
        parts += f'<m:sub>{sub}</m:sub>'
    if sup is not None:
        parts += f'<m:sup>{sup}</m:sup>'
    return f'<m:{kind}>{parts}</m:{kind}>'


class MathEncodingsTest(unittest.TestCase):
    def equivalent(self, left, right, **kwargs):
        result = compare_math(left, right, **kwargs)
        self.assertTrue(result['supported'], result)
        self.assertTrue(result['equivalent'], result)
        self.assertEqual(result['score'], 1.0)
        self.assertEqual(result['issues'], [])

    def different(self, left, right):
        result = compare_math(left, right)
        self.assertTrue(result['supported'], result)
        self.assertFalse(result['equivalent'], result)
        self.assertEqual(result['score'], 0.0)

    def unsupported(self, text, encoding='auto'):
        result = normalize_math(text, encoding)
        self.assertFalse(result['supported'], result)
        self.assertIsNone(result['ast'])
        self.assertIsNone(result['canonical'])
        self.assertTrue(result['issues'])
        for other in ('x', text):
            comparison = compare_math(other, text, actual_encoding=encoding)
            self.assertFalse(comparison['supported'], comparison)
            self.assertIsNone(comparison['equivalent'])
            self.assertIsNone(comparison['score'])

    def test_public_contract(self):
        self.assertIsInstance(VERSION, str)
        normalized = normalize_math('x')
        self.assertEqual(normalized['ast'], ('symbol', 'x', 'italic'))
        self.assertEqual(normalized['encoding'], 'ascii')
        self.assertEqual(normalized['format'], 'ascii')
        self.assertEqual(normalized['canonical'], '["symbol","x","italic"]')
        self.assertIn('expected', compare_math('x', 'x'))
        self.assertIn('actual', compare_math('x', 'x'))

    def test_quotient_cross_format_matrix(self):
        forms = [
            '(x+2)/(y-3)', r'\frac{x+2}{y-3}', r'\dfrac{x+2}{y-3}',
            r'\tfrac{x+2}{y-3}', '(𝑥+2)÷(𝑦−3)',
            mathml('<mfrac><mrow><mi>x</mi><mo>+</mo><mn>2</mn></mrow>'
                   '<mrow><mi>y</mi><mo>−</mo><mn>3</mn></mrow></mfrac>'),
            omml(fraction(run('x+2'), run('y−3'))),
        ]
        for left, right in itertools.product(forms, repeat=2):
            with self.subTest(left=left, right=right):
                self.equivalent(left, right)

    def test_weighted_indices_matrix(self):
        forms = [
            'w_i*x_i^2', r'w_{i}\cdot x_{i}^{2}', 'wᵢ×xᵢ²',
            mathml('<msub><mi>w</mi><mi>i</mi></msub><mo>×</mo>'
                   '<msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup>'),
            omml(script(run('w'), run('i')) + run('×') + script(run('x'), run('i'), run('2'))),
        ]
        for left, right in itertools.product(forms, repeat=2):
            with self.subTest(left=left, right=right):
                self.equivalent(left, right)

    def test_named_subscripts_units_matrix(self):
        forms = [
            r'x_{\mathrm{ref}}\cdot\mathrm{kg}',
            mathml('<msub><mi>x</mi><mi mathvariant="normal">ref</mi></msub>'
                   '<mo>·</mo><mi>kg</mi>'),
            omml(script(run('x'), run('ref', True)) + run('×') + run('kg', True)),
        ]
        for left, right in itertools.product(forms, repeat=2):
            with self.subTest(left=left, right=right):
                self.equivalent(left, right)

    def test_parentheses_matrix(self):
        forms = [
            '2*(x+y)', r'2\left(x+y\right)', '2×(𝑥+𝑦)',
            mathml('<mn>2</mn><mo>×</mo><mo>(</mo><mi>x</mi><mo>+</mo><mi>y</mi><mo>)</mo>'),
            omml(run('2×') + '<m:d><m:e>' + run('x+y') + '</m:e></m:d>'),
        ]
        for left, right in itertools.product(forms, repeat=2):
            with self.subTest(left=left, right=right):
                self.equivalent(left, right)

    def test_numeric_lexical_variants(self):
        forms = ['001.2500', '1.25', mathml('<mn>01.250</mn>'), omml(run('1.25000'))]
        for left, right in itertools.product(forms, repeat=2):
            with self.subTest(left=left, right=right):
                self.equivalent(left, right)
        self.equivalent('.5', '0.500')
        self.equivalent('000', '0.0')
        self.different('0.100000000000000000001', '0.100000000000000000002')

    def test_greek_and_style(self):
        self.equivalent(r'\alpha+\beta', 'α+β')
        self.equivalent(r'\Gamma', mathml('<mi mathvariant="normal">Γ</mi>'))
        self.different(r'\Gamma', '𝛤')
        self.equivalent(r'\phi+\varphi', 'ϕ+φ')
        self.equivalent('𝑥', 'x')
        self.equivalent('ℎ', 'h')
        self.equivalent('𝐱', r'\mathbf{x}')
        self.equivalent(r'\mathbb{R}', mathml('<mi mathvariant="double-struck">R</mi>'))
        self.different(r'\mathrm{x}', 'x')
        self.different(r'\mathbf{x}', 'x')
        self.different(r'\mathrm{xy}', 'x*y')
        self.different(r'\mathit{xy}', r'\mathrm{xy}')
        self.different(r'\phi', r'\varphi')

    def test_roots(self):
        self.equivalent(r'\sqrt{x+1}', mathml('<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>'))
        self.equivalent(r'\sqrt[3]{x}', mathml('<mroot><mi>x</mi><mn>3</mn></mroot>'))
        self.different(r'\sqrt{x}', r'\sqrt[3]{x}')

    def test_envelopes_spacing_aliases(self):
        for expression in ('$x+1$', '$$x+1$$', r'\(x+1\)', r'\[x+1\]', r'x\, +\quad 1'):
            with self.subTest(expression=expression):
                self.equivalent(expression, 'x+1')
        self.equivalent(r'\frac{1}{2}', '1/2', expected_encoding='latex', actual_encoding='plain')
        self.equivalent('x²', 'x^2', expected_encoding='unicodemath')
        self.equivalent(omml(run('x')), 'x', expected_encoding='ooml')

    def test_precedence_unary_and_scripts(self):
        self.equivalent('x+y*z', 'x+(y*z)')
        self.equivalent('-x^2', '-(x^2)')
        self.equivalent('x_i^2', 'x^2_i')
        self.equivalent('xₙⁱ', 'x_n^i')
        self.equivalent('x_1', omml(script(run('x'), run('1'))))
        self.equivalent('x^2', omml(script(run('x'), sup=run('2'))))
        self.equivalent('w_i x_i', 'w_i*x_i')
        self.different('-x^2', '(-x)^2')
        self.different('x/(y/z)', 'x/y/z')
        self.different('x-(y-z)', 'x-y-z')

    def test_meaning_changes(self):
        cases = [
            ('x+1', 'x-1'), ('x/y', 'y/x'), ('x/(y+1)', 'x/y+1'),
            ('(x+y)*z', 'x+y*z'), ('x', 'X'), ('x+1', 'x+1+y'),
            ('x=y', 'x≈y'), ('x≤y', 'x<y'), ('x≥y', 'x>y'), ('x≡y', 'x=y'),
            ('x_i', 'x^i'), ('x^2', 'x^3'), ('x_i', 'x_j'), ('x_n', 'x_N'),
            ('x+y', 'y+x'), ('1/2', '.5'), ('x*1', 'x'), ('x+x', '2*x'),
            ('x+y', 'x+y+0'),
        ]
        for left, right in cases:
            with self.subTest(left=left, right=right):
                self.different(left, right)

    def test_mathml_hidden_annotation_is_not_authoritative(self):
        misleading = mathml('<semantics><mrow><mi>x</mi><mo>−</mo><mn>1</mn></mrow>'
                            '<annotation encoding="application/x-tex">x+1</annotation></semantics>')
        self.different('x+1', misleading)
        self.equivalent('x-1', misleading)
        self.unsupported(mathml('<semantics><merror/><annotation>x+1</annotation></semantics>'))

    def test_mathml_mrow_follows_visible_precedence(self):
        self.equivalent('x+y*z', mathml('<mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>'
                                      '<mo>×</mo><mi>z</mi>'))

    def test_omml_paragraph_normal_style_and_delimiters(self):
        para = f'<m:oMathPara xmlns:m="{O}"><m:oMath>{run("x")}</m:oMath></m:oMathPara>'
        self.equivalent(para, 'x')
        self.equivalent(omml(run('x', True)), r'\mathrm{x}')
        self.equivalent(omml(run('2', True)), '2')
        delimiter = '<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>' + run('x+1') + '</m:e></m:d>'
        self.equivalent(omml(run('2×') + delimiter), '2*(x+1)')

    def test_unsupported_text(self):
        for expression in ('', ' ', 'x+', 'x/', 'x^', 'x_', '(x', 'x)', '()', '$', '$x',
                           'xy', 'mass', r'\unknown{x}', r'\def\x{1}', r'\input{path}',
                           r'\sum_{i=1}^n x_i', 'x≈', 'x–y', '1e3', '1.2.3',
                           '1 2', 'f(x)', r'x^12', 'x^^2', 'x_i_j', 'x^2^3',
                           r'\left.x\right)', r'\mathrm{x+y}', 'x!=y', 'x<=y'):
            with self.subTest(expression=expression):
                self.unsupported(expression, 'tex' if expression == r'x^12' else 'auto')
        self.unsupported('x', 'invented-format')
        self.unsupported('α', 'ascii')
        self.unsupported(None)

    def test_unsupported_mathml(self):
        for body in (
            '<mfrac><mi>x</mi></mfrac>', '<msubsup><mi>x</mi><mi>i</mi></msubsup>',
            '<mfrac linethickness="0"><mi>x</mi><mi>y</mi></mfrac>',
            '<mi mathvariant="invalid">x</mi>', '<mi custom="yes">x</mi>',
            '<mo form="prefix">−</mo><mi>x</mi>', '<mi>x</mi><mo>⁡</mo><mi>y</mi>',
            '<mphantom><mi>x</mi></mphantom>', '<mrow>lost<mi>x</mi></mrow>',
            '<mrow><mi>x</mi>lost</mrow>', '<mrow>lost</mrow>', '<mi/>', '<mn>NaN</mn>',
            '<mi xmlns="urn:other">x</mi>', '<mi>x<mi>y</mi></mi>',
            '<semantics><mi>x</mi><annotation-xml><mi>y</mi></annotation-xml></semantics>',
        ):
            with self.subTest(body=body):
                self.unsupported(mathml(body))
        self.unsupported('<math><mi>x</math>')
        self.unsupported('<wrong><mi>x</mi></wrong>')
        self.unsupported('<math xmlns="urn:other"><mi>x</mi></math>')
        self.equivalent('<math><mi>x</mi></math>', 'x')

    def test_unsupported_omml(self):
        for body in (
            '<m:f><m:den>' + run('x') + '</m:den><m:num>' + run('y') + '</m:num></m:f>',
            '<m:f>' + run('x') + '</m:f>', '<m:nary/>',
            '<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>x</m:t></m:r>',
            '<m:r><m:rPr><m:nor m:val="0"/></m:rPr><m:t>x</m:t></m:r>',
            '<m:r><m:t unknown="yes">x</m:t></m:r>', '<m:r><m:t/></m:r>',
            '<m:d><m:e>' + run('x') + '</m:e><m:e>' + run('y') + '</m:e></m:d>',
            '<m:d><m:dPr><m:begChr m:val="|"/></m:dPr><m:e>' + run('x') + '</m:e></m:d>',
            '<m:r><m:t xmlns:m="urn:other">x</m:t></m:r>',
        ):
            with self.subTest(body=body):
                self.unsupported(omml(body))
        self.unsupported('<oMath><r><t>x</t></r></oMath>', 'omml')

    def test_xml_declarations_entities_and_malformed_input(self):
        for text in (
            '<!DOCTYPE math [<!ENTITY x "x">]><math><mi>&x;</mi></math>',
            '<!DOCTYPE math SYSTEM "file:///private"><math><mi>x</mi></math>',
            '<math><!-- hidden --><mi>x</mi></math>', '<math><mi>&#120;</mi></math>',
            '<math><mi>&amp;</mi></math>', '<math><mi>x</mi></math>tail',
            '<math><mi>x</mi></math><math><mi>y</mi></math>',
        ):
            with self.subTest(text=text):
                self.unsupported(text)

    def test_exported_xml_declarations_cross_format(self):
        exports = [
            mathml('<mfrac><mrow><mi>x</mi><mo>+</mo><mn>2</mn></mrow>'
                   '<mrow><mi>y</mi><mo>−</mo><mn>3</mn></mrow></mfrac>'),
            omml(fraction(run('x+2'), run('y−3'))),
        ]
        declarations = []
        for quote, encoding, standalone in itertools.product(
                ('"', "'"), (None, 'UTF-8', 'UTF-16'), (None, 'yes', 'no')):
            attributes = [('version', '1.0')]
            if encoding is not None:
                attributes.append(('encoding', encoding))
            if standalone is not None:
                attributes.append(('standalone', standalone))
            declarations.append('<?xml ' + ' '.join(
                f'{key}={quote}{value}{quote}' for key, value in attributes) + '?>')
        declarations.extend([
            '<?xml\tversion = "1.0"\nencoding = "utf-8"\rstandalone = "no" ?>',
            "<?xml version='1.0' encoding='utf-16'?>",
        ])
        for declaration, export in itertools.product(declarations, exports):
            with self.subTest(declaration=declaration, export=export):
                self.equivalent(r'\frac{x+2}{y-3}', declaration + '\n' + export)
                self.equivalent(declaration + export, '(𝑥+2)÷(𝑦−3)')

    def test_invalid_xml_declaration_envelopes(self):
        document = mathml('<mi>x</mi>')
        good = '<?xml version="1.0" encoding="UTF-8"?>'
        malformed = [
            '<?xml?>', '<?xml version="1.1"?>', '<?xml version="1.00"?>',
            '<?XML version="1.0"?>', '<?xml Version="1.0"?>',
            '<?xml version=1.0?>', '<?xml version="1.0\'?>',
            '<?xml version="1.0" encoding="UTF-32"?>',
            '<?xml version="1.0" encoding="UTF-8\'?>',
            '<?xml encoding="UTF-8" version="1.0"?>',
            '<?xml version="1.0" standalone="YES"?>',
            '<?xml version="1.0" standalone="maybe"?>',
            '<?xml version="1.0" standalone="no" encoding="UTF-8"?>',
            '<?xml version="1.0" extra="ignored"?>',
            '<?xml version="1.0" version="1.0"?>',
            '<?xml version="1.0" encoding="UTF-8" encoding="UTF-8"?>',
            '<?xml version="1.0" standalone="yes" standalone="yes"?>',
            '<?xml\vversion="1.0"?>', '<?xml version="1.0" /?>',
            '<?xml version="1.0" encoding="&encoding;"?>',
        ]
        attempts = [prefix + document for prefix in malformed] + [
            ' \n' + good + document,
            good + good + document,
            '<?other ignored?>' + document,
            good + '<?other ignored?>' + document,
            good + mathml('<mi>x</mi><?other ignored?>'),
            good + document + '<?other ignored?>',
            good + document + good,
            good + '<!DOCTYPE math SYSTEM "file:///private">' + document,
            good + '<!DOCTYPE math [<!ENTITY x SYSTEM "https://invalid.example/x">]>' +
            mathml('<mi>&x;</mi>'),
            good + mathml('<mi>&#120;</mi>'),
            good + mathml('<mi>&amp;</mi>'),
            good,
        ]
        for text in attempts:
            with self.subTest(text=text):
                self.unsupported(text)

    def test_omml_paragraph_alignment_cross_format(self):
        equation = omml(fraction(run('x+2'), run('y−3')))
        for value in ('center', 'centerGroup', 'left', 'right'):
            paragraph = (f'<m:oMathPara xmlns:m="{O}"><m:oMathParaPr>'
                         f'<m:jc m:val="{value}"/></m:oMathParaPr>{equation}</m:oMathPara>')
            with self.subTest(alignment=value):
                self.equivalent(r'\frac{x+2}{y-3}', paragraph)
                self.equivalent('(𝑥+2)÷(𝑦−3)', '<?xml version="1.0"?>' + paragraph)
                self.different('(x+2)/(y+3)', paragraph)

    def test_invalid_omml_paragraph_properties(self):
        equation = omml(run('x'))
        good = '<m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>'
        properties = [
            '<m:oMathParaPr/>',
            '<m:oMathParaPr><m:jc/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="unknown"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="Center"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc val="center"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc xmlns:m="urn:foreign" m:val="center"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center"/><m:jc m:val="left"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:unknown/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center"/><m:nor/></m:oMathParaPr>',
            '<m:oMathParaPr m:unknown="ignored"><m:jc m:val="center"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center" m:unknown="ignored"/></m:oMathParaPr>',
            '<m:oMathParaPr>lost<m:jc m:val="center"/></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center">lost</m:jc></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center"/>lost</m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center"><m:jc m:val="center"/></m:jc></m:oMathParaPr>',
            '<m:oMathParaPr><m:jc m:val="center" val="left"/></m:oMathParaPr>',
        ]
        bodies = [prop + equation for prop in properties] + [
            good + good + equation, equation + good, good + equation + equation,
            good, '<m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:r><m:t>x</m:t></m:r>',
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.unsupported(f'<m:oMathPara xmlns:m="{O}">{body}</m:oMathPara>')
        self.unsupported(omml(good + run('x')))

    def test_math_alphabet_and_script_case(self):
        self.equivalent('ℝ', r'\mathbb{R}')
        self.equivalent('ℬ', r'\mathcal{B}')
        self.equivalent('ℭ', r'\mathfrak{C}')
        self.equivalent('𝜖', r'\epsilon')
        self.equivalent('𝜀', r'\varepsilon')
        self.equivalent('𝜙', r'\phi')
        self.equivalent('𝜑', r'\varphi')
        self.different('𝜖', '𝜀')
        self.different('𝚹', '𝚯')
        self.equivalent('xᴺ', 'x^N')
        self.equivalent('xⁿ', 'x^n')
        self.equivalent('xᵃ', 'x^a')
        self.equivalent('xᶻ', 'x^z')
        self.equivalent('xᵂ', 'x^W')
        self.different('xᴺ', 'xⁿ')
        self.unsupported(mathml('<mi>𝐱y</mi>'))

    def test_tex_lexical_and_layout_ambiguity(self):
        for text in ('x^02', 'x^2.0', 'x^.5', 'x^(y+1)',
                     r'\frac01{2}', '{x+y}', r'x*{y+z}',
                     r'\operatorname{sin} x', r'\mathrm{sin} x',
                     r'\left(x)', r'(x\right)', r'\left(x\right]'):
            with self.subTest(text=text):
                self.unsupported(text, 'tex')
        self.equivalent(r'x^{02}', 'x^2')
        self.equivalent(r'x^{2.0}', 'x^2')
        self.equivalent('x^(y+1)', r'x^{y+1}')

    def test_xml_properties_cannot_disappear(self):
        controls = [
            omml('<m:num>' + run('x') + '</m:num>'),
            omml('<m:d><m:dPr>discarded</m:dPr><m:e>' + run('x') + '</m:e></m:d>'),
            omml('<m:r><m:rPr><m:nor>discarded</m:nor></m:rPr><m:t>x</m:t></m:r>'),
            omml('<m:r><m:rPr><m:nor m:val="0" val="1"/></m:rPr><m:t>x</m:t></m:r>'),
            mathml('<mi xmlns:q="' + M + '" q:mathvariant="normal">x</mi>'),
            '<math><mi>\ud800</mi></math>',
        ]
        for text in controls:
            with self.subTest(text=repr(text)):
                self.unsupported(text)

    def test_limits(self):
        self.unsupported('x' * (MAX_LENGTH + 1))
        self.unsupported('(' * (MAX_DEPTH + 1) + 'x' + ')' * (MAX_DEPTH + 1))
        self.unsupported(mathml('<mrow>' * MAX_DEPTH + '<mi>x</mi>' + '</mrow>' * MAX_DEPTH))
        self.unsupported(mathml('<mi>x</mi>' * MAX_NODES))
        self.unsupported('+'.join('x' for _ in range(MAX_TOKENS)))
        self.unsupported('x+' * 100 + 'x')  # left-deep AST, even if parser recursion is shallow
        self.equivalent('('*8 + 'x' + ')'*8, 'x')


if __name__ == '__main__':
    unittest.main()
