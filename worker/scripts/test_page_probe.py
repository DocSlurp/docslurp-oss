import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import fitz

sys.path.insert(0, str(Path(__file__).parent))
import page_probe  # noqa: E402


def make_pdf(path: Path) -> None:
    doc = fitz.open()
    p = doc.new_page()
    p.insert_textbox(fitz.Rect(50, 50, 550, 700), "The quick brown fox jumps over the lazy dog. " * 40, fontsize=11)
    doc.new_page()  # blank
    p = doc.new_page()  # raster page
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 300, 400), False)
    pix.set_rect(pix.irect, (200, 30, 30))
    p.insert_image(p.rect, pixmap=pix)
    p = doc.new_page()  # ruled table
    for i in range(6):
        p.draw_line((50, 100 + i * 30), (500, 100 + i * 30))
        p.draw_line((50 + i * 90, 100), (50 + i * 90, 250))
    p.insert_text((60, 90), "a b c", fontsize=10)
    doc.save(str(path))


class PageProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.pdf = Path(cls.tmp.name) / "t.pdf"
        make_pdf(cls.pdf)
        cls.rows = list(page_probe.probe_pdf(cls.pdf))

    def test_text_page(self):
        r = self.rows[0]
        self.assertGreater(r["wordCount"], 100)
        self.assertEqual(r["textLayerStatus"], "ok")
        self.assertFalse(r["fullPageImage"])
        self.assertIn("text layer ok", r["textFacts"]["line"])

    def test_blank_page(self):
        r = self.rows[1]
        self.assertEqual(r["charCount"], 0)
        self.assertEqual(r["textLayerStatus"], "absent")

    def test_raster_page(self):
        r = self.rows[2]
        self.assertTrue(r["fullPageImage"])
        self.assertEqual(r["textLayerStatus"], "unknown")
        self.assertEqual(r["imageCount"], 1)
        self.assertGreater(r["images"][0]["coverage"], 0.9)
        self.assertGreater(r["largestImageDpi"], 0)

    def test_table_rules(self):
        self.assertGreaterEqual(self.rows[3]["tableRuleScore"], 4)
        self.assertGreater(self.rows[3]["vectorDrawingCount"], 8)

    def test_deterministic_and_pages_arg(self):
        a = list(page_probe.probe_pdf(self.pdf, "1,3"))
        self.assertEqual([r["pageNumber"] for r in a], [1, 3])
        strip = lambda r: {k: v for k, v in r.items() if k != "probeMs"}
        self.assertEqual(strip(a[0]), strip(self.rows[0]))

    def test_thumbnail(self):
        with tempfile.TemporaryDirectory() as d:
            r = list(page_probe.probe_pdf(self.pdf, "1", d, 200))[0]
            pix = fitz.Pixmap(r["thumbnail"])
            self.assertEqual(max(pix.width, pix.height), 200)

    def test_parse_pages(self):
        self.assertEqual(page_probe.parse_pages("1,3-4,9", 5), [1, 3, 4])


def _text_doc(pages: int = 1) -> "fitz.Document":
    doc = fitz.open()
    for _ in range(pages):
        p = doc.new_page()
        p.insert_textbox(fitz.Rect(50, 50, 550, 700), "Plain body text for the probe. " * 30, fontsize=11)
    return doc


class UnusualFeaturesTest(unittest.TestCase):
    def probe(self, doc: "fitz.Document", name: str = "u.pdf", encrypt: dict | None = None) -> list[dict]:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / name
            if encrypt:
                doc.save(str(path), **encrypt)
            else:
                doc.save(str(path))
            return list(page_probe.probe_pdf(path))

    def test_plain_document_has_no_features(self):
        r = self.probe(_text_doc())[0]
        self.assertEqual(r["unusualFeatures"], [])
        self.assertFalse(r["needsAttention"])

    def test_acroform_filled_vs_empty(self):
        for value, expected in (("Alice", "acroform-filled"), ("", "acroform-empty")):
            doc = _text_doc()
            w = fitz.Widget()
            w.field_name, w.field_type, w.rect = "name", fitz.PDF_WIDGET_TYPE_TEXT, fitz.Rect(60, 720, 250, 745)
            w.field_value = value
            doc[0].add_widget(w)
            r = self.probe(doc)[0]
            self.assertIn(expected, r["unusualFeatures"])
            self.assertEqual(r["needsAttention"], expected == "acroform-filled")

    def test_annotations_by_subtype(self):
        doc = _text_doc()
        page = doc[0]
        page.add_highlight_annot(fitz.Rect(50, 50, 200, 65))
        page.add_text_annot((300, 300), "sticky note text")
        page.add_freetext_annot(fitz.Rect(300, 400, 500, 440), "free text note")
        r = self.probe(doc)[0]
        for f in ("annotation-highlight", "annotation-text", "annotation-freetext"):
            self.assertIn(f, r["unusualFeatures"])
        self.assertTrue(r["needsAttention"])

    def test_attachment_flags_every_page(self):
        doc = _text_doc(2)
        doc.embfile_add("notes.txt", b"hidden attachment")
        rows = self.probe(doc)
        for r in rows:
            self.assertIn("attachment", r["unusualFeatures"])
            self.assertTrue(r["needsAttention"])

    def test_links_and_rotation_and_huge_page(self):
        doc = _text_doc()
        doc[0].insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(50, 50, 150, 65), "uri": "https://example.com"})
        doc[0].set_rotation(90)
        big = doc.new_page(width=3000, height=4000)
        big.insert_text((100, 100), "big page")
        rows = self.probe(doc)
        self.assertIn("link-uri", rows[0]["unusualFeatures"])
        self.assertIn("rotated-page", rows[0]["unusualFeatures"])
        self.assertFalse(rows[0]["needsAttention"])  # reported, not dropped, but nothing is lost
        self.assertIn("huge-page", rows[1]["unusualFeatures"])

    def test_encrypted_empty_password_is_readable_and_flagged(self):
        doc = _text_doc()
        rows = self.probe(doc, encrypt={"encryption": fitz.PDF_ENCRYPT_AES_256, "owner_pw": "owner", "user_pw": ""})
        self.assertGreater(rows[0]["wordCount"], 20)
        self.assertIn("encrypted-empty-password", rows[0]["unusualFeatures"])

    def test_locked_document_yields_explicit_row(self):
        doc = _text_doc()
        rows = self.probe(doc, encrypt={"encryption": fitz.PDF_ENCRYPT_AES_256, "owner_pw": "owner", "user_pw": "secret"})
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["locked"])
        self.assertTrue(rows[0]["needsAttention"])
        self.assertEqual(rows[0]["unusualFeatures"], ["encrypted-user-password"])

    def test_sparse_multipage(self):
        doc = fitz.open()
        for _ in range(100):
            doc.new_page()
        rows = self.probe(doc)
        self.assertEqual(len(rows), 100)
        self.assertIn("sparse-multipage", rows[0]["unusualFeatures"])


