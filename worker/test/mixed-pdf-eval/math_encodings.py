"""Bounded structural math comparison, not document ownership/visibility evidence.

Pure stdlib; no algebraic simplification. Unknown syntax fails closed. Presentation
MathML is authoritative; annotations cannot repair it. The deliberately small
subset follows these primary format references (no code copied from them):
https://www.w3.org/TR/mathml-core/
https://learn.microsoft.com/en-us/office/math/mathml
https://learn.microsoft.com/en-us/office/math/latex
https://devblogs.microsoft.com/math-in-office/officemath/

AST tuples preserve operand order, identifier case, alphabet style and script
positions. Redundant grouping is removed only after parsing precedence. Decimal
lexical variants are exact (no floating point, rounding or algebraic identities).
Supported syntax: binary + - * /, unary signs, distinct relations, round/square
parentheses, sub/superscripts, simple radicals, selected Greek commands and
explicit alphabet envelopes. TeX sums, functions, macros, matrices and arbitrary
text are unsupported. XML supports presentation fractions/scripts/radicals and a
small OMML run/fraction/script/delimiter subset; formatting properties outside
this whitelist are unsupported. A single leading XML 1.0 declaration and OMML
paragraph alignment (one jc property, one equation) are harmless envelopes.
Nested XML/grouped script bases stay nested; only adjacent linear script slots
share a base. Compatible adjacent OMML runs join before lexical analysis. OMML
and MathML presentation text cannot stand in for structural script elements.
MathML mtext defaults to normal, honoring inherited/explicit mathvariant.
Non-normal MathML numeric/operator variants and relation chains are unscorable.
Empty OMML runs are inert; default/normal ASCII decimal spans are compatible.
Unsupported combined alphabets (including double-struck italic) are refused.
All inputs are decoded strings containing XML 1.0 Char code points; NUL-shaped
UTF-16/32 byte strings are never re-decoded by the XML parser.
Decimal scale is normalized without rounding;
significant-figure/measurement precision is not assessed.

Bare multi-letter identifiers are ambiguous and refused; use explicit styled
identifiers (e.g. \\mathrm{kg}, MathML mi, OMML normal runs). This is an encoding
scorer only: supported/equivalent never authorizes an evaluation promotion.
"""

import json
import re
import unicodedata
import xml.etree.ElementTree as ET

VERSION = "1.0.4"
MAX_LENGTH = 32768
MAX_DEPTH = 48
MAX_NODES = 2048
MAX_TOKENS = 2048
MATHML_NS = "http://www.w3.org/1998/Math/MathML"
OMML_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
XML_NS = "http://www.w3.org/XML/1998/namespace"

_STYLES = {"normal", "italic", "bold", "bold-italic", "double-struck", "script",
           "bold-script", "fraktur", "bold-fraktur", "sans-serif",
           "bold-sans-serif", "sans-serif-italic", "sans-serif-bold-italic", "monospace"}
_STYLE_COMMANDS = {"mathrm": "normal", "mathit": "italic", "mathbf": "bold",
                   "mathbb": "double-struck", "mathcal": "script",
                   "mathscr": "script", "mathfrak": "fraktur", "mathsf": "sans-serif",
                   "mathtt": "monospace", "text": "normal"}
_GREEK = dict(zip(
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega".split(),
    "αβγδεζηθικλμνξοπρστυϕχψω"))
