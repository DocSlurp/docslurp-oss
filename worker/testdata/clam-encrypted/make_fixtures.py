"""Hostile fixtures for the real-ClamAV matrix (src/tools/clam-hostile-matrix.docker.test.ts).

Run as `python3 -I make_fixtures.py OUT_DIR SOURCE_PDF`. Uses only the standard library plus the host's `qpdf` and `zip`;
never a parser under test. EICAR and the marker are written at run time and never committed. The committed encrypted
RAR, 7z, AES-ZIP and OOXML fixtures next to this file come from make_committed.py (py7zr, pyzipper, msoffcrypto-tool,
python-docx, openpyxl and RARLAB rar 7.12) and hold only a benign note.
"""
import os
import re
import struct
import subprocess
import sys
import zipfile
import zlib

out, source_pdf = sys.argv[1], sys.argv[2]
EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
MARKER = b"DOCSLURP-MATRIX-MARKER-0123456789abcdef"


def at(name):
    return os.path.join(out, name)


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


with open(at("eicar.com"), "wb") as f:
    f.write(EICAR)
with open(at("marker.ndb"), "w") as f:
    f.write("Docslurp.Test.MatrixMarker:0:*:%s\n" % MARKER.hex())

# --- PDFs -------------------------------------------------------------------------------------------------------------
run("qpdf", source_pdf, at("plain.pdf"))
# A page whose uncompressed content stream carries the marker: found only if the scanner reads decrypted content.
content = b"BT (" + MARKER + b") Tj ET"
objects = [
    b"<</Type/Catalog/Pages 2 0 R>>",
    b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>",
    b"<</Length %d>>stream\n%s\nendstream" % (len(content), content),
]
pdf, offsets = b"%PDF-1.4\n", []
for number, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += b"%d 0 obj\n%s\nendobj\n" % (number, body)
xref = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
pdf += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
with open(at("marker-src.pdf"), "wb") as f:
    f.write(pdf)
run("qpdf", "--stream-data=uncompress", at("marker-src.pdf"), at("marker-plain.pdf"))
# Empty user password + owner password: anyone can open it. libclamav decrypts it and scans Flate streams, but an
# unfiltered stream's decrypted bytes are discarded and the ciphertext is scanned (ClamAV 1.4.3), so both are built.
run("qpdf", "--stream-data=compress", "--encrypt", "", "owner-secret", "256", "--", at("marker-plain.pdf"), at("pdf-empty-user-owner-flate-marker.pdf"))
run("qpdf", "--stream-data=uncompress", "--encrypt", "", "owner-secret", "256", "--", at("marker-plain.pdf"), at("pdf-empty-user-owner-raw-marker.pdf"))
run("qpdf", "--encrypt", "user-secret", "owner-secret", "256", "--", source_pdf, at("pdf-user-password.pdf"))
# Objects in object streams (encrypted with a user password, and owner-only with the marker).
run("qpdf", "--object-streams=generate", "--encrypt", "user-secret", "owner-secret", "256", "--", source_pdf, at("pdf-objstm-user-password.pdf"))
run("qpdf", "--object-streams=generate", "--stream-data=compress", "--encrypt", "", "owner-secret", "256", "--", at("marker-plain.pdf"), at("pdf-objstm-owner-only-flate-marker.pdf"))
# Encryption added in an incremental update: the base section's trailer has no /Encrypt; the update's does.
run("qpdf", "--object-streams=disable", "--encrypt", "user-secret", "owner-secret", "256", "--", source_pdf, at("enc-classic.pdf"))
data = open(at("enc-classic.pdf"), "rb").read()
startxref = int(re.findall(rb"startxref\s+(\d+)", data)[-1])
trailer = data[startxref:]
size = int(re.search(rb"/Size (\d+)", trailer).group(1))
root = re.search(rb"/Root (\d+ \d+ R)", trailer).group(1)
encrypt_num = int(re.search(rb"/Encrypt (\d+) 0 R", trailer).group(1))
ident = re.search(rb"/ID \[[^\]]*\]", trailer).group(0)
body = data[:startxref]
offsets = {}
for match in re.finditer(rb"(?:^|\n)(\d+) 0 obj", body):
    offsets.setdefault(int(match.group(1)), match.start() + (1 if body[match.start():match.start() + 1] == b"\n" else 0))
xref1 = len(body)
section1 = [b"xref\n0 %d\n" % size, b"0000000000 65535 f \n"]
for num in range(1, size):
    if num == encrypt_num or num not in offsets:
        section1.append(b"0000000000 00001 f \n")
    else:
        section1.append(b"%010d 00000 n \n" % offsets[num])
