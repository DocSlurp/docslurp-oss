import sys, zlib, os
out = sys.argv[1]
def build(objs, path, root=1, extra_trailer=b""):
    data = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, body in enumerate(objs, 1):
        offs.append(len(data))
        data += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    x = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs: data += b"%010d 00000 n \n" % o
    data += b"trailer\n<< /Size %d /Root %d 0 R %s>>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, root, extra_trailer, x)
    open(os.path.join(out, path), "wb").write(data)
def stream(dict_body, raw, flate=True):
    payload = zlib.compress(raw, 9) if flate else raw
    f = b"/Filter /FlateDecode " if flate else b""
    return b"<< " + dict_body + b" " + f + b"/Length %d >>\nstream\n" % len(payload) + payload + b"\nendstream"
W, H = 1700, 2200
image = stream(b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8" % (W, H), bytes([200]) * (W * H))
font = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
def page_doc(path, content, mediabox=b"[0 0 612 792]", extra_page=b"", res=b"/XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >>", objs_extra=()):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox " + mediabox + b" " + extra_page + b" /Resources << " + res + b" >> /Contents 4 0 R >>",
            stream(b"", content), image, font] + list(objs_extra)
    build(objs, path)
words = b" ".join([b"lorem"] * 300)
page_doc("scan_plain.pdf", b"q 612 0 0 792 0 0 cm /Im0 Do Q")
page_doc("scan_ocr_invisible.pdf", b"q 612 0 0 792 0 0 cm /Im0 Do Q BT 3 Tr /F1 10 Tf 40 700 Td (" + words + b") Tj ET")
glyphs = b"".join(b"(%s) Tj 7 0 Td " % bytes([c]) for c in b"QUARTERLYREPORTFORFISCALYEAR24")
page_doc("scan_glyph_title.pdf", b"q 612 0 0 792 0 0 cm /Im0 Do Q BT /F1 14 Tf 60 740 Td " + glyphs + b"ET")
page_doc("scan_big_mediabox.pdf", b"q 612 0 0 792 0 0 cm /Im0 Do Q", mediabox=b"[0 0 1836 2376]", extra_page=b"/CropBox [0 0 612 792]")
# inline image whose binary data contains "EI" followed by whitespace
blob = bytearray(os.urandom(4000)); blob[1000:1004] = b" EI "
page_doc("scan_inline.pdf", b"q 612 0 0 792 0 0 cm BI /W 40 /H 100 /BPC 8 /CS /G ID " + bytes(blob) + b" EI Q", objs_extra=())
# two pages: page 1 text, page 2 vector drawing without text (> 16 KB of path content)
path_ops = b"".join(b"%d %d m %d %d l S\n" % (i % 600, i % 780, (i * 7) % 600, (i * 13) % 780) for i in range(1500))
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>",
        stream(b"", b"BT /F1 10 Tf 40 700 Td (" + words + b") Tj ET"), image, font,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R >>", stream(b"", path_ops)]
build(objs, "vector_page_in_text_doc.pdf")
# page tree cycle
build([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
       b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>", b"<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>"], "page_tree_cycle.pdf")
# deeply nested array
build([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
       b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Foo 4 0 R >>", b"[" * 200000 + b"]" * 200000], "nested_arrays.pdf")
# nested dictionaries
build([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
       b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Foo 4 0 R >>", b"<< /A " * 100000 + b"1" + b" >>" * 100000], "nested_dicts.pdf")
# nested arrays inside a content stream
page_doc("nested_content_array.pdf", b"[" * 200000 + b"]" * 200000 + b" TJ")
# form XObject amplification: a page drawing an 8 MB (decompressed) form many times
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
form = stream(b"/Type /XObject /Subtype /Form /BBox [0 0 612 792]", b" " * (8 * 1024 * 1024 - 1))
page_doc("form_amplification.pdf", b"/F Do\n" * N, res=b"/XObject << /F 7 0 R /Im0 5 0 R >>", objs_extra=(form,))