_GREEK.update({name: char for name, char in zip(
    "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split(), "ΓΔΘΛΞΠΣΥΦΨΩ")})
_GREEK.update({"epsilon": "ϵ", "varepsilon": "ε", "vartheta": "ϑ", "varphi": "φ", "varpi": "ϖ",
               "varrho": "ϱ", "varsigma": "ς", "varkappa": "ϰ"})
_COMMANDS = {"times": "*", "cdot": "*", "div": "/", "le": "≤", "leq": "≤",
             "ge": "≥", "geq": "≥", "ne": "≠", "neq": "≠", "approx": "≈",
             "equiv": "≡", "pm": "±", "mp": "∓", "infty": "∞"}
_OPERATORS = {"−": "-", "–": None, "×": "*", "·": "*", "⋅": "*", "÷": "/",
              "∕": "/", "⁄": "/", "\u2062": "*", "≤": "≤", "≥": "≥", "≠": "≠",
              "≈": "≈", "≡": "≡", "±": "±", "∓": "∓"}
_RELATIONS = {"=", "<", ">", "≤", "≥", "≠", "≈", "≡"}
_SUPER = dict(zip("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ", "0123456789+-=()ni"))
_SUPER.update(dict(zip("ᵃᵇᶜᵈᵉᶠᵍʰᶦʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻ", "abcdefghijklmoprstuvwxyz")))
_SUPER.update(dict(zip("ᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ", "ABDEGHIJKLMNOPRTUVW")))
_SUPER.update(dict(zip("ᵝᵞᵟᵠᵡ", "βγδφχ")))
# U+1DA6 MODIFIER LETTER SMALL CAPITAL I retains U+026A, not lowercase i.
# U+2071 SUPERSCRIPT LATIN SMALL LETTER I above remains ordinary lowercase i.
_SUPER["ᶦ"] = "ɪ"
_SUB = dict(zip("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥ", "0123456789+-=()aeoxhklmnpstijruv"))
_NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)\Z")
_IDENTIFIER = re.compile(r"[^\W\d_]+\Z", re.UNICODE)
_XML_DECLARATION = re.compile(
    r"<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:\"1\.0\"|'1\.0')"
    r"(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*"
    r"(?:\"(?i:UTF-8|UTF-16)\"|'(?i:UTF-8|UTF-16)'))?"
    r"(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:\"yes\"|'yes'|\"no\"|'no'))?"
    r"[ \t\r\n]*\?>"
)


class MathSyntaxError(ValueError):
    """Unsupported, malformed, ambiguous or resource-limited input."""


def _fail(message):
    raise MathSyntaxError(message)


def _number(text):
    if not _NUMBER.fullmatch(text):
        _fail("unsupported numeric literal")
    whole, _, fraction = text.partition(".")
    whole = whole.lstrip("0") or "0"
    fraction = fraction.rstrip("0")
    return ("number", whole + ("." + fraction if fraction else ""))


def _symbol(text, style=None):
    if not text or not _IDENTIFIER.fullmatch(text):
        _fail("unsupported identifier")
    glyphs = []
    styles = set()
    for char in text:
        name = unicodedata.name(char, "")
        letterlike_style = next((style for prefix, style in (
            ("DOUBLE-STRUCK ", "double-struck"), ("SCRIPT ", "script"),
            ("BLACK-LETTER ", "fraktur")) if name.startswith(prefix)), None)
        if letterlike_style and not re.match(
                r"(?:DOUBLE-STRUCK|SCRIPT|BLACK-LETTER) (?:CAPITAL|SMALL) ", name):
            # In particular U+2145..U+2149 are DOUBLE-STRUCK ITALIC. This
            # combined style has no supported AST/MathML variant; never erase it.
            _fail("unsupported combined mathematical alphabet style")
        if name.startswith("MATHEMATICAL ") or char == "ℎ" or letterlike_style:

            base = unicodedata.normalize("NFKD", char)
            if len(base) != 1 or not base.isalpha():
                _fail("unsupported mathematical alphabet glyph")
            glyph_style = letterlike_style or ("italic" if char == "ℎ" else name[len("MATHEMATICAL "):])
            if name.startswith("MATHEMATICAL ") and name.endswith(" SYMBOL"):
                variants = {"CAPITAL THETA SYMBOL": "ϴ", "EPSILON SYMBOL": "ϵ",
                            "THETA SYMBOL": "ϑ", "KAPPA SYMBOL": "ϰ", "PHI SYMBOL": "ϕ",
                            "RHO SYMBOL": "ϱ", "PI SYMBOL": "ϖ"}
                suffix = next((suffix for suffix in variants if name.endswith(suffix)), None)
                if suffix is None:
                    _fail("unsupported mathematical variant symbol")
                base = variants[suffix]
                glyph_style = name[len("MATHEMATICAL "):-len(suffix)].strip()
            if char != "ℎ" and not letterlike_style:
                markers = (" CAPITAL ", " SMALL ", " DIGIT ")
                for marker in markers:
                    if marker in glyph_style:
                        glyph_style = glyph_style.split(marker)[0].lower().replace(" ", "-")
                        break
                # Unicode and MathML use different word order for these styles.
                glyph_style = glyph_style.lower().replace(" ", "-")
                glyph_style = {"sans-serif-bold": "bold-sans-serif",
                               "sans-serif-bold-italic": "sans-serif-bold-italic"}.get(glyph_style, glyph_style)
            if glyph_style not in _STYLES:
                _fail("unsupported mathematical alphabet style")
            glyphs.append(base)
            styles.add(glyph_style)
        else:
            glyphs.append(char)
    if (styles and len(text) > 1) or len(styles) > 1 or (styles and style is not None and style not in styles):
        _fail("conflicting identifier styles")
    resolved = style or (next(iter(styles)) if styles else ("italic" if len(text) == 1 else "normal"))
    if resolved not in _STYLES:
        _fail("unsupported identifier style")
    return ("symbol", "".join(glyphs), resolved)


def _script(base, sub=None, sup=None):
    # A structured/grouped base is already complete. Only the linear parser can
    # accumulate sibling slots while it is reading the same unsplit base.
    return ("script", base, sub, sup)


def _lex(text, tex=False, identifier_style=None):
    """Tokenize only explicit syntax; AST operands can also come from XML."""
    tokens = []
    sized_delimiters = []
    i = 0
    while i < len(text):
        if len(tokens) >= MAX_TOKENS:
            _fail("token limit exceeded")
        char = text[i]
        if char.isspace():
            i += 1
            continue
        if char in _SUPER or char in _SUB:
            mapping = _SUPER if char in _SUPER else _SUB
            j = i
            while j < len(text) and text[j] in mapping:
                j += 1
            tokens.extend(["^" if mapping is _SUPER else "_", "{",
                           *_lex("".join(mapping[c] for c in text[i:j])), "}"])
            i = j
            continue
        if char == "\\":
            if not tex:
                _fail("TeX command in non-TeX input")
            match = re.match(r"\\([A-Za-z]+|.)", text[i:])
            if not match:
                _fail("incomplete TeX command")
            command = match.group(1)
            i += len(match.group(0))
            if command in {",", ";", ":", "!", " ", "quad", "qquad"}:
                continue
            if command in {"left", "right"}:
                delimiter = re.match(r"\s*([()\[\]])", text[i:])
                if not delimiter:
                    _fail("unsupported TeX delimiter")
                value = delimiter.group(1)
                if command == "left":
                    if value not in ("(", "["):
                        _fail("invalid left delimiter")
                    sized_delimiters.append(value)
                elif not sized_delimiters or {"(": ")", "[": "]"}[sized_delimiters.pop()] != value:
                    _fail("unmatched sized TeX delimiter")
                tokens.append(value)
                i += len(delimiter.group(0))
                continue
            if command in _GREEK:
                tokens.append(_symbol(_GREEK[command], "normal" if command[0].isupper() else None))
            elif command in _COMMANDS:
                value = _COMMANDS[command]
                tokens.append(("constant", value) if value == "∞" else value)
            elif command in _STYLE_COMMANDS:
                envelope = re.match(r"\s*\{([^{}]*)\}", text[i:])
                if not envelope:
                    _fail("style envelope requires a simple identifier")
                tokens.append(_symbol(envelope.group(1).strip(), _STYLE_COMMANDS[command]))
                i += len(envelope.group(0))
            elif command in {"frac", "dfrac", "tfrac", "sqrt"}:
                tokens.append("\\" + command)
            else:
                _fail("unknown TeX command: " + command)
            continue
        if char.isascii() and (char.isdigit() or char == "."):
            match = re.match(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", text[i:])
            if not match:
                _fail("invalid decimal")
            remaining = text[i + len(match.group(0)):]
            if re.match(r"[eE][+-]?[0-9]", remaining):
                _fail("scientific notation requires an explicit supported structure")
            tokens.append(("numeric-token", match.group(0)))
            i += len(match.group(0))
            continue
        if char.isalpha():
            j = i + 1
            while j < len(text) and text[j].isalpha() and text[j] not in _SUPER and text[j] not in _SUB:
                j += 1
            if j != i + 1 and identifier_style is None:
                _fail("ambiguous bare multi-letter identifier; use an explicit style envelope")
            tokens.append(_symbol(text[i:j], identifier_style))
            i = j
            continue
        if char == "∞":
            tokens.append(("constant", char))
        elif char in "+-*/^_=<>()[]{}":
            tokens.append(char)
        elif char in _OPERATORS and _OPERATORS[char] is not None:
            tokens.append(_OPERATORS[char])
        else:
            _fail("unsupported character: " + char)
        i += 1
    if sized_delimiters:
        _fail("missing right TeX delimiter")
    if len(tokens) > MAX_TOKENS:
        _fail("token limit exceeded")
    return tokens


class _Parser:
    def __init__(self, tokens, tex=False):
        if len(tokens) > MAX_TOKENS:
            _fail("token limit exceeded")
        self.tokens = tokens
        self.tex = tex
        self.pos = 0
        self.depth = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self):
        value = self.peek()
        if value is None:
            _fail("incomplete expression")
        self.pos += 1
        return value

    def expect(self, token):
        if self.take() != token:
            _fail("expected " + token)

    def parse(self):
        if not self.tokens:
            _fail("empty expression")
        node = self.expression()
        if self.peek() is not None:
            _fail("unconsumed or unmatched syntax")
        return node

    def expression(self, minimum=0):
        self.depth += 1
        if self.depth > MAX_DEPTH:
            _fail("expression depth limit exceeded")
        try:
            left = self.atom()
            script_base, script_sub, script_sup = left, None, None
            while True:
                token = self.peek()
                if token in ("_", "^"):
                    if 40 < minimum:
                        break
                    self.take()
                    value = self.argument()
                    if token == "_":
                        if script_sub is not None:
                            _fail("duplicate subscript requires explicit grouping")
                        script_sub = value
                    else:
                        if script_sup is not None:
                            _fail("duplicate superscript requires explicit grouping")
                        script_sup = value
                    left = _script(script_base, script_sub, script_sup)
                    continue
                if isinstance(token, str) and token in _RELATIONS:
                    precedence = 5
                elif token in ("+", "-", "±", "∓"):
                    precedence = 10
                elif token in ("*", "/"):
                    precedence = 20
                elif self.starts_atom(token):
                    # Juxtaposition is multiplication only for already delimited
                    # atoms. Never split a bare multi-letter identifier.
                    if left[0] == "number" and isinstance(token, tuple) and token[0] in ("number", "numeric-token"):
                        _fail("adjacent numeric literals are ambiguous")
                    base = left[1] if left[0] == "script" else left
                    if base[0] == "symbol" and len(base[1]) > 1:
                        _fail("named identifier adjacency needs an explicit operator")
                    if left[0] in ("symbol", "script") and token in ("(", "["):
                        _fail("ambiguous function application or multiplication")
                    precedence = 20
                    token = "implicit"
                else:
                    break
                if precedence < minimum:
                    break
                if token != "implicit":
                    self.take()
                right = self.expression(precedence + 1)
                if token in _RELATIONS and any(
                        node[0] == "binary" and node[1] in _RELATIONS for node in (left, right)):
                    _fail("relation chains and relation-valued comparison operands are unsupported")
                left = ("binary", "*" if token == "implicit" else token, left, right)
                script_base, script_sub, script_sup = left, None, None
            return left
        finally:
            self.depth -= 1

    @staticmethod
    def starts_atom(token):
        return isinstance(token, tuple) or token in ("(", "[", "{", "\\frac", "\\dfrac", "\\tfrac", "\\sqrt")

    def argument(self):
        if self.peek() == "{":
            self.take()
            node = self.expression()
            self.expect("}")
            return node
        # Unbraced script arguments are a single atom, never a signed expression.
        if self.peek() in ("+", "-", "_", "^", None):
            _fail("script or command argument needs an atom or braces")
        if self.tex:
            token = self.peek()
            if token in ("(", "[") or (isinstance(token, tuple) and token[0] == "numeric-token" and not re.fullmatch(r"[0-9]", token[1])):
                _fail("multi-character TeX argument requires braces")
        return self.atom()

    def atom(self):
        token = self.take()
        if isinstance(token, tuple):
            return _number(token[1]) if token[0] == "numeric-token" else token
        if token in ("+", "-", "±", "∓"):
            return ("unary", token, self.expression(30))
        if token == "{":
            _fail("bare brace group is ambiguous; use visible parentheses")
        if token in ("(", "["):
            node = self.expression()
            self.expect({"(": ")", "[": "]", "{": "}"}[token])
            return node
        if token in ("\\frac", "\\dfrac", "\\tfrac"):
            numerator = self.argument()
            denominator = self.argument()
            return ("binary", "/", numerator, denominator)
        if token == "\\sqrt":
            index = _number("2")
            if self.peek() == "[":
                self.take()
                index = self.expression()
                self.expect("]")
            return ("root", index, self.argument())
        _fail("expected an operand")


def _parse_tokens(tokens, tex=False):
    return _Parser(tokens, tex).parse()


def _split_tag(tag):
    if tag.startswith("{"):
        namespace, name = tag[1:].split("}", 1)
        return namespace, name
    return "", tag


def _check_decoded_characters(text):
    # XML 1.0 Char production. Validate before stripping whitespace or letting
    # Expat inspect the string: NUL-interleaved byte-shaped strings must never be
    # auto-detected/re-decoded as UTF-16/32. This is a decoded-string profile
    # refusal; it is not a claim that an external resource was accessed.
    for char in text:
        code = ord(char)
        if not (code in (0x9, 0xA, 0xD) or 0x20 <= code <= 0xD7FF or
                0xE000 <= code <= 0xFFFD or 0x10000 <= code <= 0x10FFFF):
            _fail("invalid XML 1.0 code point in decoded-string math/XML profile")


class _BoundedTreeBuilder(ET.TreeBuilder):
    """Apply the same pre-allocation limits during feed and deferred close."""

    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0

    def start(self, tag, attrs):
        if self.nodes >= MAX_NODES or self.depth >= MAX_DEPTH:
            _fail("XML node/depth limit exceeded")
        self.nodes += 1
        self.depth += 1
        return super().start(tag, attrs)

    def end(self, tag):
        element = super().end(tag)
        self.depth -= 1
        return element


def _xml_root(text):
    # Validate and remove at most one leading declaration. The API accepts an
    # already decoded string, so UTF-8/UTF-16 describe the export, not a decoding
    # operation here. Nothing is resolved or loaded from outside this string.
    if text.startswith("<?xml"):
        declaration = _XML_DECLARATION.match(text)
        if declaration is None:
            _fail("unsupported or malformed XML declaration")
        text = text[declaration.end():]
    # All other declarations/PIs and all entities (even built-in/numeric
    # references) remain forbidden. Literal Unicode needs no entity expansion.
    if "<!" in text or "&" in text or "<?" in text:
        _fail("DTDs, entities and additional processing instructions are forbidden")
    # Expat may defer long tags until close. Target callbacks account for every
    # node in either phase, checking limits before TreeBuilder allocates it.
    parser = ET.XMLParser(target=_BoundedTreeBuilder())
    for offset in range(0, len(text), 256):
        parser.feed(text[offset:offset + 256])
    root = parser.close()
    if root is None:
        _fail("empty XML")
    return root


class _XMLMath:
    def __init__(self, root, encoding):
        self.encoding = encoding
        self.namespace = _split_tag(root.tag)[0]
        if encoding == "mathml" and self.namespace not in ("", MATHML_NS):
            _fail("wrong MathML namespace")
        if encoding == "omml" and self.namespace != OMML_NS:
            _fail("OMML requires the Office Math namespace")
        if encoding == "omml":
            expressions = {"r", "f", "sSub", "sSup", "sSubSup", "d"}
            parents = {"oMathPara": {"oMathParaPr", "oMath"},
                       "oMathParaPr": {"jc"}, "oMath": expressions,
                       "num": expressions, "den": expressions, "e": expressions,
                       "sub": expressions, "sup": expressions,
                       "f": {"num", "den"}, "sSub": {"e", "sub"},
                       "sSup": {"e", "sup"}, "sSubSup": {"e", "sub", "sup"},
                       "r": {"rPr", "t"}, "rPr": {"nor"}, "d": {"dPr", "e"},
                       "dPr": {"begChr", "endChr"}}
            for element in root.iter():
                name = _split_tag(element.tag)[1]
                if any(_split_tag(child.tag)[1] not in parents.get(name, set()) for child in element):
                    _fail("unsupported OMML parent/child structure")

    def check(self, element, allowed=()):
        namespace, name = _split_tag(element.tag)
        if namespace != self.namespace:
            _fail("foreign XML namespace")
        if name in ("nor", "begChr", "endChr") and (element.text or "").strip():
            _fail("unexpected OMML property text")
        attribute_names = [_split_tag(key)[1] for key in element.attrib]
        if len(attribute_names) != len(set(attribute_names)):
            _fail("duplicate qualified/unqualified attributes")
        for key in element.attrib:
            attr_ns, attr_name = _split_tag(key)
            if attr_ns not in (("", self.namespace) if self.encoding == "omml" else ("",)) or attr_name not in allowed:
                _fail("unsupported attribute on " + name + ": " + attr_name)
        # Container mixed text would otherwise be silently lost.
        if element.text and element.text.strip() and (list(element) or name not in ("mi", "mn", "mo", "mtext", "annotation", "t")):
            _fail("unexpected XML mixed text")
        if any(child.tail and child.tail.strip() for child in element):
            _fail("unexpected XML tail text")
        return name

    def arity(self, element, count):
        if len(element) != count:
            _fail("wrong arity for " + _split_tag(element.tag)[1])

    def row(self, elements, style=None):
        tokens = []
        for element in elements:
            tokens.extend(self.mathml(element, style) if self.encoding == "mathml" else self.omml(element, style))
        return _parse_tokens(tokens)

    def mathml(self, element, style=None):
        name = _split_tag(element.tag)[1]
        allowed = {"math": ("display",), "mi": ("mathvariant",), "mstyle": ("mathvariant",),
                   "mtext": ("mathvariant",), "mn": ("mathvariant",),
                   "mo": ("stretchy", "mathvariant"), "annotation": ("encoding",)}.get(name, ())
        self.check(element, allowed)
        if "display" in element.attrib and element.attrib["display"] not in ("inline", "block"):
            _fail("unsupported MathML display")
        if "stretchy" in element.attrib and element.attrib["stretchy"] not in ("true", "false"):
            _fail("invalid stretchy attribute")
        if "mathvariant" in element.attrib:
            style = element.attrib["mathvariant"]
            if style not in _STYLES:
                _fail("unsupported mathvariant")
        if name in ("math", "mrow", "mstyle"):
            if not list(element) and (element.text or "").strip():
                _fail("unexpected container text")
            return [token for child in element for token in self.mathml(child, style)]
        if name == "semantics":
            if not len(element):
                _fail("empty semantics")
            for annotation in list(element)[1:]:
                if self.check(annotation, ("encoding",)) != "annotation" or len(annotation):
                    _fail("unsupported hidden annotation structure")
            return self.mathml(element[0], style)
        if name in ("mi", "mn", "mo", "mtext"):
            self.arity(element, 0)
            value = (element.text or "").strip()
            if any(char in "^_" or char in _SUPER or char in _SUB for char in value):
                _fail("baseline MathML text cannot attach a script")
            if name == "mi":
                return [_symbol(value, style)]
            if name == "mtext":
                return [_symbol(value, style or "normal")]
            if name == "mn":
                if style not in (None, "normal"):
                    _fail("unsupported numeric mathvariant")
                return [_number(value)]
            if style not in (None, "normal"):
                _fail("unsupported operator mathvariant")
            tokens = _lex(value)
            if len(tokens) != 1 or not isinstance(tokens[0], str) or tokens[0] not in _RELATIONS | {"+", "-", "*", "/", "(", ")", "[", "]", "±", "∓"}:
                _fail("unsupported MathML operator")
            return tokens
        if name == "mfrac":
            self.arity(element, 2)
            return [("binary", "/", self.row([element[0]], style), self.row([element[1]], style))]
        if name in ("msub", "msup", "msubsup"):
            self.arity(element, 3 if name == "msubsup" else 2)
            base = self.row([element[0]], style)
            sub = self.row([element[1]], style) if name != "msup" else None
            sup = self.row([element[-1]], style) if name != "msub" else None
            return [_script(base, sub, sup)]
        if name in ("msqrt", "mroot"):
            if name == "mroot":
                self.arity(element, 2)
                body, index = self.row([element[0]], style), self.row([element[1]], style)
            else:
                body, index = self.row(list(element), style), _number("2")
            return [("root", index, body)]
        _fail("unsupported MathML element: " + name)

    @staticmethod
    def _omml_text(text, style):
        # These are presentation runs, not an Office linear-input language.
        # Scripts must be attached by sSub/sSup/sSubSup elements only.
        if any(char in "^_" or char in _SUPER or char in _SUB for char in text):
            _fail("baseline OMML text cannot attach a script")
        return _lex(text, identifier_style=style)

    def _omml_run(self, element, style=None):
        self.check(element)
        children = list(element)
        if children and _split_tag(children[0].tag)[1] == "rPr":
            properties = children.pop(0)
            self.check(properties)
            self.arity(properties, 1)
            normal = properties[0]
            if self.check(normal, ("val",)) != "nor" or len(normal):
                _fail("unsupported OMML run property")
            value = normal.attrib.get("{" + OMML_NS + "}val", normal.attrib.get("val", "1"))
            if value not in ("1", "true", "on"):
                _fail("unsupported OMML normal setting")
            style = "normal"
        if not children or any(_split_tag(child.tag)[1] != "t" for child in children):
            _fail("OMML run requires text only")
        texts = []
        for child in children:
            # xml:space is presentation whitespace only.
            if set(child.attrib) - {"{" + XML_NS + "}space"}:
                _fail("unsupported OMML text attribute")
            if child.attrib.get("{" + XML_NS + "}space", "default") not in ("preserve", "default"):
                _fail("invalid xml:space")
            if _split_tag(child.tag)[0] != OMML_NS or len(child):
                _fail("invalid OMML text")
            texts.append(child.text or "")
        text = "".join(texts)
        return text, style

    def _omml_children(self, children, style=None):
        tokens = []
        pending = []
        pending_style = None

        def flush():
            if pending:
                tokens.extend(self._omml_text("".join(pending), pending_style))
                pending.clear()

        for child in children:
            if _split_tag(child.tag)[1] == "r":
                text, run_style = self._omml_run(child, style)
                # Empty, already-validated runs carry no visible style change.
                if not text:
                    continue
                for piece in re.findall(r"[0-9.]+|[^0-9.]+", text):
                    # Ordinary ASCII decimal glyphs have the same supported
                    # numeric semantics in default and normal OMML runs. Only
                    # these spans may cross that nonempty style transition.
                    piece_style = None if (run_style in (None, "normal") and
                                           re.fullmatch(r"[0-9.]+", piece)) else run_style
                    if pending and piece_style != pending_style:
                        flush()
                    pending_style = piece_style
                    pending.append(piece)
            else:
                flush()
                tokens.extend(self.omml(child, style))
        flush()
        return tokens

    def omml(self, element, style=None):
        name = self.check(element)
        if name in ("oMath", "oMathPara", "num", "den", "e", "sub", "sup"):
            children = list(element)
            if name == "oMathPara":
                if children and _split_tag(children[0].tag)[1] == "oMathParaPr":
                    properties = children.pop(0)
                    self.check(properties)
                    self.arity(properties, 1)
                    alignment = properties[0]
                    if self.check(alignment, ("val",)) != "jc":
                        _fail("unsupported OMML paragraph property")
                    self.arity(alignment, 0)
                    value = alignment.attrib.get("{" + OMML_NS + "}val")
                    if value not in ("center", "centerGroup", "left", "right"):
                        _fail("unsupported OMML paragraph alignment")
                if len(children) != 1 or _split_tag(children[0].tag)[1] != "oMath":
                    _fail("oMathPara must contain exactly one equation")
            if not list(element) and (element.text or "").strip():
                _fail("unexpected OMML container text")
            return self._omml_children(children, style)
        if name == "r":
            return self._omml_text(*self._omml_run(element, style))
        if name in ("f", "sSub", "sSup", "sSubSup"):
            expected = {"f": ["num", "den"], "sSub": ["e", "sub"], "sSup": ["e", "sup"],
                        "sSubSup": ["e", "sub", "sup"]}[name]
            if [_split_tag(child.tag)[1] for child in element] != expected:
                _fail("unsupported OMML structure or properties")
            args = [self.row([child], style) for child in element]
            if name == "f":
                return [("binary", "/", *args)]
            return [_script(args[0], args[1] if name != "sSup" else None,
                            args[-1] if name != "sSub" else None)]
        if name == "d":
            children = list(element)
            opening, closing = "(", ")"
            if children and _split_tag(children[0].tag)[1] == "dPr":
                properties = children.pop(0)
                self.check(properties)
                seen = set()
                for prop in properties:
                    key = self.check(prop, ("val",))
                    self.arity(prop, 0)
                    if key not in ("begChr", "endChr") or key in seen:
                        _fail("unsupported delimiter property")
                    seen.add(key)
                    value = prop.attrib.get("{" + OMML_NS + "}val", prop.attrib.get("val"))
                    if key == "begChr":
                        opening = value
                    else:
                        closing = value
            if (opening, closing) not in (("(", ")"), ("[", "]")):
                _fail("unsupported OMML delimiters")
            if len(children) != 1 or _split_tag(children[0].tag)[1] != "e":
                _fail("OMML delimiter requires one expression")
            return [opening, *self.omml(children[0], style), closing]
        _fail("unsupported OMML element: " + name)


def _validate_ast(ast):
    count = 0
    stack = [(ast, 1)]
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            _fail("AST node/depth limit exceeded")
        stack.extend((child, depth + 1) for child in node if isinstance(child, tuple))


def normalize_math(text, encoding="auto"):
    """Return supported/ast/canonical/encoding/format/issues for one expression.

    Limits: 32768 characters, 2048 tokens/XML or AST nodes, depth 48. Unsupported
    inputs return ast/canonical=None. The canonical string is stable JSON of the
    ordered AST, not executable code. No page occurrence or ownership is inferred.
    """
    result = {"supported": False, "ast": None, "canonical": None,
              "encoding": encoding, "format": encoding, "issues": []}
    try:
        if not isinstance(encoding, str):
            _fail("encoding must be a string")
        if not isinstance(text, str):
            _fail("math input must be a string")
        if len(text) > MAX_LENGTH:
            _fail("input length limit exceeded")
        _check_decoded_characters(text)
        if text.lstrip().startswith("<?xml") and not text.startswith("<?xml"):
            _fail("XML declaration must be at the beginning of the input")
        text = text.strip()
        aliases = {"latex": "tex", "unicodemath": "unicode", "plain": "ascii", "ooml": "omml"}
        encoding = aliases.get(encoding, encoding)
        if encoding not in ("auto", "tex", "unicode", "ascii", "mathml", "omml"):
            _fail("unknown encoding")
        xml_root = None
        if encoding in ("mathml", "omml") or (encoding == "auto" and text.startswith("<") and not text.startswith("<=")):
            xml_root = _xml_root(text)
            namespace, root_name = _split_tag(xml_root.tag)
            if encoding == "auto":
                encoding = "omml" if namespace == OMML_NS else "mathml"
            if (encoding == "mathml" and root_name != "math") or (encoding == "omml" and root_name not in ("oMath", "oMathPara")):
                _fail("unsupported XML math root")
        elif encoding == "auto":
            encoding = "tex" if "\\" in text or text.startswith("$") else ("ascii" if text.isascii() else "unicode")
        result["encoding"] = result["format"] = encoding
        if xml_root is not None:
            parser = _XMLMath(xml_root, encoding)
            ast = parser.row([xml_root])
        else:
            if encoding == "ascii" and not text.isascii():
                _fail("non-ASCII character in ASCII input")
            if encoding == "tex":
                for opening, closing in (("$$", "$$"), ("$", "$"), (r"\(", r"\)"), (r"\[", r"\]")):
                    if text.startswith(opening):
                        if not text.endswith(closing) or len(text) < len(opening) + len(closing):
                            _fail("unmatched TeX math envelope")
                        text = text[len(opening):-len(closing)]
                        break
            ast = _parse_tokens(_lex(text, encoding == "tex"), encoding == "tex")
        _validate_ast(ast)
        result.update(supported=True, ast=ast, canonical=json.dumps(ast, ensure_ascii=False, separators=(",", ":")))
    except (MathSyntaxError, ET.ParseError, RecursionError, UnicodeError) as error:
        result["issues"].append(str(error) or "parser resource limit")
    return result


def compare_math(expected, actual, expected_encoding="auto", actual_encoding="auto"):
    """Exact structural equivalence; score is None unless both inputs are supported."""
    left = normalize_math(expected, expected_encoding)
    right = normalize_math(actual, actual_encoding)
    supported = left["supported"] and right["supported"]
    equivalent = left["ast"] == right["ast"] if supported else None
    return {"supported": supported, "equivalent": equivalent,
            "score": float(equivalent) if supported else None,
            "issues": ["expected: " + issue for issue in left["issues"]] +
                      ["actual: " + issue for issue in right["issues"]],
            "expected": left, "actual": right}
