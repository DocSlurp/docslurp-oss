"""Bounded facts about the raster images a PDF draws and the page's layout: where, how and with what pixels.

Structural geometry only: the page tree, content streams, image dictionaries and the text layer's word boxes. Nothing here
reads document-authored metadata (Info, XMP, file names) for a decision; `struct_alt_text` is informational (captions).
Runs on untrusted input only behind a boundary: inside the Doppler VM guest (which loads this file from the pinned core
checkout), or in the worker's parser sandbox in customer-owned local mode, and on public fixtures in the routing eval.
Three independent parts, all fail-soft (an unknown fact is reported as unknown, never invented, never a guess):

* `walk_document`: a minimal PDF reader and content-stream walker. It resolves the page tree, follows Form XObjects and
  reports every image draw with its transformation matrix, so each image gets a bounding box in the page's displayed
  coordinate space (PDF points, origin top-left, after /Rotate). Poppler's own `pdfimages -list` carries no geometry;
  the guest's poppler build ships no `pdftohtml`; this is the in-guest source. Encrypted files, unsupported stream
  filters, and anything over a budget make the affected pages "unknown".
* `pixel_signals`: cheap raster statistics (colour counts, edges, ink bands, a difference hash) from a bounded
  thumbnail, using Pillow when the guest image provides it. No ML, no OCR.
* `block_anchors`: where an image sits in a page's Markdown, by aligning Markdown blocks with the text layer's word
  boxes. The page Markdown is never changed here; the host inserts references at the reported block index.

Classification and routing are NOT decided here: the guest reports measurements, the host applies one reviewed
threshold table (`core/packages/shared/src/image-routing.ts`).
"""
import collections
import math
import os
import re
import stat
import struct
import sys
import time
import zlib

FACTS_VERSION = 'doppler-image-facts@1'

# ---- budgets: every loop over hostile input is bounded; exhaustion makes facts unknown, never fails the job ----
MAX_XREF_ENTRIES = 1_000_000
MAX_XREF_SECTIONS = 64
MAX_OBJECT_WINDOW = 16 * 1024 * 1024
MAX_STREAM_DECODED = 8 * 1024 * 1024
MAX_PAGE_CONTENT = 8 * 1024 * 1024
MAX_PAGE_OPERATIONS = 400_000
MAX_PAGE_DRAWS = 2048
MAX_FORMS_PER_PAGE = 512
MAX_FORM_DEPTH = 8
MAX_GSTATE_DEPTH = 256
MAX_TREE_DEPTH = 40
MAX_TREE_NODES = 200_000
MAX_STRUCT_NODES = 50_000
MAX_ALT_CHARS = 1024
MAX_PAGES_WALKED = 10_000
MAX_INLINE_IMAGE = 8 * 1024 * 1024
MAX_OBJECTS_CACHED = 4096


class Unknown(Exception):
    """A fact cannot be established from this file within budget; the message is a short stable reason slug."""


class Name(str):
    __slots__ = ()


Ref = collections.namedtuple('Ref', 'num gen')


class Stream:
    __slots__ = ('dict', 'offset', 'objstm_data')

    def __init__(self, dictionary, offset, objstm_data=None):
        self.dict, self.offset, self.objstm_data = dictionary, offset, objstm_data


class Incomplete(Exception):
    """The lexer reached the end of its window; the caller may retry with a larger one."""


_WS = b'\x00\t\n\x0c\r '
_DELIM = b'()<>[]{}/%'
_REGULAR = re.compile(rb'[^\x00\t\n\x0c\r ()<>\[\]{}/%]+')
_SKIP = re.compile(rb'(?:[\x00\t\n\x0c\r ]+|%[^\r\n]*)*')
_NUMBER = re.compile(rb'[+-]?(?:\d+\.?\d*|\.\d+)\Z')
_EI = re.compile(rb'[\x00\t\n\x0c\r ]EI(?=[\x00\t\n\x0c\r ]|$)')
_EI_TAIL = re.compile(rb'[A-Za-z0-9.+\-*\'"/ \[\]<>()\x00\t\n\x0c\r%]*')
_ESCAPES = {ord('n'): 10, ord('r'): 13, ord('t'): 9, ord('b'): 8, ord('f'): 12, ord('('): 40, ord(')'): 41, ord('\\'): 92}


class Lexer:
    """Tokenizer and object parser over an in-memory window. Operators come back as `Keyword`."""

    class Keyword(str):
        __slots__ = ()

    def __init__(self, data, pos=0, refs=True):
        self.data, self.pos = data, pos
        self.refs = refs  # content streams hold no indirect references: skip the `n g R` lookahead there

    def skip(self):
        self.pos = _SKIP.match(self.data, self.pos).end()

    def at_end(self):
        self.skip()
        return self.pos >= len(self.data)

    def _string(self):
        data, i, depth, out = self.data, self.pos + 1, 1, bytearray()
        while i < len(data):
            c = data[i]
            if c == 92:  # backslash
                i += 1
                if i >= len(data):
                    break
                e = data[i]
                if e in _ESCAPES:
                    out.append(_ESCAPES[e])
                elif 48 <= e <= 55:
                    value, n = e - 48, 1
                    while n < 3 and i + 1 < len(data) and 48 <= data[i + 1] <= 55:
                        i += 1
                        value = value * 8 + data[i] - 48
                        n += 1
                    out.append(value & 255)
                elif e == 13:
                    if i + 1 < len(data) and data[i + 1] == 10:
                        i += 1
                elif e != 10:
                    out.append(e)
            elif c == 40:
                depth += 1
                out.append(c)
            elif c == 41:
                depth -= 1
                if depth == 0:
                    self.pos = i + 1
                    return bytes(out)
                out.append(c)
            else:
                out.append(c)
            i += 1
        raise Incomplete()

    def token(self):
        """Next token: ('obj', value) for scalars, or the structural markers '[', ']', '<<', '>>'."""
        self.skip()
        data, i = self.data, self.pos
        if i >= len(data):
            raise Incomplete()
        c = data[i]
        if c == 47:  # name
            m = _REGULAR.match(data, i + 1)
            end = m.end() if m else i + 1
            raw = data[i + 1:end]
            self.pos = end
            if b'#' in raw:
                raw = re.sub(rb'#([0-9A-Fa-f]{2})', lambda h: bytes([int(h[1], 16)]), raw)
            return Name(raw.decode('latin-1'))
        if c == 40:
            return self._string()
        if c == 60:
            if data[i + 1:i + 2] == b'<':
                self.pos = i + 2
                return '<<'
            end = data.find(b'>', i)
            if end < 0:
                raise Incomplete()
            hexed = re.sub(rb'[^0-9A-Fa-f]', b'', data[i + 1:end])
            if len(hexed) % 2:
                hexed += b'0'
            self.pos = end + 1
            return bytes.fromhex(hexed.decode('ascii'))
        if c == 62:
            if data[i + 1:i + 2] == b'>':
                self.pos = i + 2
                return '>>'
            self.pos = i + 1
            return self.Keyword('>')
        if c in b'[]':
            self.pos = i + 1
            return chr(c)
        if c in b'{}()':
            self.pos = i + 1
            return self.Keyword(chr(c))
        m = _REGULAR.match(data, i)
        if not m:
            self.pos = i + 1
            return self.Keyword(chr(c))
        self.pos = m.end()
        word = m.group()
        if _NUMBER.match(word):
            try:
                return int(word) if b'.' not in word else float(word)
            except ValueError:
                return 0
        if word == b'true':
            return True
        if word == b'false':
            return False
        if word == b'null':
            return None
        return self.Keyword(word.decode('latin-1'))

    def obj(self, depth=0):
        """Parse one object, resolving `n g R` references. Keywords are returned as `Keyword` for the caller."""
        if depth > 64:
            raise Unknown('nesting')
        t = self.token()
        if t == '[':
            out = []
            while True:
                self.skip()
                if self.pos >= len(self.data):
                    raise Incomplete()
                if self.data[self.pos:self.pos + 1] == b']':
                    self.pos += 1
                    return out
                out.append(self.obj(depth + 1))
                if len(out) > 2_000_000:
                    raise Unknown('array-size')
        if t == '<<':
            out = {}
            while True:
                self.skip()
                if self.data[self.pos:self.pos + 2] == b'>>':
                    self.pos += 2
                    return out
                key = self.token()
                if not isinstance(key, Name):
                    if key is None and self.pos >= len(self.data):
                        raise Incomplete()
                    continue  # malformed key: skip it, as lenient readers do
                out[str(key)] = self.obj(depth + 1)
        if self.refs and isinstance(t, int) and not isinstance(t, bool) and t >= 0:
            save = self.pos
            try:
                gen = self.token()
                if isinstance(gen, int) and not isinstance(gen, bool) and 0 <= gen < 65536:
                    mark = self.token()
                    if isinstance(mark, Lexer.Keyword) and mark == 'R':
                        return Ref(t, gen)
            except Incomplete:
                pass
            self.pos = save
        return t