section1.append(b"trailer\n<< /Size %d /Root %s %s >>\nstartxref\n%d\n%%%%EOF\n" % (size, root, ident, xref1))
first = body + b"".join(section1)
xref2 = len(first)
update = b"xref\n%d 1\n%010d 00000 n \ntrailer\n<< /Size %d /Root %s /Encrypt %d 0 R %s /Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (
    encrypt_num, offsets[encrypt_num], size, root, encrypt_num, ident, xref1, xref2)
with open(at("pdf-incremental-encrypt.pdf"), "wb") as f:
    f.write(first + update)
for name in ("marker-src.pdf", "enc-classic.pdf"):
    os.remove(at(name))

# Control: an ordinary permissions-restricted PDF (owner password only, printing/editing/extraction denied). Anyone can
# open it, so quarantine decrypts it in the VM, scans the copy and must accept it.
run("qpdf", "--encrypt", "", "owner-secret", "256", "--print=none", "--modify=none", "--extract=n", "--", source_pdf, at("pdf-owner-only-restricted.pdf"))
# Hostile: the raw-marker PDF with a broken startxref, so readers must reconstruct the cross-reference table to find the
# /Encrypt trailer. Quarantine must decrypt and find the marker, or refuse; never pass it clean.
data = open(at("pdf-empty-user-owner-raw-marker.pdf"), "rb").read()
data = re.sub(rb"startxref\s+\d+", b"startxref\n999999", data)
with open(at("pdf-owner-raw-marker-broken-xref.pdf"), "wb") as f:
    f.write(data)
# The fail-closed cost: an unencrypted PDF whose content merely shows the text "/Encrypt". The VM check sees the name,
# qpdf says the file is not encrypted, and that disagreement is refused (malware-scan-pdf-decrypt-failed).
content = b"BT (see /Encrypt in the spec) Tj ET"
objects = [
    b"<</Type/Catalog/Pages 2 0 R>>",
    b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>",
    b"<</Length %d>>stream\n%s\nendstream" % (len(content), content),
]
pdf, offsets = b"%PDF-1.4\n", []
for number, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += b"%d 0 obj\n%s\nendobj\n" % (number, body)
xref = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
pdf += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
with open(at("pdf-literal-encrypt-text.pdf"), "wb") as f:
    f.write(pdf)

