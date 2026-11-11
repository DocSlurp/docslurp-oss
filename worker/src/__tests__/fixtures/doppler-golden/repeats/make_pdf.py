"""Authored benign PDF: repeated image XObjects, a pixel-identical twin object, and a hairline-narrow image."""
import sys, zlib
w = h = 64
pix = bytearray()
for y in range(h):
    for x in range(w):
        pix += bytes(((x * 4) & 255, (y * 4) & 255, ((x ^ y) * 4) & 255))
img = zlib.compress(bytes(pix))
def text(y0, n=6):
    s = "BT /F1 11 Tf 72 %d Td 14 TL " % y0
    for i in range(n):
        s += "(This is a benign paragraph line number %d used to give the page some body text.) '\n" % i
    return s + "ET\n"
pages = [
    text(740) + "q 200 0 0 150 72 440 cm /Im1 Do Q\n" + text(380),
    text(740) + "q 200 0 0 150 300 420 cm /Im1 Do Q\n" + text(380),
    text(740) + "q 200 0 0 150 150 430 cm /Im2 Do Q\n" + text(380) + "q 200 0 0 150 250 110 cm /Im2 Do Q\n",
    text(740) + "q 0.004 0 0 150 400 420 cm /Im1 Do Q\n" + "q 200 0 0 150 100 425 cm /Im1 Do Q\n" + text(380),
]
objs = {}
objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
kids = " ".join(f"{10+i} 0 R" for i in range(len(pages)))
objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode()
objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
for n in (4, 5):
    objs[n] = (f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {len(img)} >>\nstream\n").encode() + img + b"\nendstream"
for i, c in enumerate(pages):
    cb = c.encode()
    objs[20+i] = f"<< /Length {len(cb)} >>\nstream\n".encode() + cb + b"\nendstream"
    objs[10+i] = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R /Im2 5 0 R >> >> /Contents {20+i} 0 R >>".encode()
out = bytearray(b"%PDF-1.7\n")
offs = {}
for n in sorted(objs):
    offs[n] = len(out)
    out += f"{n} 0 obj\n".encode() + objs[n] + b"\nendobj\n"
size = max(objs) + 1
x = len(out)
out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
for n in range(1, size):
    out += (f"{offs[n]:010d} 00000 n \n" if n in offs else "0000000000 65535 f \n").encode()
out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
open(sys.argv[1], "wb").write(out)