def _number(x, default=0.0):
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else default


# ---- stream decoding ----

def _unpredict(data, params):
    predictor = params.get('Predictor', 1) if isinstance(params, dict) else 1
    if not isinstance(predictor, int) or predictor < 2:
        return data
    columns = params.get('Columns', 1)
    colors = params.get('Colors', 1)
    bits = params.get('BitsPerComponent', 8)
    if not all(isinstance(v, int) and 0 < v <= 65536 for v in (columns, colors, bits)):
        raise Unknown('predictor')
    bpp = max(1, colors * bits // 8)
    row = (columns * colors * bits + 7) // 8
    if predictor == 2:
        if bits != 8:
            raise Unknown('tiff-predictor')
        out = bytearray(data)
        for start in range(0, len(out) - row + 1, row):
            for i in range(start + bpp, start + row):
                out[i] = (out[i] + out[i - bpp]) & 255
        return bytes(out)
    if predictor < 10:
        raise Unknown('predictor')
    out, prev = bytearray(), bytes(row)
    stride = row + 1
    mask7, mask8 = int.from_bytes(b'\x7f' * row, 'big'), int.from_bytes(b'\x80' * row, 'big')
    for start in range(0, len(data) - stride + 1, stride):
        kind, cur = data[start], bytearray(data[start + 1:start + stride])
        if kind == 2:  # Up, by SWAR byte addition on big integers (xref streams are large and almost always Up)
            x, y = int.from_bytes(cur, 'big'), int.from_bytes(prev, 'big')
            cur = bytearray((((x & mask7) + (y & mask7)) ^ ((x ^ y) & mask8)).to_bytes(row, 'big'))
        elif kind == 1:
            for i in range(bpp, row):
                cur[i] = (cur[i] + cur[i - bpp]) & 255
        elif kind == 3:
            for i in range(row):
                left = cur[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(row):
                a = cur[i - bpp] if i >= bpp else 0
                b, c = prev[i], (prev[i - bpp] if i >= bpp else 0)
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        elif kind != 0:
            raise Unknown('predictor')
        out += cur
        prev = bytes(cur)
        if len(out) > MAX_STREAM_DECODED:
            raise Unknown('stream-too-large')
    return bytes(out)


def _ascii85(data):
    data = data.strip()
    if data.startswith(b'<~'):
        data = data[2:]
    end = data.find(b'~>')
    if end >= 0:
        data = data[:end]
    out, group = bytearray(), []
    for c in data:
        if c in _WS:
            continue
        if c == 122 and not group:
            out += b'\0\0\0\0'
            continue
        if not 33 <= c <= 117:
            raise Unknown('ascii85')
        group.append(c - 33)
        if len(group) == 5:
            value = 0
            for g in group:
                value = value * 85 + g
            out += (value & 0xFFFFFFFF).to_bytes(4, 'big')
            group = []
        if len(out) > MAX_STREAM_DECODED:
            raise Unknown('stream-too-large')
    if group:
        n = len(group)
        group += [84] * (5 - n)
        value = 0
        for g in group:
            value = value * 85 + g
        out += (value & 0xFFFFFFFF).to_bytes(4, 'big')[:n - 1]
    return bytes(out)


def _runlength(data):
    out, i = bytearray(), 0
    while i < len(data):
        n = data[i]
        if n == 128:
            break
        if n < 128:
            out += data[i + 1:i + 2 + n]
            i += n + 2
        else:
            out += data[i + 1:i + 2] * (257 - n)
            i += 2
        if len(out) > MAX_STREAM_DECODED:
            raise Unknown('stream-too-large')
    return bytes(out)


def _inflate(data, limit):
    d = zlib.decompressobj()
    try:
        out = d.decompress(data, limit + 1)
    except zlib.error:
        # Truncated or damaged streams are common; use whatever decoded before the damage.
        d = zlib.decompressobj()
        out = b''
        try:
            for i in range(0, len(data), 4096):
                out += d.decompress(data[i:i + 4096], max(0, limit + 1 - len(out)))
                if len(out) > limit:
                    break
        except zlib.error:
            pass
        if not out:
            raise Unknown('flate')
    if len(out) > limit:
        raise Unknown('stream-too-large')
    return out


def decode_filters(raw, dictionary, limit=MAX_STREAM_DECODED):
    filters = dictionary.get('Filter', dictionary.get('F'))
    params = dictionary.get('DecodeParms', dictionary.get('DP'))
    if filters is None:
        return raw
    filters = filters if isinstance(filters, list) else [filters]
    params = params if isinstance(params, list) else [params] * len(filters)
    data = raw
    for name, parm in zip(filters, params + [None] * len(filters)):
        name = {'Fl': 'FlateDecode', 'AHx': 'ASCIIHexDecode', 'A85': 'ASCII85Decode', 'RL': 'RunLengthDecode'}.get(name, name)
        if name == 'FlateDecode':
            data = _unpredict(_inflate(data, limit), parm if isinstance(parm, dict) else {})
        elif name == 'ASCIIHexDecode':
            hexed = re.sub(rb'[^0-9A-Fa-f]', b'', data.split(b'>')[0])
            data = bytes.fromhex((hexed + (b'0' if len(hexed) % 2 else b'')).decode('ascii'))
        elif name == 'ASCII85Decode':
            data = _ascii85(data)
        elif name == 'RunLengthDecode':
            data = _runlength(data)
        else:
            raise Unknown('filter')  # LZW, DCT, JPX, CCITT, JBIG2, Crypt: not needed for structure, not decoded here
        if len(data) > limit:
            raise Unknown('stream-too-large')
    return data


# ---- file, xref, objects ----

class PdfFile:
    def __init__(self, path, deadline=None):
        self.fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(self.fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(self.fd)
            raise Unknown('not-a-file')
        self.size = info.st_size
        self.deadline = deadline
        self.xref = {}
        self.trailer = {}
        self.cache = {}
        self.objstm_cache = collections.OrderedDict()
        self._load_xref()
        if 'Encrypt' in self.trailer:
            raise Unknown('encrypted')
        self.catalog = self.deref(self.trailer.get('Root'))
        if not isinstance(self.catalog, dict):
            raise Unknown('no-catalog')

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass

    def check_time(self):
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise Unknown('time-budget')

    def window(self, offset, length):
        if offset < 0 or offset > self.size:
            raise Unknown('bad-offset')
        return os.pread(self.fd, min(length, self.size - offset), offset)

    def _parse_at(self, offset, parse):
        """Run `parse(lexer)` on a window that grows until the parse completes."""
        size = 4096
        while True:
            data = self.window(offset, size)
            try:
                return parse(Lexer(data))
            except Incomplete:
                if size >= MAX_OBJECT_WINDOW or offset + size >= self.size:
                    raise Unknown('truncated')
                size *= 8

    # xref
    def _load_xref(self):
        tail = self.window(max(0, self.size - 2048), 2048)
        found = list(re.finditer(rb'startxref\s+(\d+)', tail))
        if not found:
            raise Unknown('no-startxref')
        offset, seen, sections, pending = int(found[-1][1]), set(), 0, []
        pending.append(offset)
        while pending:
            offset = pending.pop(0)
            if offset in seen:
                continue
            seen.add(offset)
            sections += 1
            if sections > MAX_XREF_SECTIONS:
                raise Unknown('xref-chain')
            trailer = self._parse_xref_section(offset)
            if not self.trailer:
                self.trailer = trailer
            for key in ('XRefStm', 'Prev'):
                if isinstance(trailer.get(key), int):
                    pending.append(trailer[key])
        if not self.xref:
            raise Unknown('empty-xref')

    def _add(self, num, entry):
        if num not in self.xref:
            if len(self.xref) >= MAX_XREF_ENTRIES:
                raise Unknown('too-many-objects')
            self.xref[num] = entry

    def _parse_xref_section(self, offset):
        head = self.window(offset, 32)
        if head.lstrip(_WS).startswith(b'xref'):
            return self._xref_table(offset)
        return self._xref_stream(offset)

    def _xref_table(self, offset):
        # Subsections are `start count` then 20-byte lines; read in bounded blocks, then the trailer dictionary.
        pos = offset + self.window(offset, 32).find(b'xref') + 4
        while True:
            self.check_time()
            block = self.window(pos, 64)
            m = re.match(rb'[\x00\t\n\x0c\r ]*(\d+)[ ]+(\d+)[ \r\n]*', block)
            if not m:
                break
            start, count = int(m[1]), int(m[2])
            if count > MAX_XREF_ENTRIES:
                raise Unknown('too-many-objects')
            pos += m.end()
            body = self.window(pos, count * 20 + 40)
            for i in range(count):
                line = body[i * 20:(i + 1) * 20]
                f = line.split()
                if len(f) < 3:
                    raise Unknown('xref-entry')
                if f[2] == b'n':
                    self._add(start + i, ('o', int(f[0]), int(f[1])))
                elif f[2] == b'f':
                    self._add(start + i, ('f',))
            pos += count * 20
        block = self.window(pos, 64)
        t = block.find(b'trailer')
        if t < 0:
            raise Unknown('no-trailer')
        trailer = self._parse_at(pos + t + 7, lambda lx: lx.obj())
        if not isinstance(trailer, dict):
            raise Unknown('trailer')
        return trailer

    def _xref_stream(self, offset):
        def parse(lx):
            lx.token(), lx.token(), lx.token()  # n g obj
            d = lx.obj()
            return d, lx
        d, lx = self._parse_at(offset, parse)
        if not isinstance(d, dict) or d.get('Type') != 'XRef':
            raise Unknown('xref-stream')
        stream = self._stream_from(d, offset)
        data = decode_filters(self._raw(stream), d, 64 * 1024 * 1024)
        w, size = d.get('W'), d.get('Size')
        if not (isinstance(w, list) and len(w) == 3 and all(isinstance(v, int) and 0 <= v <= 8 for v in w) and isinstance(size, int)):
            raise Unknown('xref-stream')
        index = d.get('Index') or [0, size]
        row = sum(w)
        if row == 0:
            raise Unknown('xref-stream')
        pos = 0
        for k in range(0, len(index) - 1, 2):
            start, count = index[k], index[k + 1]
            if not (isinstance(start, int) and isinstance(count, int) and 0 <= count <= MAX_XREF_ENTRIES):
                raise Unknown('xref-stream')
            for i in range(count):
                if pos + row > len(data):
                    break
                f = [int.from_bytes(data[pos + sum(w[:j]):pos + sum(w[:j + 1])], 'big') if w[j] else (1 if j == 0 else 0) for j in range(3)]
                pos += row
                if f[0] == 1:
                    self._add(start + i, ('o', f[1], f[2]))
                elif f[0] == 2:
                    self._add(start + i, ('s', f[1], f[2]))
                elif f[0] == 0:
                    self._add(start + i, ('f',))
        return d

    # streams
    def _stream_from(self, d, obj_offset):
        """Locate the `stream` keyword after the dictionary that began the object at obj_offset."""
        window = self.window(obj_offset, 1 << 16)
        for size in (1 << 16, 1 << 20, MAX_OBJECT_WINDOW):
            window = self.window(obj_offset, size)
            m = re.search(rb'>>[\x00\t\n\x0c\r ]*stream(?:\r\n|\n|\r)', window)
            if m or len(window) < size:
                break
        if not m:
            raise Unknown('no-stream')
        # The dictionary may itself contain `>> stream`-like bytes only inside strings; the first match after a
        # complete dictionary is what readers use.
        return Stream(d, obj_offset + m.end())

    def _raw(self, stream):
        length = stream.dict.get('Length')
        if isinstance(length, Ref):
            length = self.deref(length)
        if stream.objstm_data is not None:
            return stream.objstm_data
        if isinstance(length, int) and 0 <= length <= self.size - stream.offset:
            tail = self.window(stream.offset + length, 32)
            if re.match(rb'[\x00\t\n\x0c\r ]*endstream', tail):
                return self.window(stream.offset, length)
        # Wrong or missing /Length: scan for endstream.
        pos, out = stream.offset, bytearray()
        while len(out) <= MAX_OBJECT_WINDOW:
            block = self.window(pos, 1 << 20)
            end = block.find(b'endstream')
            if end >= 0:
                out += block[:end]
                for eol in (b'\r\n', b'\n', b'\r'):
                    if out.endswith(eol):
                        del out[-len(eol):]
                        break
                return bytes(out)
            if len(block) < (1 << 20):
                break
            out += block[:-9]
            pos += len(block) - 9
        raise Unknown('stream-length')

    def stream_data(self, stream, limit=MAX_STREAM_DECODED):
        return decode_filters(self._raw(stream), stream.dict, limit)

    # objects
    def deref(self, value, depth=0):
        while isinstance(value, Ref):
            depth += 1
            if depth > 16:
                raise Unknown('ref-loop')
            value = self.load(value.num)
        return value

    def load(self, num):
        if num in self.cache:
            return self.cache[num]
        self.check_time()
        entry = self.xref.get(num)
        if entry is None or entry[0] == 'f':
            return None
        if entry[0] == 'o':
            obj = self._parse_indirect(entry[1], num)
        else:
            obj = self._from_objstm(entry[1], entry[2], num)
        if len(self.cache) >= MAX_OBJECTS_CACHED:
            self.cache.pop(next(iter(self.cache)))
        self.cache[num] = obj
        return obj

    def _parse_indirect(self, offset, expect):
        def parse(lx):
            n, g, kw = lx.token(), lx.token(), lx.token()
            if n != expect or kw != 'obj':
                raise Unknown('object-mismatch')
            value = lx.obj()
            if isinstance(value, dict):
                lx.skip()
                if lx.data[lx.pos:lx.pos + 6] == b'stream':
                    return 'stream', value
            return 'plain', value
        kind, value = self._parse_at(offset, parse)
        return self._stream_from(value, offset) if kind == 'stream' else value

    def _from_objstm(self, stm_num, index, num):
        if stm_num in self.objstm_cache:
            self.objstm_cache.move_to_end(stm_num)
            header, body = self.objstm_cache[stm_num]
        else:
            stm = self.load(stm_num)
            if not isinstance(stm, Stream) or stm.dict.get('Type') != 'ObjStm':
                raise Unknown('objstm')
            n, first = self.deref(stm.dict.get('N')), self.deref(stm.dict.get('First'))
            if not (isinstance(n, int) and isinstance(first, int) and 0 <= n <= 100_000 and 0 <= first):
                raise Unknown('objstm')
            data = self.stream_data(stm)
            lx = Lexer(data[:first])
            header = []
            try:
                for _ in range(n):
                    header.append((lx.token(), lx.token()))
            except Incomplete:
                pass
            body = data[first:]
            self.objstm_cache[stm_num] = (header, body)
            while len(self.objstm_cache) > 4:
                self.objstm_cache.popitem(last=False)
        if not 0 <= index < len(header) or header[index][0] != num or not isinstance(header[index][1], int):
            raise Unknown('objstm-index')
        try:
            return Lexer(body, header[index][1]).obj()
        except Incomplete:
            raise Unknown('objstm-object')

    def text_string(self, value):
        value = self.deref(value)
        if not isinstance(value, bytes):
            return None
        if value[:2] == b'\xfe\xff':
            text = value[2:].decode('utf-16-be', 'replace')
        elif value[:2] == b'\xff\xfe':
            text = value[2:].decode('utf-16-le', 'replace')
        elif value[:3] == b'\xef\xbb\xbf':
            text = value[3:].decode('utf-8', 'replace')
        else:
            text = value.decode('latin-1')
        text = ''.join(c if c.isprintable() or c in ' \n\t' else ' ' for c in text)
        text = ' '.join(text.split())
        return text[:MAX_ALT_CHARS] or None


# ---- page tree ----

def _inherited(file, node, key, trail):
    for n in trail:
        v = file.deref(n.get(key))
        if v is not None:
            return v
    return None


def iter_pages(file, first, last):
    """Yield (page_number, page_dict, objnum, ancestors) for pages in [first, last], skipping subtrees by /Count."""
    root = file.deref(file.catalog.get('Pages'))
    if not isinstance(root, dict):
        raise Unknown('no-page-tree')
    visited = set()
    nodes = [0]
    number = [1]

    def visit(ref, node, trail, depth):
        if depth > MAX_TREE_DEPTH:
            raise Unknown('tree-depth')
        nodes[0] += 1
        if nodes[0] > MAX_TREE_NODES:
            raise Unknown('tree-size')
        file.check_time()
        kids = file.deref(node.get('Kids'))
        if not isinstance(kids, list) or node.get('Type') == 'Page':
            if first <= number[0] <= last:
                yield number[0], node, (ref.num if isinstance(ref, Ref) else None), trail
            number[0] += 1
            return
        for kid in kids:
            if number[0] > last:
                return
            child = file.deref(kid)
            if not isinstance(child, dict):
                continue
            if isinstance(kid, Ref):
                if kid.num in visited:
                    continue
                visited.add(kid.num)
            count = file.deref(child.get('Count'))
            is_node = isinstance(file.deref(child.get('Kids')), list) and child.get('Type') != 'Page'
            if is_node and isinstance(count, int) and 0 <= count and number[0] + count - 1 < first:
                number[0] += count
                continue
            yield from visit(kid, child, [child] + trail, depth + 1)

    yield from visit(None, root, [root], 0)


def _box(file, value):
    value = file.deref(value)
    if not (isinstance(value, list) and len(value) == 4):
        return None
    nums = [_number(file.deref(v), None) for v in value]
    if any(v is None for v in nums):
        return None
    x0, x1 = sorted((nums[0], nums[2]))
    y0, y1 = sorted((nums[1], nums[3]))
    return [x0, y0, x1, y1] if x1 - x0 > 0 and y1 - y0 > 0 and max(abs(v) for v in nums) < 1e7 else None


# ---- content streams ----

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mul(m, n):
    """Matrix product m × n in PDF's row-vector convention: the point goes through m first, then n."""
    return (m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
            m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5])


class Draw:
    __slots__ = ('kind', 'obj', 'matrix', 'order', 'text_before', 'mcid', 'alt', 'alt_source', 'inline', 'dims')

    def __init__(self, kind, obj, matrix, order, text_before, mcid, alt, alt_source, dims=None):
        self.kind, self.obj, self.matrix, self.order, self.text_before, self.dims = kind, obj, matrix, order, text_before, dims
        self.mcid, self.alt, self.alt_source = mcid, alt, alt_source
        self.inline = kind == 'inline'


class PageWalk:
    def __init__(self, number, objnum):
        self.number, self.objnum = number, objnum
        self.width = self.height = None
        self.rotate = 0
        self.media = self.crop = None
        self.draws = []
        self.text_ops = 0
        self.unknown = None  # reason slug when draws are not reliable


def _page_geometry(file, page, trail, walk):
    media = _box(file, _inherited(file, page, 'MediaBox', [page] + trail)) or [0.0, 0.0, 612.0, 792.0]
    crop = _box(file, _inherited(file, page, 'CropBox', [page] + trail))
    rotate = _inherited(file, page, 'Rotate', [page] + trail)
    rotate = int(rotate) % 360 if isinstance(rotate, (int, float)) and not isinstance(rotate, bool) and int(rotate) % 90 == 0 else 0
    walk.media, walk.rotate = media, rotate
    if crop:  # visible area = crop ∩ media, as viewers show it
        c = [max(crop[0], media[0]), max(crop[1], media[1]), min(crop[2], media[2]), min(crop[3], media[3])]
        walk.crop = c if c[2] > c[0] and c[3] > c[1] else None
    w, h = media[2] - media[0], media[3] - media[1]
    walk.width, walk.height = (h, w) if rotate in (90, 270) else (w, h)


def display_matrix(media, rotate):
    """User space → displayed page space (points, origin top-left, y down), as a PDF matrix."""
    x0, y0, x1, y1 = media
    w, h = x1 - x0, y1 - y0
    base = (1.0, 0.0, 0.0, -1.0, -x0, y1)  # X = x - x0, Y = y1 - y
    if rotate == 90:   # X' = H - Y, Y' = X
        return mul(base, (0.0, 1.0, -1.0, 0.0, h, 0.0))
    if rotate == 180:  # X' = W - X, Y' = H - Y
        return mul(base, (-1.0, 0.0, 0.0, -1.0, w, h))
    if rotate == 270:  # X' = Y, Y' = W - X
        return mul(base, (0.0, -1.0, 1.0, 0.0, 0.0, w))
    return base


class Walker:
    def __init__(self, file, struct_alt):
        self.file = file
        self.struct_alt = struct_alt

    def page_streams(self, page):
        contents = self.file.deref(page.get('Contents'))
        parts = contents if isinstance(contents, list) else [contents]
        total, out = 0, []
        for part in parts:
            s = self.file.deref(part)
            if isinstance(s, Stream):
                data = self.file.stream_data(s, MAX_PAGE_CONTENT - total + 1)
                total += len(data)
                if total > MAX_PAGE_CONTENT:
                    raise Unknown('content-too-large')
                out.append(data)
        return b'\n'.join(out)

    def walk_page(self, walk, page, resources):
        state = {'ops': 0, 'forms': 0, 'order': 0}
        deadline_check = self.file.check_time
        base = display_matrix(walk.media, walk.rotate)
        self._run(walk, self.page_streams(page), resources, base, state, [], 0, deadline_check)

    def _run(self, walk, data, resources, ctm, state, active_forms, depth, check):
        file = self.file
        lx = Lexer(data, refs=False)
        operands, mc = [], []
        gs_stack = []
        props = file.deref(resources.get('Properties')) if isinstance(resources, dict) else None
        xobjects = file.deref(resources.get('XObject')) if isinstance(resources, dict) else None
        while True:
            try:
                tok = lx.obj()
            except Incomplete:
                return
            if not isinstance(tok, Lexer.Keyword):
                operands.append(tok)
                if len(operands) > 64:
                    del operands[:32]
                continue
            state['ops'] += 1
            if state['ops'] > MAX_PAGE_OPERATIONS:
                raise Unknown('operation-budget')
            if state['ops'] & 0x3FFF == 0:
                check()
            op = str(tok)
            if op == 'q':
                if len(gs_stack) < MAX_GSTATE_DEPTH:
                    gs_stack.append(ctm)
            elif op == 'Q':
                if gs_stack:
                    ctm = gs_stack.pop()
            elif op == 'cm' and len(operands) >= 6:
                m = tuple(_number(v) for v in operands[-6:])
                ctm = mul(m, ctm)
            elif op in ('Tj', 'TJ', "'", '"'):
                walk.text_ops += 1
            elif op == 'BMC':
                if len(mc) < 64:
                    mc.append((None, None, None))
            elif op == 'BDC':
                tag = operands[-2] if len(operands) >= 2 else None
                prop = operands[-1] if operands else None
                if isinstance(prop, Name) and isinstance(props, dict):
                    prop = file.deref(props.get(str(prop)))
                if len(mc) < 64:
                    mcid = prop.get('MCID') if isinstance(prop, dict) else None
                    alt = None
                    if isinstance(prop, dict):
                        for key in ('Alt', 'ActualText'):
                            alt = file.text_string(prop.get(key))
                            if alt:
                                break
                    mc.append((tag, mcid if isinstance(mcid, int) and not isinstance(mcid, bool) else None, alt))
            elif op == 'EMC':
                if mc:
                    mc.pop()
            elif op == 'Do' and operands and isinstance(operands[-1], Name):
                self._do(walk, str(operands[-1]), xobjects, resources, ctm, state, active_forms, depth, mc, check)
            elif op == 'BI':
                self._inline_image(walk, lx, ctm, state, mc)
            operands.clear()

    def _marked(self, mc):
        mcid = alt = None
        for tag, m, a in reversed(mc):
            if mcid is None and m is not None:
                mcid = m
            if alt is None and a:
                alt = a
        return mcid, alt

    def _record(self, walk, kind, obj, matrix, state, mc, dims=None):
        if len(walk.draws) >= MAX_PAGE_DRAWS:
            raise Unknown('draw-budget')
        mcid, alt = self._marked(mc)
        source = 'marked-content' if alt else None
        if not alt and mcid is not None:
            alt = self.struct_alt.get((walk.objnum, mcid))
            source = 'struct-figure' if alt else None
        if not alt and obj is not None:
            alt = self.struct_alt.get(('obj', obj[0]))
            source = 'struct-figure' if alt else None
        walk.draws.append(Draw(kind, obj, matrix, state['order'], walk.text_ops, mcid, alt, source, dims))
        state['order'] += 1

    def _do(self, walk, name, xobjects, resources, ctm, state, active_forms, depth, mc, check):
        file = self.file
        if not isinstance(xobjects, dict) or name not in xobjects:
            return
        ref = xobjects[name]
        obj = file.deref(ref)
        if not isinstance(obj, Stream):
            return
        subtype = file.deref(obj.dict.get('Subtype'))
        if subtype == 'Image':
            w, h = file.deref(obj.dict.get('Width')), file.deref(obj.dict.get('Height'))
            self._record(walk, 'xobject', (ref.num, ref.gen) if isinstance(ref, Ref) else None, ctm, state, mc,
                         (w, h) if isinstance(w, int) and isinstance(h, int) else None)
        elif subtype == 'Form':
            if depth >= MAX_FORM_DEPTH or (isinstance(ref, Ref) and ref.num in active_forms):
                return
            state['forms'] += 1
            if state['forms'] > MAX_FORMS_PER_PAGE:
                raise Unknown('form-budget')
            matrix = file.deref(obj.dict.get('Matrix'))
            m = tuple(_number(file.deref(v)) for v in matrix) if isinstance(matrix, list) and len(matrix) == 6 else IDENTITY
            res = file.deref(obj.dict.get('Resources'))
            res = res if isinstance(res, dict) else resources
            data = file.stream_data(obj, MAX_PAGE_CONTENT)
            self._run(walk, data, res, mul(m, ctm), state, active_forms + ([ref.num] if isinstance(ref, Ref) else []), depth + 1, check)

    @staticmethod
    def _find_ei(data, search, start):
        limit = min(len(data), start + MAX_INLINE_IMAGE)
        while True:
            m = _EI.search(data, search, limit)
            if not m:
                return -1
            # Accept an EI only if what follows looks like ordinary operators, not binary noise.
            if _EI_TAIL.fullmatch(data[m.end():m.end() + 24]):
                return m.end()
            search = m.start() + 1

    def _inline_image(self, walk, lx, ctm, state, mc):
        # BI <dict entries> ID <data> EI. Only the geometry matters; the data is skipped, not decoded.
        data = lx.data
        entries = {}
        while True:
            try:
                key = lx.token()
            except Incomplete:
                return
            if isinstance(key, Lexer.Keyword) and key == 'ID':
                break
            if not isinstance(key, Name):
                continue
            try:
                entries[str(key)] = lx.obj()
            except Incomplete:
                return
        start = lx.pos + 1  # a single whitespace follows ID
        width, height = entries.get('W', entries.get('Width')), entries.get('H', entries.get('Height'))
        pos = start
        filt = entries.get('F', entries.get('Filter'))
        if filt is None and isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            bpc = entries.get('BPC', entries.get('BitsPerComponent', 8))
            cs = entries.get('CS', entries.get('ColorSpace'))
            comps = {'G': 1, 'DeviceGray': 1, 'RGB': 3, 'DeviceRGB': 3, 'CMYK': 4, 'DeviceCMYK': 4}.get(str(cs) if isinstance(cs, str) else '', 1)
            if entries.get('IM', entries.get('ImageMask')) is True:
                bpc, comps = 1, 1
            if isinstance(bpc, int) and 0 < bpc <= 16:
                pos = start + height * ((width * comps * bpc + 7) // 8)
                if pos > len(data):
                    pos = start
        end = self._find_ei(data, pos, start)
        if end < 0 and pos != start:
            end = self._find_ei(data, start, start)
        if end < 0:
            raise Unknown('inline-image')
        lx.pos = end
        if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            self._record(walk, 'inline', None, ctm, state, mc, (width, height))


def struct_alt_text(file):
    """(page object, MCID) → Alt text for Figure structure elements, plus ('obj', n) → Alt for object references."""
    out = {}
    root = file.deref(file.catalog.get('StructTreeRoot'))
    if not isinstance(root, dict):
        return out
    role_map = file.deref(root.get('RoleMap'))
    role_map = role_map if isinstance(role_map, dict) else {}
    budget = [MAX_STRUCT_NODES]

    def role(s):
        s = str(s) if s is not None else ''
        seen = 0
        while s in role_map and seen < 8:
            s, seen = str(role_map[s]), seen + 1
        return s

    def walk(node, page_ref, alt, depth):
        budget[0] -= 1
        if budget[0] < 0 or depth > 60:
            raise Unknown('struct-budget')
        value = file.deref(node)
        if isinstance(value, int) and not isinstance(value, bool):
            if alt and page_ref is not None:
                out.setdefault((page_ref, value), alt)
            return
        if isinstance(value, list):
            for kid in value:
                walk(kid, page_ref, alt, depth + 1)
            return
        if not isinstance(value, dict):
            return
        kind = value.get('Type')
        if kind == 'MCR':
            pg = value.get('Pg')
            mcid = file.deref(value.get('MCID'))
            if alt and isinstance(mcid, int):
                out.setdefault(((pg.num if isinstance(pg, Ref) else page_ref), mcid), alt)
            return
        if kind == 'OBJR':
            target = value.get('Obj')
            if alt and isinstance(target, Ref):
                out.setdefault(('obj', target.num), alt)
            return
        pg = value.get('Pg')
        page_ref = pg.num if isinstance(pg, Ref) else page_ref
        own = None
        if role(value.get('S')) in ('Figure', 'Formula'):
            own = file.text_string(value.get('Alt')) or file.text_string(value.get('ActualText'))
        if 'K' in value:
            walk(value['K'], page_ref, own or alt, depth + 1)

    try:
        walk(root.get('K'), None, None, 0)
    except Unknown:
        pass  # alt text is optional; a hostile or huge tree yields what was collected, never a failure
    return out


def walk_document(path, first, last, deadline=None, only_pages=None):
    """Walk pages [first, last]. Returns {page: PageWalk}; a page with `unknown` set carries no reliable draws.

    Raises Unknown only for whole-file reasons (encrypted, unreadable xref); callers treat every page as unknown then.
    """
    if last - first + 1 > MAX_PAGES_WALKED:
        raise Unknown('range')
    file = PdfFile(path, deadline)
    try:
        try:
            alt = struct_alt_text(file)
        except (Unknown, RecursionError, MemoryError, ValueError, TypeError, IndexError, KeyError, struct.error):
            alt = {}
        walker = Walker(file, alt)
        pages = {}
        for number, page, objnum, trail in iter_pages(file, first, last):
            if only_pages is not None and number not in only_pages:
                continue
            walk = PageWalk(number, objnum)
            pages[number] = walk
            try:
                _page_geometry(file, page, trail, walk)
                resources = file.deref(_inherited(file, page, 'Resources', [page] + trail))
                walker.walk_page(walk, page, resources if isinstance(resources, dict) else {})
            except Unknown as error:
                walk.unknown, walk.draws = str(error) or 'unknown', []
            except (RecursionError, MemoryError, ValueError, TypeError, IndexError, KeyError, OverflowError, struct.error):
                walk.unknown, walk.draws = 'walker-error', []
        return pages
    finally:
        file.close()


# ---- from a matrix to published placement facts ----

def visible_box(walk):
    """The visible page area in displayed coordinates: crop box ∩ media box (as viewers show it), else the media box."""
    box = walk.crop or walk.media
    matrix = display_matrix(walk.media, walk.rotate)
    pts = [(box[0], box[1]), (box[2], box[1]), (box[0], box[3]), (box[2], box[3])]
    mapped = [(x * matrix[0] + y * matrix[2] + matrix[4], x * matrix[1] + y * matrix[3] + matrix[5]) for x, y in pts]
    xs, ys = [p[0] for p in mapped], [p[1] for p in mapped]
    return [min(xs), min(ys), max(xs), max(ys)]


def placement_from_draw(draw, walk):
    """Geometry of one draw in the displayed page's coordinate space (points, origin top-left), or None if not finite.

    `matrix` already includes the page's rotation and the flip to a top-left origin. The image's unit square corners
    give the bounding box; the matrix columns give size, rotation and mirroring.
    """
    a, b, c, d, e, f = draw.matrix
    corners = [(e, f), (a + e, b + f), (c + e, d + f), (a + c + e, b + d + f)]
    xs, ys = [p[0] for p in corners], [p[1] for p in corners]
    if not all(math.isfinite(v) and abs(v) < 1e7 for v in xs + ys):
        return None
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    vx0, vy0, vx1, vy1 = visible_box(walk)
    visible_area = max((vx1 - vx0) * (vy1 - vy0), 1e-9)
    ix = max(0.0, min(x1, vx1) - max(x0, vx0))
    iy = max(0.0, min(y1, vy1) - max(y0, vy0))
    # The image's own area (a parallelogram when rotated), capped by its clipped bounding box.
    own = abs(a * d - b * c)
    box_area = (x1 - x0) * (y1 - y0)
    coverage = min(own, ix * iy) / visible_area if own < box_area - 1e-6 else ix * iy / visible_area
    # In displayed space u=(a,b) is the stored picture's x axis and "down the picture" is -v (image space has y up):
    # a positive u × down determinant is an unmirrored picture, and u's clockwise angle is its rotation.
    rotation = math.degrees(math.atan2(b, a)) % 360
    mirrored = (a * (-d) - b * (-c)) < 0
    return {
        'bbox': [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
        'widthPt': round(math.hypot(a, b), 2), 'heightPt': round(math.hypot(c, d), 2),
        'rotationDegrees': round(rotation, 1), 'mirrored': mirrored,
        'coverage': round(max(0.0, min(1.0, coverage)), 4),
        'pageWidthPt': round(walk.width, 2), 'pageHeightPt': round(walk.height, 2),
    }


# ---- poppler's `pdfimages -list`, and the join between its rows and the walker's draws ----

LISTING_COLORS = frozenset(('gray', 'cal', 'rgb', 'cmyk', 'lab', 'icc', 'index', 'sep', 'devn', '-'))
LISTING_ENCODINGS = frozenset(('image', 'rle', 'ccitt', 'jpeg', 'jpx', 'jbig2'))
LISTING_ROLES = ('image', 'mask', 'smask', 'stencil')
_SIZE = re.compile(r'(\d+(?:\.\d+)?)([BKMG]?)')


def parse_listing_row(fields):
    """One `pdfimages -list` row as a dict, or raise ValueError. Columns: page num type width height color comp bpc enc
    interp object ID x-ppi y-ppi size ratio (an inline image has `[inline]` and no ID, so 15 columns)."""
    if len(fields) == 15 and fields[10] in ('[inline]', '[none]'):
        fields = fields[:11] + ['-'] + fields[11:]
    if len(fields) != 16 or fields[2] not in LISTING_ROLES:
        raise ValueError('invalid image inventory')
    page, number, role, width, height = int(fields[0]), int(fields[1]), fields[2], int(fields[3]), int(fields[4])
    size = _SIZE.fullmatch(fields[14])
    inline = not (fields[10].isdigit() and fields[11].isdigit())
    return {
        'pageNumber': page, 'occurrence': number, 'role': role, 'width': width, 'height': height,
        'colorSpace': fields[5] if fields[5] in LISTING_COLORS else 'other',
        'components': int(fields[6]) if fields[6].isdigit() and 0 < int(fields[6]) <= 32 else None,
        'bitsPerComponent': int(fields[7]) if fields[7].isdigit() and 0 < int(fields[7]) <= 32 else None,
        'encoding': fields[8] if fields[8] in LISTING_ENCODINGS else 'other',
        'interpolate': fields[9] == 'yes',
        'objectId': None if inline else (int(fields[10]), int(fields[11])),
        'inline': inline,
        'ppi': [_ppi(fields[12]), _ppi(fields[13])],
        'streamBytes': round(float(size[1]) * 1024 ** 'BKMG'.index(size[2] or 'B')) if size else None,
    }


def _ppi(text):
    return int(text) if text.isdigit() and int(text) <= 1_000_000 else None


def match_placements(rows, walks):
    """Join listing rows (image/stencil bases; masks inherit) to walker draws. Returns {occurrence: (draw, walk, how)}.

    A base row is placed only when identity agrees: the same PDF object (or inline image) with the same pixel size, and
    the page's draws of that identity are as many as its listing rows. `how` is `sequence` when the whole page lined
    up draw for draw, `object` when only that identity did. Anything else stays unplaced (unknown), never guessed.
    """
    placed = {}
    by_page = collections.defaultdict(list)
    for row in rows:
        if row['role'] in ('image', 'stencil'):
            by_page[row['pageNumber']].append(row)
    for page, bases in by_page.items():
        walk = walks.get(page)
        if walk is None or walk.unknown:
            continue
        draws = walk.draws
        key = lambda x: (x['objectId'] if not x['inline'] else None, (x['width'], x['height']))
        dkey = lambda d: (d.obj if d.kind == 'xobject' else None, d.dims)
        if len(bases) == len(draws) and all(key(r) == dkey(d) or (r['inline'] and d.kind == 'inline') for r, d in zip(bases, draws)):
            for r, d in zip(bases, draws):
                placed[r['occurrence']] = (d, walk, 'sequence')
            continue
        groups, rgroups = collections.defaultdict(list), collections.defaultdict(list)
        for d in draws:
            groups[d.obj if d.kind == 'xobject' else None].append(d)
        for r in bases:
            rgroups[r['objectId'] if not r['inline'] else None].append(r)
        for ident, rs in rgroups.items():
            ds = groups.get(ident, [])
            if len(rs) == len(ds) and all(r['inline'] or d.dims is None or d.dims == (r['width'], r['height']) for r, d in zip(rs, ds)):
                for r, d in zip(rs, ds):
                    placed[r['occurrence']] = (d, walk, 'object')
    return placed


# ---- raster statistics (Pillow when the guest image provides it) ----

# The shared contract's literal (packages/shared/src/media-map.ts PIXEL_SIGNALS_VERSION in the core repo).
SIGNALS_VERSION = 'pixel-signals@1'
THUMB_SIDE = 192          # longest side of the colour/edge thumbnail
DECODE_PIXEL_LIMIT = 16_000_000


def _pixels(image):
    flat = getattr(image, 'get_flattened_data', None)
    return list(flat() if flat else image.getdata())


def _entropy(histogram, total):
    return max(0.0, -sum((c / total) * math.log2(c / total) for c in histogram if c))


def pixel_signals(png_bytes, ppi_hint=None):
    """Measured raster statistics for one extracted PNG, or (None, reason) when they cannot be taken.

    Everything is computed from a bounded thumbnail (and one row-projection), with no model and no OCR. The numbers
    are measurements; the host's threshold table (core/packages/shared/src/image-routing.ts) interprets them.
    """
    try:
        from PIL import Image, ImageChops
    except Exception:
        return None, 'pillow-unavailable'
    import io
    try:
        Image.MAX_IMAGE_PIXELS = DECODE_PIXEL_LIMIT + 1
        with Image.open(io.BytesIO(png_bytes)) as source:
            if source.width * source.height > DECODE_PIXEL_LIMIT:
                return None, 'too-large'
            source.load()
            im = source
            has_alpha = im.mode in ('LA', 'RGBA', 'PA') or 'transparency' in im.info
            alpha_mean = None
            if has_alpha:
                alpha = im.convert('RGBA').getchannel('A')
                alpha_mean = round(sum(i * c for i, c in enumerate(alpha.histogram())) / max(1, im.width * im.height) / 255, 3)
            if im.mode == 'I;16':
                im = im.point(lambda v: v / 256, 'L')
            gray = im.convert('L')
            bilevel_levels = gray.getcolors(maxcolors=3)
            exact_levels = len(bilevel_levels) if bilevel_levels is not None else None
            factor = max(1, math.ceil(max(im.width, im.height) / THUMB_SIDE))
            thumb_l = gray.reduce(factor) if factor > 1 else gray
            rgb = im.convert('RGB')
            thumb_c = rgb.reduce(factor) if factor > 1 else rgb
            n = thumb_l.width * thumb_l.height
            hist = thumb_l.histogram()
            luma_mean = sum(i * c for i, c in enumerate(hist)) / n
            luma_sd = math.sqrt(sum(c * (i - luma_mean) ** 2 for i, c in enumerate(hist)) / n)
            quant = thumb_c.point([v & 0xF0 for v in range(256)] * 3)
            colors = quant.getcolors(maxcolors=4097) or []
            top_share = max((c for c, _ in colors), default=0) / n
            sat = thumb_c.convert('HSV').getchannel('S').histogram()
            saturation = sum(i * c for i, c in enumerate(sat)) / n
            # Edges: share of pixels whose luma differs from the right/lower neighbour by more than 24 levels.
            dx = ImageChops.difference(thumb_l, ImageChops.offset(thumb_l, 1, 0)).point([255 if v > 24 else 0 for v in range(256)])
            dy = ImageChops.difference(thumb_l, ImageChops.offset(thumb_l, 0, 1)).point([255 if v > 24 else 0 for v in range(256)])
            edge_share = (dx.histogram()[255] + dy.histogram()[255]) / (2 * n)
            # Ink: share of full-resolution pixels far from the dominant (background) luma level. The thumbnail would
            # average thin strokes into the ground, so this reads the full image's histogram (C speed, no pixel loop).
            full = gray.histogram()
            levels = [0] * 16
            for i, c in enumerate(full):
                levels[i >> 4] += c
            background = max(range(16), key=levels.__getitem__) * 16 + 8
            ink_share = sum(c for i, c in enumerate(full) if abs(i - background) > 64) / (im.width * im.height)
            # Text bands: rows of the image reduced to one column (each pixel is a band of `fy` rows' mean). Lines of
            # text are runs of rows that differ from the page ground, at a regular pitch.
            fy = max(1, round(ppi_hint / 50)) if ppi_hint else max(1, im.height // 400)
            fy = min(fy, im.height)
            profile = _pixels(gray.reduce((gray.width, max(1, fy))))
            bands, pitches, inked_before, previous_start = 0, [], False, None
            if profile:
                row_background = sorted(profile)[len(profile) // 2]
                for i, v in enumerate(profile):
                    inked = abs(v - row_background) > 8
                    if inked and not inked_before:
                        bands += 1
                        if previous_start is not None:
                            pitches.append(i - previous_start)
                        previous_start = i
                    inked_before = inked
            pitch_spread = None
            if len(pitches) >= 3:
                ordered = sorted(pitches)
                median = ordered[len(ordered) // 2]
                deviations = sorted(abs(p - median) for p in pitches)
                pitch_spread = round(deviations[len(deviations) // 2] / median, 3) if median else None
            small = thumb_l.resize((9, 8), Image.BILINEAR)
            px = _pixels(small)
            bits = 0
            for r in range(8):
                for c in range(8):
                    bits = (bits << 1) | (1 if px[r * 9 + c] > px[r * 9 + c + 1] else 0)
            return {
                'version': SIGNALS_VERSION,
                'lumaMean': round(luma_mean, 1), 'lumaStdDev': round(luma_sd, 1),
                'bilevel': exact_levels is not None and exact_levels <= 2,
                'quantizedColors': len(colors), 'topColorShare': round(top_share, 4),
                'saturation': round(saturation, 1), 'entropy': round(_entropy(hist, n), 2),
                'edgeShare': round(edge_share, 4), 'inkShare': round(ink_share, 4),
                'textBands': bands, 'bandPitchSpread': pitch_spread,
                'alphaMean': alpha_mean, 'dhash': f'{bits:016x}',
                'sample': [thumb_l.width, thumb_l.height],
            }, None
    except MemoryError:
        return None, 'memory'
    except Exception:
        return None, 'decode-failed'


# ---- reading-order anchors: where an image goes in a page's Markdown ----

import html as _html

_FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
_FENCE_CLOSE = re.compile(r'^ {0,3}(`{3,}|~{3,})\s*$')
_TABLE_OPEN = re.compile(r'^ {0,3}<table(?=\s|>|$)', re.IGNORECASE)
_TABLE_CLOSE = re.compile(r'</table\s*>', re.IGNORECASE)
_TOKEN = re.compile(r'[^\W_]+', re.UNICODE)
_LINK_TARGET = re.compile(r'\]\([^)]*\)')
_TAG = re.compile(r'<[^>]*>')
MAX_ANCHOR_WORDS = 20_000   # words considered per page; more than that is not a prose page worth aligning
MAX_ANCHOR_BLOCKS = 4_000
ANCHOR_COLUMN_OVERLAP = 0.3
ANCHOR_TOLERANCE_PT = 2.0
_PAGE = re.compile(r'<page\b([^>]*)>', re.IGNORECASE)
_WORD = re.compile(r'<word\s+xMin="(-?[0-9.]+)"\s+yMin="(-?[0-9.]+)"\s+xMax="(-?[0-9.]+)"\s+yMax="(-?[0-9.]+)"[^>]*>([^<]*)</word>')


def markdown_blocks(page):
    """[first_line, last_line] of each Markdown block of one page. Mirrors `markdownBlocks` in image-anchors.ts."""
    lines = page.split('\n')
    blocks, i, n = [], 0, len(lines)
    while i < n:
        while i < n and not lines[i].strip():
            i += 1
        if i >= n:
            break
        start = i
        fence = _FENCE.match(lines[i])
        if fence:
            marker, length = fence.group(1)[0], len(fence.group(1))
            i += 1
            while i < n:
                close = _FENCE_CLOSE.match(lines[i])
                i += 1
                if close and close.group(1)[0] == marker and len(close.group(1)) >= length:
                    break
        elif _TABLE_OPEN.match(lines[i]):
            while i < n:
                closes = _TABLE_CLOSE.search(lines[i])
                i += 1
                if closes:
                    break
        else:
            while i < n and lines[i].strip():
                i += 1
        blocks.append([start, i - 1])
    return blocks


def _tokens(text):
    return _TOKEN.findall(text.casefold())


_HEIGHT = re.compile(r'height="([0-9.]+)"')


def page_words(xhtml, wanted):
    """{page_offset: (page_height, [(x0, y0, x1, y1, text), ...])} for the zero-based page offsets in `wanted` of one chunk."""
    starts = [m.start() for m in _PAGE.finditer(xhtml)]
    out = {}
    for offset in wanted:
        if offset >= len(starts):
            continue
        end = starts[offset + 1] if offset + 1 < len(starts) else len(xhtml)
        words = []
        height = _HEIGHT.search(xhtml, starts[offset], min(end, starts[offset] + 200))
        for m in _WORD.finditer(xhtml, starts[offset], end):
            if len(words) >= MAX_ANCHOR_WORDS:
                words = None
                break
            words.append((float(m[1]), float(m[2]), float(m[3]), float(m[4]), _html.unescape(m[5])))
        if words is not None:
            out[offset] = (float(height[1]) if height else None, words)
    return out


def block_anchors(page_markdown, words, images, page_height=None):
    """Where each image goes in this page's Markdown.

    `images` are bounding boxes (x0, y0, x1, y1) in the text layer's frame, or None when placement is unknown. Returns one
    {'block', 'blocks', 'method', 'matchedBlocks'} per image. A Markdown block is matched to the text layer by its leading
    words; an image goes before the first block, in Markdown order, that is in its column and starts at or below the image's
    top edge (after the last such block when none does). Blocks with no text match (tables, formulas) are never used as
    references. `page-start` / `page-end` report the fallback when nothing could be aligned; they are not an alignment.
    """
    spans = markdown_blocks(page_markdown)
    total = len(spans)
    lines = page_markdown.split('\n')
    if total > MAX_ANCHOR_BLOCKS:
        words, page_height = None, None   # too large to align: every image takes the fallback
    # Page tokens, each tied to the word it came from.
    page_tokens, token_word = [], []
    for index, word in enumerate(words or ()):
        for token in _tokens(word[4]):
            page_tokens.append(token)
            token_word.append(index)
    positions = {}
    for i, token in enumerate(page_tokens):
        positions.setdefault(token, []).append(i)
    matched = []   # (block index, x0, top, x1 or None, bottom or None)
    cursor = 0
    taken = set()
    for index, (first, last) in enumerate(spans):
        text = _TAG.sub(' ', _LINK_TARGET.sub(']', '\n'.join(lines[first:last + 1])))
        block_tokens = _tokens(text)
        if not block_tokens or not page_tokens:
            continue
        k = min(3, len(block_tokens))
        head = block_tokens[:k]
        candidates = [i for i in positions.get(head[0], ()) if page_tokens[i:i + k] == head and i not in taken]
        if not candidates:
            continue
        ahead = [i for i in candidates if i >= cursor]
        start = (ahead or candidates)[0]
        taken.add(start)
        cursor = start
        first_word = words[token_word[start]]
        end = start + len(block_tokens) - 1
        tail = block_tokens[-k:]
        if end < len(page_tokens) and page_tokens[end - k + 1:end + 1] == tail and end - start < MAX_ANCHOR_WORDS:
            run = words[token_word[start]:token_word[end] + 1]
            matched.append((index, min(w[0] for w in run), min(w[1] for w in run), max(w[2] for w in run), max(w[3] for w in run)))
            cursor = end
        else:
            matched.append((index, first_word[0], first_word[1], None, None))
    results = []
    for box in images:
        if total == 0:
            results.append({'block': 0, 'blocks': 0, 'method': 'page-start', 'matchedBlocks': 0})
            continue
        if box is None or not matched:
            # Nothing to align against: say so. Use the page's end unless the image is known to sit in its top half.
            top_half = box is not None and bool(page_height) and (box[1] + box[3]) / 2 < page_height / 2
            results.append({'block': 0 if top_half else total, 'blocks': total, 'method': 'page-start' if top_half else 'page-end', 'matchedBlocks': len(matched)})
            continue
        x0, y0, x1, y1 = box
        narrow = lambda a0, a1: max(1e-6, min(a1 - a0, x1 - x0))
        def in_column(m):
            if m[3] is None:
                return x0 - 5 <= m[1] <= x1 + 5
            return (min(m[3], x1) - max(m[1], x0)) >= ANCHOR_COLUMN_OVERLAP * narrow(m[1], m[3])
        column = [m for m in matched if in_column(m)] or matched
        below = [m for m in column if m[2] >= y0 - ANCHOR_TOLERANCE_PT]
        block = below[0][0] if below else column[-1][0] + 1
        results.append({'block': block, 'blocks': total, 'method': 'aligned', 'matchedBlocks': len(matched)})
    return results


# ---- page layout facts for routing: images with their stream facts and text overlap, and tables (pdf-layout-facts@1) ----

LAYOUT_VERSION = 'pdf-layout-facts@1'
MAX_LAYOUT_PAGES = 5_000
MAX_LAYOUT_IMAGES_PER_PAGE = 64
MAX_LAYOUT_TABLES_PER_PAGE = 64
_PIPE_ROW = re.compile(r'^\s*\|(.*)\|\s*$')
_PIPE_SEPARATOR = re.compile(r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$')
_TR = re.compile(r'<tr[\s>]', re.IGNORECASE)
_CELL = re.compile(r'<t[dh][\s>]', re.IGNORECASE)


def repeated_objects(rows, page_count, min_pages=3, min_share=0.2):
    """Image objects drawn on at least `min_pages` pages and that share of the listed pages: page furniture (a logo,
    a letterhead), never a scan. Mirrors PAGE_RASTER_ROUTING.repeatedImage* in packages/shared/src/page-raster-routing.ts."""
    pages = collections.defaultdict(set)
    for row in rows:
        if row['role'] in ('image', 'stencil') and row['objectId'] is not None:
            pages[row['objectId']].add(row['pageNumber'])
    floor = max(min_pages, math.ceil(min_share * max(1, page_count)))
    return {obj for obj, seen in pages.items() if len(seen) >= floor}


def markdown_tables(page_markdown):
    """Each table in one page's Markdown (GFM pipe tables and HTML tables): its rows (separator lines excluded), its widest
    row's cell count, and its cell tokens. Counted from the extractor's own output."""
    lines = page_markdown.split('\n')
    tables = []
    for first, last in markdown_blocks(page_markdown):
        block = lines[first:last + 1]
        if _TABLE_OPEN.match(block[0]):
            html = '\n'.join(block)
            rows = [part for part in _TR.split(html)[1:]]
            if not rows:
                continue
            tables.append({'rows': len(rows), 'columns': max(len(_CELL.findall(row)) for row in rows),
                           'tokens': _tokens(_TAG.sub(' ', html))})
            continue
        pipe = [line for line in block if _PIPE_ROW.match(line) and not _PIPE_SEPARATOR.match(line)]
        if len(pipe) >= 2 and len(pipe) >= len([line for line in block if line.strip()]) - 1:
            tables.append({'rows': len(pipe), 'columns': max(len(_PIPE_ROW.match(line)[1].split('|')) for line in pipe),
                           'tokens': _tokens(' '.join(block))})
        if len(tables) >= MAX_LAYOUT_TABLES_PER_PAGE:
            break
    return tables


def _area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


TABLE_MATCH_WINDOW = 40      # words skipped at most between two consecutive cell tokens
TABLE_MATCH_STARTS = 32      # candidate starts tried for a table's first token


def table_box(tokens, words, used):
    """The box of the text-layer words a table's cell tokens match in reading order (each token found within
    TABLE_MATCH_WINDOW page tokens of the previous match; each page token used once), or None when under half the tokens
    match. Matching in order keeps a common word elsewhere on the page from stretching the table's box."""
    if not tokens or not words:
        return None
    page_tokens = [(token, index) for index, word in enumerate(words) for token in _tokens(word[4])]
    starts = [i for i, (token, _) in enumerate(page_tokens) if i not in used and token == tokens[0]][:TABLE_MATCH_STARTS]
    best = []
    for start in starts:
        hits, cursor = [start], start
        for token in tokens[1:]:
            for position in range(cursor + 1, min(len(page_tokens), cursor + 1 + TABLE_MATCH_WINDOW)):
                if position not in used and page_tokens[position][0] == token:
                    hits.append(position)
                    cursor = position
                    break
        if len(hits) > len(best):
            best = hits
    if len(best) * 2 < len(tokens):
        return None
    used.update(best)
    chosen = [words[page_tokens[position][1]] for position in best]
    return [min(w[0] for w in chosen), min(w[1] for w in chosen), max(w[2] for w in chosen), max(w[3] for w in chosen)]


def layout_facts(path, listing_text, xhtml_text, page_markdowns, first, last, deadline=None):
    """Structural layout facts for routing, per page in [first, last]:

    * images: each listed image drawn on the page with its placement (walker), stream facts (`pdfimages -list`: pixel
      size, bits per component, colour space, encoding, ppi, stream bytes), whether it is repeated page furniture, and how
      many of the text layer's words sit inside its box (centre inside);
    * tables: each table in the extractor's Markdown with its rows, columns and, where its cells align with the text
      layer's word boxes, the share of the visible page its box covers;
    * words: the text layer's word count.

    `listing_text` is `pdfimages -list` output, `xhtml_text` is `pdftotext -bbox-layout` output for the same range, and
    `page_markdowns` maps page numbers to the extractor's Markdown. Any of them may be None: the facts that need it are
    then reported as unknown (null), never as zero.
    """
    if last - first + 1 > MAX_LAYOUT_PAGES:
        raise Unknown('range')
    try:
        walks = walk_document(path, first, last, deadline)
    except Unknown as error:
        walks, whole_unknown = {}, str(error) or 'unknown'
    else:
        whole_unknown = None
    rows = []
    if listing_text is not None:
        for line in listing_text.split('\n')[2:]:
            fields = line.split()
            if not fields:
                continue
            try:
                rows.append(parse_listing_row(fields))
            except ValueError:
                continue
    placed = match_placements(rows, walks) if listing_text is not None else {}
    repeated = repeated_objects(rows, last - first + 1)
    words = page_words(xhtml_text, range(last - first + 1)) if xhtml_text is not None else {}
    pages = []
    for number in range(first, last + 1):
        walk = walks.get(number)
        page_word_entry = words.get(number - first)
        page_words_list = page_word_entry[1] if page_word_entry else None
        entry = {'pageNumber': number, 'known': walk is not None and not walk.unknown and whole_unknown is None,
                 'words': len(page_words_list) if page_words_list is not None else None}
        if walk is not None:
            vx0, vy0, vx1, vy1 = visible_box(walk)
            entry['widthPt'], entry['heightPt'] = round(vx1 - vx0, 2), round(vy1 - vy0, 2)
        if not entry['known']:
            entry['reason'] = whole_unknown or (walk.unknown if walk is not None else 'not-walked')
        images = []
        if listing_text is not None and entry['known']:
            for row in rows:
                if row['pageNumber'] != number or row['role'] not in ('image', 'stencil') or len(images) >= MAX_LAYOUT_IMAGES_PER_PAGE:
                    continue
                hit = placed.get(row['occurrence'])
                placement = placement_from_draw(hit[0], hit[1]) if hit else None
                inside = None
                if placement is not None and page_words_list is not None:
                    x0, y0, x1, y1 = placement['bbox']
                    inside = sum(1 for w in page_words_list if x0 <= (w[0] + w[2]) / 2 <= x1 and y0 <= (w[1] + w[3]) / 2 <= y1)
                pixels = row['width'] * row['height']
                images.append({
                    'bbox': placement['bbox'] if placement else None,
                    'coverage': placement['coverage'] if placement else None,
                    'widthPx': row['width'], 'heightPx': row['height'],
                    'bitsPerComponent': row['bitsPerComponent'], 'colorSpace': row['colorSpace'], 'encoding': row['encoding'],
                    'ppi': row['ppi'], 'streamBytes': row['streamBytes'],
                    'bytesPerPixel': round(row['streamBytes'] / pixels, 5) if row['streamBytes'] is not None and pixels > 0 else None,
                    'repeated': row['objectId'] in repeated,
                    'wordsInside': inside,
                })
        entry['images'] = images if listing_text is not None and entry['known'] else None
        markdown = (page_markdowns or {}).get(number)
        if markdown is None:
            entry['tables'] = None
        else:
            tables, used = [], set()
            visible = None
            if walk is not None:
                vx0, vy0, vx1, vy1 = visible_box(walk)
                visible = max((vx1 - vx0) * (vy1 - vy0), 1e-9)
            for table in markdown_tables(markdown):
                box = table_box(table['tokens'], page_words_list, used) if page_words_list is not None else None
                tables.append({'rows': table['rows'], 'columns': table['columns'],
                               'coverage': round(min(1.0, _area(box) / visible), 4) if box is not None and visible else None})
            entry['tables'] = tables
        pages.append(entry)
    return {'version': LAYOUT_VERSION, 'pages': pages}


def main(argv):
    """CLI for local mode (parser sandbox) and the routing eval: reads only the files named, prints the facts as JSON."""
    import argparse
    import json
    parser = argparse.ArgumentParser(prog='pdf_layout_facts.py')
    parser.add_argument('--input', required=True)
    parser.add_argument('--first', type=int, default=1)
    parser.add_argument('--last', type=int, required=True)
    parser.add_argument('--listing')
    parser.add_argument('--xhtml')
    parser.add_argument('--markdown', help='the extractor output, one form feed between pages, starting at --first')
    parser.add_argument('--seconds', type=float, default=60.0)
    args = parser.parse_args(argv)
    if not 1 <= args.first <= args.last or args.last - args.first + 1 > MAX_LAYOUT_PAGES:
        parser.error('invalid page range')
    read = lambda name, limit: (open(name, 'rb').read(limit + 1).decode('utf-8', 'replace') if name else None)
    listing = read(args.listing, 64 * 1024 * 1024)
    xhtml = read(args.xhtml, 256 * 1024 * 1024)
    markdown = read(args.markdown, 256 * 1024 * 1024)
    pages = {args.first + index: text for index, text in enumerate(markdown.split('\f'))} if markdown is not None else None
    facts = layout_facts(args.input, listing, xhtml, pages, args.first, args.last, deadline=time.monotonic() + args.seconds)
    sys.stdout.write(json.dumps(facts, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    import sys
    raise SystemExit(main(sys.argv[1:]))