# Timing: representative owner-password PDFs (AES-256, permissions restricted), for the added scan time. Every page has
# its own content (qpdf --pages would share repeated objects): text pages with Flate content streams, and pages with a
# Flate-encoded 900x1200 RGB image each (a photo-like gradient with noise, about 3:1), which the copy stores decoded.
def build_pdf(path, pages):
    objects = [b"<</Type/Catalog/Pages 2 0 R>>", None]
    kids = []
    for text, image in pages:
        resources = b"<<>>"
        if image is not None:
            width, height, pixels = image
            objects.append(b"<</Type/XObject/Subtype/Image/Width %d/Height %d/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length %d>>stream\n" % (width, height, len(pixels)) + pixels + b"\nendstream")
            resources = b"<</XObject<</Im0 %d 0 R>>>>" % len(objects)
            text = b"q 500 0 0 660 50 80 cm /Im0 Do Q " + text
        stream = zlib.compress(text)
        objects.append(b"<</Length %d/Filter/FlateDecode>>stream\n" % len(stream) + stream + b"\nendstream")
        objects.append(b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources %s/Contents %d 0 R>>" % (resources, len(objects)))
        kids.append(len(objects))
    objects[1] = b"<</Type/Pages/Kids[%s]/Count %d>>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    out, offsets = b"%PDF-1.7\n", []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    with open(path, "wb") as f:
        f.write(out)


def text_page(number):
    lines = [b"BT /F1 10 Tf 50 %d Td (Quarter %d, line %d: revenue rose %d.%d percent on expansion into %d new markets.) Tj ET" % (740 - line * 12, number, line, (number * 7 + line) % 40, line % 10, (number + line) % 17) for line in range(55)]
    return b"\n".join(lines)


def photo(seed, width=900, height=1200):
    state = seed * 2654435761 & 0xFFFFFFFF
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            state = (state * 1103515245 + 12345) & 0x7FFFFFFF
            noise = (state >> 16) & 0x1F
            row += bytes(((x * 255 // width + noise) & 0xFF, (y * 255 // height + noise) & 0xFF, ((x + y + seed * 37) & 0xFF) ^ noise))
        rows.append(b"\0" + bytes(row))
    return width, height, zlib.compress(b"".join(rows), 6)


build_pdf(at("perf-src-text.pdf"), [(text_page(n), None) for n in range(300)])
build_pdf(at("perf-src-images.pdf"), [(text_page(n), photo(n)) for n in range(40)])
for name, source in (("perf-owner-text-300p.pdf", "perf-src-text.pdf"), ("perf-owner-images-40p.pdf", "perf-src-images.pdf")):
    run("qpdf", "--encrypt", "", "owner-secret", "256", "--print=none", "--modify=none", "--", at(source), at(name))
    os.remove(at(source))

# --- ZIPs -------------------------------------------------------------------------------------------------------------
note = b"Quarterly results beat the forecast.\n"
with open(at("note.txt"), "wb") as f:
    f.write(note)
run("zip", "-q", "-j", "-P", "zip-secret", at("zip-password.zip"), at("eicar.com"))
# Only some entries encrypted, in both orders.
run("zip", "-q", "-j", at("zip-mixed-plain-first.zip"), at("note.txt"))
run("zip", "-q", "-j", "-P", "zip-secret", at("zip-mixed-plain-first.zip"), at("eicar.com"))
run("zip", "-q", "-j", "-P", "zip-secret", at("zip-mixed-encrypted-first.zip"), at("eicar.com"))
run("zip", "-q", "-j", at("zip-mixed-encrypted-first.zip"), at("note.txt"))


def stored_zip(entries, local_flag=0, central_flag=0):
    """Stored entries in plain text, with the given general-purpose flag bits OR'd into the local and central headers."""
    locals_, centrals, offset = [], [], 0
    for name, payload in entries:
        name = name.encode()
        crc = zlib.crc32(payload) & 0xFFFFFFFF
        local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, local_flag, 0, 0, 0x21, crc, len(payload), len(payload), len(name), 0)
        central = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, central_flag, 0, 0, 0x21, crc, len(payload), len(payload), len(name), 0, 0, 0, 0, 0, offset)
        locals_.append(local + name + payload)
        centrals.append(central + name)
        offset += len(local) + len(name) + len(payload)
    directory = b"".join(centrals)
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(directory), offset, 0)
    return b"".join(locals_) + directory + end


# Encryption flag set on stored, plain-text entries (nothing is actually encrypted): the EICAR is readable.
for name, local_flag, central_flag in (("zip-flag-stored-both.zip", 1, 1), ("zip-flag-stored-local-only.zip", 1, 0), ("zip-flag-stored-central-only.zip", 0, 1)):
    with open(at(name), "wb") as f:
        f.write(stored_zip([("eicar.com", EICAR)], local_flag, central_flag))


def nest(inner_path, levels, out_name):
    data = open(inner_path, "rb").read()
    name = os.path.basename(inner_path)
    for level in range(levels):
        path = at("nest-tmp-%d.zip" % level)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
            z.writestr(name, data)
        data, name = open(path, "rb").read(), "level-%d.zip" % level
        os.remove(path)
    with open(at(out_name), "wb") as f:
        f.write(data)


nest(at("zip-password.zip"), 3, "nested-3-encrypted.zip")
nest(at("eicar.com"), 3, "nested-3-eicar.zip")
# Past MaxRecursion (17): 20 levels around a plain note.
nest(at("note.txt"), 20, "limit-max-recursion.zip")

# ZIP64 local headers (sizes 0xFFFFFFFF, real sizes in the ZIP64 extra): libclamav 1.4.3 does not follow them and skips the
# member ("local header - stream out of file"), so a 68-byte EICAR in one scans OK. Top level, quarantine's archive
# inspection refuses them (archive-inspection-failed); nested inside a plain ZIP it does not look.
with zipfile.ZipFile(at("zip64-member-eicar.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    with z.open("eicar.com", "w", force_zip64=True) as w:
        w.write(EICAR)
with zipfile.ZipFile(at("nested-zip64-eicar.zip"), "w", zipfile.ZIP_STORED) as z:
    z.write(at("zip64-member-eicar.zip"), "inner/zip64-member-eicar.zip")
# A RAR nested in a plain ZIP (the committed benign RAR5): ClamAV here has no RAR engine; the in-VM walk must refuse it.
with zipfile.ZipFile(at("nested-rar.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.write(at("rar5-password.rar"), "attachments/archive.rar")
# Control: an ordinary ZIP (deflated text members), which must stay clean.
with zipfile.ZipFile(at("zip-plain.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("notes/summary.txt", note * 50)
    z.writestr("notes/forecast.csv", b"quarter,revenue\nQ1,120\nQ2,135\n")


# --- Scan limits (zeros deflate ~1000:1, so these are a few MB on disk; no ZIP64, which ClamAV would skip) ------------
def zeros_zip(name, members, member_bytes):
    chunk = b"\0" * (1 << 20)
    with zipfile.ZipFile(at(name), "w", zipfile.ZIP_DEFLATED, allowZip64=False) as z:
        for index in range(members):
            with z.open("zeros-%d.bin" % index, "w") as w:
                for _ in range(member_bytes // len(chunk)):
                    w.write(chunk)


zeros_zip("limit-max-filesize-member.zip", 1, 1100 * (1 << 20))   # a member past MaxFileSize (1024M)
# The same member nested in a plain ZIP: ClamAV truncates it without an alert; the in-VM walk must refuse it.
with zipfile.ZipFile(at("nested-oversized-member.zip"), "w", zipfile.ZIP_STORED) as z:
    z.write(at("limit-max-filesize-member.zip"), "inner/limit-max-filesize-member.zip")
zeros_zip("limit-max-scansize.zip", 3, 800 * (1 << 20))           # 2400 MiB scanned past MaxScanSize (2000M)
with open(at("limit-max-filesize-raw.bin"), "wb") as f:           # a sparse 1100 MiB file past MaxFileSize
    f.truncate(1100 * (1 << 20))



# --- Council re-check 4 (PR #339): magic bytes behind a prefix, offset containers, OLE2 amplification ---------------
def simple_pdf(content, info=b"", header_comment=b"", info_first=False):
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>",
        b"<</Length %d>>stream\n%s\nendstream" % (len(content), content),
    ]
    if info:
        objects.append(info)
    order = list(range(1, len(objects) + 1))
    if info and info_first:
        order = [5, 1, 2, 3, 4]
    data, offsets = b"%PDF-1.4\n" + header_comment, {}
    for number in order:
        offsets[number] = len(data)
        data += b"%d 0 obj\n%s\nendobj\n" % (number, objects[number - 1])
    xref = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % offsets[n] for n in range(1, len(objects) + 1))
    data += b"trailer\n<</Size %d/Root 1 0 R%s>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, b"/Info 5 0 R" if info else b"", xref)
    return data


def write(name, data):
    with open(at(name), "wb") as f:
        f.write(data)


def zip_bytes(entries, zip64=False, method=zipfile.ZIP_DEFLATED):
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as z:
        for name, payload in entries:
            with z.open(name, "w", force_zip64=zip64) as w:
                w.write(payload)
    return buf.getvalue()


# Correctness High: ordinary unencrypted PDFs that merely contain the bytes /Encrypt in their body (a comment after the
# header, an /Info string, an uncompressed content stream), away from the trailer where libclamav's own /Encrypt heuristic
# looks. ClamAV scans them clean; qpdf finds no encryption; quarantine rewrites them, scans the rewrite and accepts them.
# The reviewer's reproducer (the comment after %%EOF) is reported encrypted by libclamav itself.
plain_text = b"BT (Quarterly results beat the forecast) Tj ET"
body_text = b"BT (Quarterly results beat the forecast) Tj ET\n" * 200
write("pdf-literal-encrypt-comment.pdf", simple_pdf(body_text, header_comment=b"% see /Encrypt in the PDF spec\n"))
write("pdf-literal-encrypt-string.pdf", simple_pdf(body_text, b"<</Title (/Encrypt and /Decrypt notes)>>", info_first=True))
write("pdf-literal-encrypt-stream.pdf", simple_pdf(b"BT (see /Encrypt in the spec) Tj ET\n" + body_text))
write("pdf-literal-encrypt-after-eof.pdf", simple_pdf(plain_text) + b"\n% /Encrypt\n")
# Adversarial case 6: /Encrypt in the base trailer, dropped by an incremental update that replaces the page content with
# a plaintext Flate stream holding the marker. libclamav honours the base /Encrypt and scans ciphertext; qpdf's effective
# trailer is unencrypted, so its rewrite is scanned and the marker found.
run("qpdf", "--allow-weak-crypto", "--encrypt", "", "owner-secret", "128", "--use-aes=n", "--", at("marker-plain.pdf"), at("enc-base.pdf"))
base = open(at("enc-base.pdf"), "rb").read()
os.remove(at("enc-base.pdf"))
contents = int(re.search(rb"/Contents (\d+) 0 R", base).group(1))
base_xref = int(re.findall(rb"startxref\s+(\d+)", base)[-1])
base_trailer = base[base_xref:]
size = int(re.search(rb"/Size (\d+)", base_trailer).group(1))
root = re.search(rb"/Root (\d+ \d+ R)", base_trailer).group(1)
stream = zlib.compress(b"BT (Earnings beat " + MARKER + b" forecast) Tj ET")
update_offset = len(base)
update = b"%d 0 obj\n<< /Filter /FlateDecode /Length %d >>\nstream\n" % (contents, len(stream)) + stream + b"\nendstream\nendobj\n"
xref = update_offset + len(update)
update += b"xref\n%d 1\n%010d 00000 n \ntrailer\n<< /Size %d /Root %s /Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (contents, update_offset, size, root, base_xref, xref)
write("pdf-incremental-drop-encrypt-marker.pdf", base + update)
# L2: an owner-password PDF qpdf can only partly rewrite: an incremental update gives the page an /Extra entry pointing at
# 200,000 nested arrays, which qpdf drops ("ignoring excessively deeply nested data structure", exit 3).
write("deep-src.pdf", simple_pdf(plain_text))
run("qpdf", "--encrypt", "", "owner-secret", "256", "--", at("deep-src.pdf"), at("deep-enc.pdf"))
base = open(at("deep-enc.pdf"), "rb").read()
for name in ("deep-src.pdf", "deep-enc.pdf"):
    os.remove(at(name))
base_xref = int(re.findall(rb"startxref\s+(\d+)", base)[-1])
base_trailer = base[base_xref:]
size = int(re.search(rb"/Size (\d+)", base_trailer).group(1))
root = re.search(rb"/Root (\d+ \d+ R)", base_trailer).group(1)
encrypt = re.search(rb"/Encrypt (\d+ \d+ R)", base_trailer).group(1)
ident = re.search(rb"/ID \[[^\]]*\]", base_trailer).group(0)
page_number, page_dict = next((int(m.group(1)), m.group(2)) for m in re.finditer(rb"(\d+) 0 obj\s*(<<(?:(?!endobj).)*?/Type\s*/Page(?!s)(?:(?!endobj).)*?>>)\s*endobj", base, re.S))
page_offset = len(base)
update = b"%d 0 obj\n%s/Extra %d 0 R>>\nendobj\n" % (page_number, page_dict.rstrip()[:-2], size)
deep_offset = page_offset + len(update)
update += b"%d 0 obj\n%s\nendobj\n" % (size, b"[" * 200000 + b"]" * 200000)
xref = page_offset + len(update)
update += b"xref\n%d 1\n%010d 00000 n \n%d 1\n%010d 00000 n \n" % (page_number, page_offset, size, deep_offset)
update += b"trailer\n<< /Size %d /Root %s /Encrypt %s %s /Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (size + 1, root, encrypt, ident, base_xref, xref)
write("pdf-owner-deep-nesting.pdf", base + update)

# H1/H2: a container or PDF behind 16 NUL bytes (40 binary comment lines for the PDF). Extractors tolerate the prefix
# (openpyxl/zipfile find the end record; pdf.js and poppler find %PDF- in the first KB); ClamAV types the file by its first
# bytes and parses neither. Quarantine refuses them: a declared type with magic bytes is never confirmed by an empty sniff.
PREFIX = b"\0" * 16
ooxml_types = b'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
marker_xml = b"<t>" + MARKER + b"</t>"
write("prefixed-zip64-marker.xlsx", PREFIX + zip_bytes([("[Content_Types].xml", ooxml_types), ("xl/workbook.xml", b"<workbook/>"), ("xl/sharedStrings.xml", marker_xml)], zip64=True))
write("prefixed-traversal.docx", PREFIX + zip_bytes([("[Content_Types].xml", ooxml_types), ("word/document.xml", b"<document/>"), ("../../outside.txt", b"expansion plan")]))
write("prefixed-marker.pptx", PREFIX + zip_bytes([("[Content_Types].xml", ooxml_types), ("ppt/presentation.xml", b"<presentation/>"), ("ppt/slides/slide1.xml", marker_xml)]))
write("prefixed-marker.epub", PREFIX + zip_bytes([("mimetype", b"application/epub+zip"), ("META-INF/container.xml", b"<container/>"), ("OEBPS/chapter1.xhtml", marker_xml)], method=zipfile.ZIP_STORED))
write("prefixed-marker.odt", PREFIX + zip_bytes([("mimetype", b"application/vnd.oasis.opendocument.text"), ("content.xml", marker_xml)], method=zipfile.ZIP_STORED))
pdf_prefix = b"%\0\1\2\3 quarterly report padding line\n" * 40
write("prefixed-owner-raw-marker.pdf", pdf_prefix + open(at("pdf-empty-user-owner-raw-marker.pdf"), "rb").read())
write("prefixed-flate-marker.pdf", pdf_prefix + open(at("pdf-empty-user-owner-flate-marker.pdf"), "rb").read())
# M3: containers a few bytes into a member, and a PDF that carries a ZIP (with a ZIP64 member) inside.
zip64_eicar = open(at("zip64-member-eicar.zip"), "rb").read()
write("offset-zip64-member.zip", zip_bytes([("media/image1.bin", b"JUNKJUNK" + zip64_eicar)], method=zipfile.ZIP_STORED))
write("offset-rar-member.zip", zip_bytes([("media/image1.bin", b"J" + open(at("rar5-password.rar"), "rb").read())], method=zipfile.ZIP_STORED))
head = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
write("pdf-zip-polyglot.pdf", head + zip_bytes([("inner.zip", zip64_eicar)], method=zipfile.ZIP_STORED) + b"\ntrailer<</Root 1 0 R>>\n%%EOF\n")
# Control: an Office printer-settings blob (DEVMODE driver data) holding a CAB cabinet a little way in, as real
# spreadsheets do. ClamAV opens CAB; quarantine accepts it.
devmode = b"\0" * 1258 + b"MSCF\0\0\0\0" + b"\0" * 64
write("printer-settings-cab.xlsx", zip_bytes([("[Content_Types].xml", ooxml_types), ("xl/workbook.xml", b"<workbook/>"), ("xl/printerSettings/printerSettings1.bin", devmode)]))
# L4: a local entry no central-directory entry lists, holding the marker.
hidden_name, hidden = b"hidden.txt", MARKER * 4
hidden_local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, 0, 0x21, zlib.crc32(hidden) & 0xFFFFFFFF, len(hidden), len(hidden), len(hidden_name), 0) + hidden_name + hidden
listed = stored_zip([("notes.txt", b"quarterly results beat the forecast")])
end = listed.rindex(b"PK\x05\x06")
directory_offset = struct.unpack("<I", listed[end + 16:end + 20])[0]
central = bytearray(listed[directory_offset:end])
struct.pack_into("<I", central, 42, len(hidden_local))  # the listed entry now starts after the hidden one
write("hidden-local-entry.zip", hidden_local + listed[:directory_offset] + bytes(central) + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(central), len(hidden_local) + directory_offset, 0))


# M1: an OLE2 compound file (version 4, 4 KiB sectors) with 2,000 stream entries sharing one 64 MiB chain, in a ZIP with
# 400 KiB of incompressible padding (ratio under 250). 0.5 MB on disk; reading every entry would materialise 125 GiB.
def shared_chain_ole(entries, stream_bytes):
    sector = 4096
    data_sectors = stream_bytes // sector
    dir_sectors = -(-((entries + 1) * 128) // sector)
    fat_sectors = 1
    while data_sectors + fat_sectors + dir_sectors > fat_sectors * (sector // 4):
        fat_sectors += 1
    total = data_sectors + fat_sectors + dir_sectors
    buf = bytearray(sector * (1 + total))
    buf[0:8] = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
    struct.pack_into("<HHHHH", buf, 0x18, 0x3E, 4, 0xFFFE, 12, 6)
    struct.pack_into("<III", buf, 0x2C, fat_sectors, data_sectors + fat_sectors, 0)
    struct.pack_into("<IIIII", buf, 0x38, 4096, 0xFFFFFFFE, 0, 0xFFFFFFFE, 0)
    for index in range(109):
        struct.pack_into("<I", buf, 0x4C + index * 4, data_sectors + index if index < fat_sectors else 0xFFFFFFFF)
    fat = [0xFFFFFFFF] * (fat_sectors * sector // 4)
    for index in range(data_sectors):
        fat[index] = index + 1 if index + 1 < data_sectors else 0xFFFFFFFE
    for index in range(fat_sectors):
        fat[data_sectors + index] = 0xFFFFFFFD
    for index in range(dir_sectors):
        at_sector = data_sectors + fat_sectors + index
        fat[at_sector] = at_sector + 1 if index + 1 < dir_sectors else 0xFFFFFFFE
    struct.pack_into("<%dI" % len(fat), buf, sector * (1 + data_sectors), *fat)
    directory = bytearray(dir_sectors * sector)
    def entry(index, name, kind, start, size):
        at_entry = index * 128
        encoded = (name + "\0").encode("utf-16-le")
        directory[at_entry:at_entry + len(encoded)] = encoded
        struct.pack_into("<HBB", directory, at_entry + 0x40, len(encoded), kind, 1)
        struct.pack_into("<III", directory, at_entry + 0x44, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF)
        struct.pack_into("<II", directory, at_entry + 0x74, start, size)
    entry(0, "Root Entry", 5, 0xFFFFFFFE, 0)
    for index in range(1, entries + 1):
        entry(index, "S%d" % index, 2, 0, stream_bytes)
    start = sector * (1 + data_sectors + fat_sectors)
    buf[start:start + len(directory)] = directory
    return bytes(buf)


write("ole-shared-chain.zip", zip_bytes([("word/embeddings/oleObject1.bin", shared_chain_ole(2000, 64 << 20)), ("word/media/noise.bin", os.urandom(400 * 1024))]))


# --- Council round 5 (PR #339 adversarial re-check 2) -------------------------------------------------------------
QPDF_RECOVERY = [r": file is damaged$", r": Attempting to reconstruct cross-reference table$", r": reported number of objects \(\d+\) is not one plus the highest object number \(\d+\)$", r": xref not found$", r": expected endstream$", r": attempting to recover stream length$", r": recovered stream length: \d+$", r": object has offset 0$"]


def qpdf_recovery_only(stderr):
    lines = [line.strip() for line in stderr.splitlines() if line.strip() and not line.strip().startswith("qpdf: operation succeeded with warnings")]
    return bool(lines) and all(line.startswith("WARNING: ") and any(re.search(p, line) for p in QPDF_RECOVERY) for line in lines)


# N-H1: an outline title and page text carrying the marker, RC4-128 with an empty user password (raw streams).
def outline_pdf():
    text = b"BT /F1 12 Tf 72 700 Td (Earnings beat " + MARKER + b" forecast) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /PageMode /UseOutlines >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(text), text),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>",
        b"<< /Title (Earnings beat " + MARKER + b" forecast) /Parent 6 0 R /Dest [3 0 R /Fit] >>",
    ]
    data, offsets = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", []
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    data += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return data


write("r5-outline-src.pdf", outline_pdf())


def rc4(owner, out_name, extra=()):
    run("qpdf", "--static-id", "--allow-weak-crypto", "--stream-data=preserve", *extra, "--encrypt", "", owner, "128", "--use-aes=n", "--", at("r5-outline-src.pdf"), at(out_name))
    return open(at(out_name), "rb").read()


key_a = rc4("ownerpw", "r5-key-a.pdf", ("--object-streams=disable",))
enc_a = int(re.search(rb"/Encrypt (\d+) 0 R", key_a).group(1))
trailer_a = re.search(rb"trailer\s*(<<.*?>>)\s*startxref", key_a, re.S).group(1)
body_a = key_a[:key_a.rfind(b"\nxref\n") + 1]


def dict_b(owner):
    data = rc4(owner, "r5-key-b.pdf", ("--object-streams=disable",))
    number = int(re.search(rb"/Encrypt (\d+) 0 R", data).group(1))
    return re.search(rb"\n%d 0 obj\n(.*?)\nendobj\n" % number, data, re.S).group(1)


trailer_b = trailer_a.replace(b"/Encrypt %d 0 R" % enc_a, b"/Encrypt 99 0 R").replace(b"/Size ", b"/Size 100 /OldSize ")
# The reviewer's twokey3 shape: dict B under a second trailer, startxref broken, and dict B's owner password searched until
# qpdf's key-B "decryption" exits with only xref-recovery warnings (so only the structure check can refuse it).
for attempt in range(40):
    dict_b_bytes = dict_b("quarterly%d" % attempt)
    candidate = body_a + b"99 0 obj\n" + dict_b_bytes + b"\nendobj\ntrailer\n" + trailer_a + b"\n%%EOF\ntrailer\n" + trailer_b + b"\nstartxref\n999999\n%%EOF\n"
    write("pdf-twokey-broken-xref.pdf", candidate)
    probe = subprocess.run(["qpdf", "--decrypt", "--qdf", "--object-streams=disable", "--stream-data=uncompress", at("pdf-twokey-broken-xref.pdf"), at("r5-probe.pdf")], capture_output=True, text=True)
    if probe.returncode == 0 or (probe.returncode == 3 and qpdf_recovery_only(probe.stderr)):
        break
else:
    raise SystemExit("no benign two-key candidate")
os.remove(at("r5-probe.pdf"))
# Three trailers (A, B, A), startxref broken.
write("pdf-twokey-three-trailers.pdf", body_a + b"99 0 obj\n" + dict_b_bytes + b"\nendobj\ntrailer\n" + trailer_a + b"\n%%EOF\ntrailer\n" + trailer_b + b"\n%%EOF\ntrailer\n" + trailer_a + b"\nstartxref\n999999\n%%EOF\n")
# A valid /Prev chain whose incremental update switches to dict B (every reader follows the chain; still two dictionaries).
a_xref = int(re.findall(rb"startxref\s+(\d+)", key_a)[-1])
update_offset = len(key_a)
update = b"99 0 obj\n" + dict_b_bytes + b"\nendobj\n"
update_xref = update_offset + len(update)
update += b"xref\n99 1\n%010d 00000 n \ntrailer\n" % update_offset + trailer_b.replace(b"<<", b"<< /Prev %d" % a_xref, 1) + b"\nstartxref\n%d\n%%%%EOF\n" % update_xref
write("pdf-twokey-prev-chain.pdf", key_a + update)
# Object streams: key A written with a cross-reference stream, then dict B under an appended trailer, startxref broken.
key_a_objstm = rc4("ownerpw", "r5-key-a-objstm.pdf", ("--object-streams=generate",))
write("pdf-twokey-objstm.pdf", key_a_objstm + b"99 0 obj\n" + dict_b_bytes + b"\nendobj\ntrailer\n" + trailer_b + b"\nstartxref\n999999\n%%EOF\n")
# The second trailer's /Encrypt spelled with a name escape.
write("pdf-twokey-escaped-name.pdf", candidate.replace(b"/Encrypt 99 0 R", b"/En#63rypt 99 0 R"))
# N-L5: /Encrypt only on the first of two trailers, startxref broken (qpdf: not encrypted; pdf.js: encrypted).
write("pdf-trailer-encrypt-first.pdf", body_a + b"trailer\n" + trailer_a + b"\n%%EOF\ntrailer\n" + re.sub(rb"/Encrypt \d+ 0 R", b"", trailer_a) + b"\nstartxref\n999999\n%%EOF\n")
for name in ("r5-key-a.pdf", "r5-key-b.pdf", "r5-key-a-objstm.pdf", "r5-outline-src.pdf"):
    os.remove(at(name))

# N-M1: a ZIP64 ZIP holding the marker inside one tar, bzip2 or xz layer, embedded in an XLSX; a benign tar control.
import bz2
import io
import lzma
import tarfile


def tar_bytes(name, payload):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        info.mtime = 0
        archive.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


# Deflated, so the marker is not in the wrapper's raw bytes: only a reader that follows ZIP64 inflates it.
zip64_marker = zip_bytes([("e.txt", b"Q3 notes " + MARKER * 4)], zip64=True)
def xlsx_with(embedded):
    return zip_bytes([("[Content_Types].xml", ooxml_types), ("xl/workbook.xml", b"<workbook/>"), ("xl/embeddings/oleObject1.bin", embedded)])


write("nested-tar-zip64.xlsx", xlsx_with(tar_bytes("deck.zip", zip64_marker)))
write("nested-bz2-zip64.xlsx", xlsx_with(bz2.compress(zip64_marker)))
write("nested-xz-zip64.xlsx", xlsx_with(lzma.compress(zip64_marker)))
write("nested-tar-bz2-zip64.xlsx", xlsx_with(bz2.compress(tar_bytes("deck.zip", zip64_marker))))
write("nested-tar-plain.xlsx", xlsx_with(tar_bytes("notes/q3.txt", b"Quarterly results beat the forecast.\n")))

# N-L2: an owner-password raw-marker PDF behind 1,440 NUL bytes (or an ID3 tag) under types with no magic check.
raw_marker_pdf = open(at("pdf-empty-user-owner-raw-marker.pdf"), "rb").read()
for name in ("exempt-pdf-payload.mp3", "exempt-pdf-payload.mov", "exempt-pdf-payload.aac"):
    write(name, b"\0" * 1440 + raw_marker_pdf)
write("exempt-id3-pdf.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\0" * 1440 + raw_marker_pdf)

# N-M2: the marker as a data: URI after 11 MiB of ordinary paragraphs (past Debian's 10M MaxHTMLNormalize), and a control
# with the same URI near the start.
import base64
uri = b'<a href="data:text/plain;base64,' + base64.b64encode(b"Q3 notes " + MARKER) + b'">notes</a>'
paragraph = b"<p>Quarterly results beat the forecast; the team flew to London to open the new office.</p>\n"
write("html-late-datauri-11m.html", b"<!doctype html>\n<html><body>\n" + paragraph * (11 * 1024 * 1024 // len(paragraph) + 1) + uri + b"</body></html>\n")
write("html-early-datauri.html", b"<!doctype html>\n<html><body>\n" + uri + paragraph * 100 + b"</body></html>\n")

# N-L1: an unencrypted PDF whose one Flate stream inflates to 200 MiB of zeros, plus a literal /Encrypt comment: qpdf's
# rewrite is capped at max(64 MiB, 16x the input) and refused, instead of a 200 MiB copy and a second scan.
zeros = zlib.compressobj(9)
bomb = b"".join(zeros.compress(b"\0" * (1 << 20)) for _ in range(200)) + zeros.flush()
bomb_objects = [
    b"<</Type/Catalog/Pages 2 0 R>>",
    b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>",
    b"<</Length %d/Filter/FlateDecode>>stream\n%s\nendstream" % (len(bomb), bomb),
]
bomb_pdf, bomb_offsets = b"%PDF-1.4\n% /Encrypt\n", []
for number, body in enumerate(bomb_objects, 1):
    bomb_offsets.append(len(bomb_pdf))
    bomb_pdf += b"%d 0 obj\n%s\nendobj\n" % (number, body)
bomb_xref = len(bomb_pdf)
bomb_pdf += b"xref\n0 5\n0000000000 65535 f \n" + b"".join(b"%010d 00000 n \n" % o for o in bomb_offsets)
bomb_pdf += b"trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % bomb_xref
write("pdf-literal-encrypt-flate-bomb.pdf", bomb_pdf)
