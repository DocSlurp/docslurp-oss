"""Authored PDF generator for the Doppler image tests: raw objects, no third-party PDF library.

Every fixture is built from first principles (page content streams, image XObjects, transforms), so a test knows the
exact expected geometry. Supports classic xref tables and xref streams + object streams, so the reader's both paths are
exercised, and a few deliberately broken variants for hostile-input tests.
"""
import struct
import zlib


class PdfBuilder:
    def __init__(self):
        self.objects = {}  # num -> bytes (object body without the "n 0 obj" wrapper)
        self.next = 1
        self.pages = []

    def reserve(self):
        n = self.next
        self.next += 1
        return n

    def add(self, body, num=None):
        num = num or self.reserve()
        self.objects[num] = body if isinstance(body, bytes) else body.encode('latin-1')
        return num

    def stream(self, entries, data, compress=True, num=None):
        data = data.encode('latin-1') if isinstance(data, str) else data
        if compress:
            data = zlib.compress(data)
            entries = f'{entries} /Filter /FlateDecode'
        body = f'<< {entries} /Length {len(data)} >>\nstream\n'.encode('latin-1') + data + b'\nendstream'
        return self.add(body, num)

    def image(self, width, height, pixels, colorspace='/DeviceRGB', bpc=8, extra='', compress=True):
        return self.stream(f'/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {colorspace} /BitsPerComponent {bpc} {extra}', pixels, compress)

    def form(self, content, resources='', bbox='0 0 100 100', matrix='1 0 0 1 0 0', num=None):
        return self.stream(f'/Type /XObject /Subtype /Form /BBox [{bbox}] /Matrix [{matrix}] /Resources << {resources} >>', content, num=num)

    def page(self, content, xobjects=None, mediabox='0 0 612 792', rotate=0, extra=''):
        cs = self.stream('', content if isinstance(content, bytes) else content.encode('latin-1'))
        xo = ' '.join(f'/{k} {v} 0 R' for k, v in (xobjects or {}).items())
        font = '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >>'
        self.pages.append((cs, f'/Resources << /XObject << {xo} >> {font} >> /MediaBox [{mediabox}] /Rotate {rotate} {extra}'))
        return len(self.pages)

    def build(self, version='1.7', xref_stream=False, struct_tree=None, catalog_extra='', trailer_extra=''):
        pages_num = self.reserve()
        page_nums = []
        for cs, attrs in self.pages:
            page_nums.append(self.add(f'<< /Type /Page /Parent {pages_num} 0 R /Contents {cs} 0 R {attrs} >>'))
        self.add(f'<< /Type /Pages /Kids [{" ".join(f"{n} 0 R" for n in page_nums)}] /Count {len(page_nums)} >>', pages_num)
        root_extra = catalog_extra
        if struct_tree:
            root_extra += f' /StructTreeRoot {struct_tree(self, page_nums)} 0 R /MarkInfo << /Marked true >>'
        root = self.add(f'<< /Type /Catalog /Pages {pages_num} 0 R {root_extra} >>')
        out = bytearray(f'%PDF-{version}\n%\xe2\xe3\xcf\xd3\n'.encode('latin-1'))
        offsets = {}
        if xref_stream:
            return self._build_with_xref_stream(out, root, trailer_extra)
        for num in sorted(self.objects):
            offsets[num] = len(out)
            out += f'{num} 0 obj\n'.encode() + self.objects[num] + b'\nendobj\n'
        xref = len(out)
        size = max(self.objects) + 1
        out += f'xref\n0 {size}\n'.encode() + b'0000000000 65535 f \n'
        for num in range(1, size):
            out += f'{offsets[num]:010d} 00000 n \n'.encode() if num in offsets else b'0000000000 00000 f \n'
        out += f'trailer\n<< /Size {size} /Root {root} 0 R {trailer_extra} >>\nstartxref\n{xref}\n%%EOF\n'.encode()
        return bytes(out)

    def _build_with_xref_stream(self, out, root, trailer_extra):
        """Non-stream objects as ordinary objects; plain dictionaries packed into one object stream; Up-predicted xref."""
        packed = {n: b for n, b in self.objects.items() if not b.lstrip().endswith(b'endstream')}
        loose = {n: b for n, b in self.objects.items() if n not in packed}
        objstm = self.reserve()
        entries, body = [], bytearray()
        for n in sorted(packed):
            entries.append((n, len(body)))
            body += packed[n] + b'\n'
        header = ' '.join(f'{n} {off}' for n, off in entries).encode() + b'\n'
        data = zlib.compress(header + bytes(body))
        loose[objstm] = (f'<< /Type /ObjStm /N {len(entries)} /First {len(header)} /Filter /FlateDecode /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream')
        offsets = {}
        for num in sorted(loose):
            offsets[num] = len(out)
            out += f'{num} 0 obj\n'.encode() + loose[num] + b'\nendobj\n'
        xref_num = self.reserve()
        size = xref_num + 1
        rows = []
        for num in range(size):
            if num in packed:
                rows.append(struct.pack('>BIH', 2, objstm, [n for n, _ in entries].index(num)))
            elif num in offsets:
                rows.append(struct.pack('>BIH', 1, offsets[num], 0))
            elif num == xref_num:
                rows.append(struct.pack('>BIH', 1, len(out), 0))
            else:
                rows.append(struct.pack('>BIH', 0, 0, 65535))
        # PNG "Up" predictor, as real writers emit.
        raw, prev, predicted = b''.join(rows), bytes(7), bytearray()
        for i in range(0, len(raw), 7):
            row = raw[i:i + 7]
            predicted += b'\x02' + bytes((a - b) & 255 for a, b in zip(row, prev))
            prev = row
        data = zlib.compress(bytes(predicted))
        position = len(out)
        out += (f'{xref_num} 0 obj\n<< /Type /XRef /Size {size} /W [1 4 2] /Root {root} 0 R {trailer_extra} '
                f'/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length {len(data)} >>\nstream\n').encode() + data + b'\nendstream\nendobj\n'
        out += f'startxref\n{position}\n%%EOF\n'.encode()
        return bytes(out)


def rgb_gradient(width, height):
    return bytes(((x * 255 // max(1, width - 1)), (y * 255 // max(1, height - 1)), (x + y) * 255 // max(1, width + height - 2))[c] for y in range(height) for x in range(width) for c in range(3))


def solid_rgb(width, height, rgb):
    return bytes(rgb) * (width * height)


def place(width, height, x, y):
    """Content-stream fragment drawing the unit-square image scaled to width×height at (x, y), unrotated."""
    return f'q {width} 0 0 {height} {x} {y} cm /Im Do Q\n'


def text_lines(lines, x=72, y=720, size=11, leading=15, font='F1'):
    """Content-stream fragment: one Tj per line, top-down from y."""
    out = ['BT', f'/{font} {size} Tf', f'{leading} TL', f'{x} {y} Td']
    for line in lines:
        out.append('(' + line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ") '")
    out.append('ET')
    return '\n'.join(out) + '\n'
