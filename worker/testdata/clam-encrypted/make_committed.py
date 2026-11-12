# Generates the committed encrypted fixtures (benign payload). Run: python -I gen_committed.py OUTDIR SRCDIR
import io, sys, os, py7zr, msoffcrypto, pyzipper, docx, openpyxl
from msoffcrypto.format.ooxml import OOXMLFile
out, src = sys.argv[1], sys.argv[2]
PW = "fixture-secret"
note = b"Quarterly results beat the forecast; the London expansion opens in spring.\n"
open(os.path.join(src, "note.txt"), "wb").write(note)
for name, hdr in (("7z-password.7z", False), ("7z-encrypted-headers.7z", True)):
    with py7zr.SevenZipFile(os.path.join(out, name), "w", password=PW, header_encryption=hdr) as z:
        z.writestr(note, "note.txt")
with pyzipper.AESZipFile(os.path.join(out, "zip-aes256.zip"), "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as z:
    z.setpassword(PW.encode()); z.writestr("note.txt", note)
d = docx.Document(); d.add_paragraph("Quarterly results beat the forecast."); d.save(os.path.join(src, "plain.docx"))
wb = openpyxl.Workbook(); wb.active["A1"] = "Revenue"; wb.active["B1"] = 125; wb.save(os.path.join(src, "plain.xlsx"))
for kind in ("docx", "xlsx"):
    f = OOXMLFile(open(os.path.join(src, f"plain.{kind}"), "rb"))
    with open(os.path.join(out, f"ooxml-encrypted.{kind}"), "wb") as o:
        f.encrypt(PW, o)