PROSE = (
    "The committee reviewed the quarterly results and agreed that the new process should replace the old one "
    "because it reduces delays between the first request and the final approval of each application. "
) * 6
OTHER = ("velvet harpoon quartz falcon espresso lantern marmot orchid nebula juniper kayak sonnet trombone " * 8)


def scan_pdf(path: Path, layer_text: str, render_mode: int = 3, image_text: str = PROSE) -> None:
    """A page that is one raster of `image_text` with `layer_text` laid over it (render mode 3 = hidden)."""
    src = fitz.open()
    p = src.new_page()
    p.insert_textbox(fitz.Rect(40, 40, 570, 760), image_text, fontsize=13)
    png = p.get_pixmap(dpi=110).tobytes("png")
    doc = fitz.open()
    q = doc.new_page()
    q.insert_image(q.rect, stream=png)
    q.insert_textbox(fitz.Rect(40, 40, 570, 760), layer_text, fontsize=13, render_mode=render_mode)
    doc.save(str(path))


class OcrLayerTest(unittest.TestCase):
    def rows(self, **kw):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.pdf"
            scan_pdf(path, **kw)
            return list(page_probe.probe_pdf(path, verify_ocr_layer=True))

    def test_hidden_text_over_image_is_an_ocr_layer_not_ok(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.pdf"
            scan_pdf(path, layer_text=PROSE)
            r = list(page_probe.probe_pdf(path))[0]  # no verification requested
        self.assertEqual(r["textLayerStatus"], "ocr-layer")
        self.assertGreater(r["invisibleTextRatio"], 0.95)
        self.assertGreater(r["textOverImageRatio"], 0.9)
        self.assertIn("OCR layer", r["textFacts"]["line"])

    def test_visible_text_over_page_image_is_also_checked(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.pdf"
            scan_pdf(path, layer_text=PROSE, render_mode=0)
            self.assertEqual(list(page_probe.probe_pdf(path))[0]["textLayerStatus"], "ocr-layer")

    def test_plain_text_page_stays_ok_with_no_ocr_check(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "t.pdf"
            _text_doc().save(str(path))
            r = list(page_probe.probe_pdf(path, verify_ocr_layer=True))[0]
        self.assertEqual(r["textLayerStatus"], "ok")
        self.assertEqual(r["invisibleTextRatio"], 0.0)
        self.assertNotIn("ocrLayerCheck", r)

    @unittest.skipUnless(shutil.which("tesseract"), "tesseract not installed")
    def test_agreement_separates_faithful_from_unrelated_layer(self):
        good, bad = self.rows(layer_text=PROSE)[0], self.rows(layer_text=OTHER)[0]
        self.assertGreater(good["ocrLayerCheck"]["agreement"], 0.8)
        self.assertEqual(bad["ocrLayerCheck"]["agreement"], 0.0)
        self.assertGreater(good["ocrLayerCheck"]["cpuMs"], 0)
        self.assertEqual((good["textLayerStatus"], bad["textLayerStatus"]), ("ok", "suspect"))
        self.assertIn("disagrees", bad["textFacts"]["line"])
        self.assertEqual(bad["textFacts"]["textLayerStatus"], "suspect")

    def test_common_word_ratio(self):
        self.assertGreater(page_probe.common_word_ratio(PROSE), 0.2)
        self.assertEqual(page_probe.common_word_ratio(OTHER), 0.0)


if __name__ == "__main__":
    unittest.main()
