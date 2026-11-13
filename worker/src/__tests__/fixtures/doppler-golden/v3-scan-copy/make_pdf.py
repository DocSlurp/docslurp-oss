"""Authored benign PDF: page 1 a full-page JPEG scan (copyable), page 2 a full-page Flate scan (not copyable),
page 3 born-digital text with one small picture."""
import io, sys, zlib
from PIL import Image
W, H = 340, 440
def scan(seed):
    im = Image.new("RGB", (W, H), (250, 248, 240))
    px = im.load()
    for y in range(80, H - 80, 22):
        for x in range(90, W - 90):
            if ((x * 7 + y * seed) // 13) % 5 != 0 and (y // 22) % 3 != 2:
                for dy in range(6):
                    px[x, y + dy] = (40, 40, 40)
    return im
jpg = io.BytesIO(); scan(3).save(jpg, "JPEG", quality=40); jpg = jpg.getvalue()
raw = scan(5).tobytes(); flate = zlib.compress(raw)
w = h = 64
pix = bytearray()
for y in range(h):
    for x in range(w):
        pix += bytes(((x * 4) & 255, (y * 4) & 255, ((x ^ y) * 4) & 255))
small = zlib.compress(bytes(pix))
def text(y0, n=6):
    s = "BT /F1 11 Tf 72 %d Td 14 TL " % y0
    for i in range(n):
        s += "(This is a benign paragraph line number %d used to give the page some body text.) '\n" % i
    return s + "ET\n"
pages = [
    "q 612 0 0 792 0 0 cm /Sc1 Do Q\n",
    "q 612 0 0 792 0 0 cm /Sc2 Do Q\n",
    text(740) + "q 200 0 0 150 72 440 cm /Im1 Do Q\n" + text(380),
]
objs = {}
objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
kids = " ".join(f"{10+i} 0 R" for i in range(len(pages)))
objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode()
objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
objs[4] = (f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {len(small)} >>\nstream\n").encode() + small + b"\nendstream"
objs[5] = (f"<< /Type /XObject /Subtype /Image /Width {W} /Height {H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpg)} >>\nstream\n").encode() + jpg + b"\nendstream"
objs[6] = (f"<< /Type /XObject /Subtype /Image /Width {W} /Height {H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {len(flate)} >>\nstream\n").encode() + flate + b"\nendstream"
for i, c in enumerate(pages):
    cb = c.encode()
    objs[20+i] = f"<< /Length {len(cb)} >>\nstream\n".encode() + cb + b"\nendstream"
    objs[10+i] = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R /Sc1 5 0 R /Sc2 6 0 R >> >> /Contents {20+i} 0 R >>".encode()
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
