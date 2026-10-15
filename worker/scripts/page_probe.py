#!/usr/bin/env python3
"""Deterministic per-page PDF features for the page router (free, no model).

Usage: page_probe.py <pdf> [--pages 1,2,5-7] [--thumb-dir DIR --thumb-px 384]

Emits one JSON object per page on stdout (JSON lines). Fields use the camelCase
names of PageFeatures (packages/shared/src/page-routing.ts) so callers can map
them 1:1. Everything is computed from the PDF itself: PyMuPDF text/image/vector
structure plus one 72-DPI grayscale render for blur/contrast/brightness.
Thumbnail PNGs (long edge N px) are optional and excluded from probeMs.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

import fitz  # PyMuPDF
import numpy as np

GRID = 4  # coverage masks are computed on a 1/4 point grid (cells of 4x4 pt)
PROBE_DPI = 72

_MATH_RANGES = (
    (0x2200, 0x22FF),  # mathematical operators
    (0x2A00, 0x2AFF),  # supplemental operators
    (0x27C0, 0x27EF),
    (0x2980, 0x29FF),
    (0x2070, 0x209F),  # super/subscripts
    (0x0391, 0x03C9),  # greek
    (0x1D400, 0x1D7FF),  # math alphanumerics
    (0x2140, 0x214F),
)
_MATH_SINGLE = frozenset("±×÷∑∏√∞≈≠≤≥∂∇∫")


def _is_math(cp: int) -> bool:
    for lo, hi in _MATH_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def _is_unmapped(cp: int) -> bool:
    return cp == 0xFFFD or cp == 0 or 0xE000 <= cp <= 0xF8FF or 0xF0000 <= cp <= 0x10FFFF


def parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(1, count + 1))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return [p for p in out if 1 <= p <= count]


class _Mask:
    """Boolean coverage grid over the page box, for union-area arithmetic."""

    def __init__(self, width: float, height: float):
        self.w = max(1, int(np.ceil(width / GRID)))
        self.h = max(1, int(np.ceil(height / GRID)))
        self.a = np.zeros((self.h, self.w), dtype=bool)

    def add(self, x0: float, y0: float, x1: float, y1: float) -> None:
        i0 = max(0, int(np.floor(x0 / GRID)))
        i1 = min(self.w, int(np.ceil(x1 / GRID)))
        j0 = max(0, int(np.floor(y0 / GRID)))
        j1 = min(self.h, int(np.ceil(y1 / GRID)))
        if i1 > i0 and j1 > j0:
            self.a[j0:j1, i0:i1] = True

    def ratio(self) -> float:
        return float(self.a.mean())


def laplacian_variance(gray: np.ndarray) -> float:
    g = gray.astype(np.float32)
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = (
        g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:] - 4.0 * g[1:-1, 1:-1]
    )
    return float(lap.var())


def text_layer_status(
    chars: int, words: int, unmapped_ratio: float, garbled: bool, image_cov: float, image_count: int
) -> str:
    """ok | suspect | absent | unknown (| ocr-layer, set by probe_page), from free facts only.

    absent: no text and no meaningful imagery (blank or pure vector page).
    unknown: no text but imagery dominates (raster page; the layer may simply be missing).
    suspect: text exists but is garbled/unmapped, or tiny relative to image area.
    """
    if chars == 0:
        return "unknown" if image_cov >= 0.3 else "absent"
    if garbled or unmapped_ratio > 0.03:
        return "suspect"
    if words < 20 and image_cov >= 0.3:
        return "suspect"
    return "ok"


# ---- hidden / OCR text-layer signals (generic; no document-specific knowledge) ----------------------------
# A page whose text sits over a large raster (usually invisible, render mode 3) is a scan carrying an OCR layer.
# Nothing free can tell a faithful OCR layer from a wrong one, so the probe reports the layer as "ocr-layer"
# (not "ok") and `ocr_layer_agreement` below compares it with a cheap re-OCR of one band of the page.
OCR_FONT_RE = re.compile(r"glyphless|invisible|\bocr|hocr|tesseract", re.I)
OCR_PRODUCER_RE = re.compile(
    r"tesseract|ocrmypdf|ocr|abbyy|finereader|paddle|textract|readiris|omnipage|paper ?capture|document ?ai", re.I
)
IMAGE_HOST_COVERAGE = 0.25  # an image counts as a text "host" when it covers this share of the page
OCR_LAYER_OVER_IMAGE = 0.5
# Closed-class English words: prose has them in abundance, garbled or list-of-nouns text does not.
# Only a *suspicion* signal (non-English text legitimately scores low); it never rejects a page by itself.
_COMMON = frozenset(
    "the of and to in is that it for as with was on be by this are at from or an have not but they which you "
    "were all can her has there their will would one more when who what been if its than about into over also "
    "may other some these our out up so them we such only any new no time then could those use two how most "
    "after first said many each between both under while where should because through during before".split()
)


def text_layer_signals(page: "fitz.Page", host_rects: "list[tuple[float, float, float, float]]") -> dict:
    """Per-page signals about *how* the text layer was produced (render mode, host image, fonts, metadata)."""
    total = invisible = over_host = ctrl = 0
    ocr_font = False
    for span in page.get_texttrace():
        chars = span.get("chars") or ()
        n = len(chars)
        if not n:
            continue
        total += n
        if span.get("type") == 3:
            invisible += n
        if OCR_FONT_RE.search(span.get("font") or ""):
            ocr_font = True
        for ch in chars:
            cp = ch[0]
            if cp < 32 and cp not in (9, 10, 13):
                ctrl += 1
            x0, y0, x1, y1 = ch[3]
            cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
            for hx0, hy0, hx1, hy1 in host_rects:
                if hx0 <= cx <= hx1 and hy0 <= cy <= hy1:
                    over_host += 1
                    break
    meta = page.parent.metadata or {}
    producer = f"{meta.get('producer') or ''} {meta.get('creator') or ''}"
    return {
        "invisibleTextRatio": round(invisible / total, 4) if total else 0.0,
        "textOverImageRatio": round(over_host / total, 4) if total else 0.0,
        "controlCharRatio": round(ctrl / total, 4) if total else 0.0,
        "ocrEngineHint": bool(ocr_font or OCR_PRODUCER_RE.search(producer)),
    }


def common_word_ratio(text: str) -> float:
    toks = re.findall(r"[a-z]+", text.lower())
    return round(sum(t in _COMMON for t in toks) / len(toks), 4) if toks else 0.0


def is_ocr_layer(sig: dict, words: int) -> bool:
    """Text laid over a page-sized image: the layer is somebody's OCR output (hidden or drawn), quality unknown."""
    return words >= 3 and sig["textOverImageRatio"] >= OCR_LAYER_OVER_IMAGE


def _tokens(s: str, min_len: int = 2) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", s.lower()) if len(t) >= min_len]


def _cpu_seconds() -> float:
    a, b = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return a.ru_utime + a.ru_stime + b.ru_utime + b.ru_stime


OCR_CHECK_BAND = 0.25   # share of the page height re-OCR'd, centred on the layer's median text line
OCR_CHECK_DPI = 100
OCR_CHECK_MIN_TOKENS = 10
OCR_AGREEMENT_MIN = 0.4  # chosen on development+calibration pages (TL1); faithful layers scored >= 0.8, wrong ones 0.0


def ocr_layer_agreement(page: "fitz.Page", band: float = OCR_CHECK_BAND, dpi: int = OCR_CHECK_DPI, engine: str = "tesseract") -> dict:
    """How well a hidden text layer agrees with a fresh OCR of a horizontal band of the page.

    A band centred on the layer's median text line is rendered at low DPI (hidden text is not drawn), recognised
    once by tesseract, and `agreement` is the share of recognised words (>= 4 letters) found in the layer's own
    vocabulary for the whole page. Containment is used instead of positional alignment because scans are skewed or
    shifted relative to the layer. 0 = unrelated words, ~1 = the layer says what the image says.
    `agreement` is None when the check could not run or read too little (no tesseract, <10 words recognised);
    callers must treat that as "unverified", never as agreement.
    Returns {agreement, tokens, cpuMs, wallMs}.
    """
    from PIL import Image

    t0, c0 = time.perf_counter(), _cpu_seconds()
    out = {"agreement": None, "tokens": 0, "cpuMs": 0.0, "wallMs": 0.0}
    exe = shutil.which(engine)
    words = page.get_text("words")
    if exe and words:
        ys = sorted((w[1] + w[3]) / 2.0 for w in words)
        mid, height = ys[len(ys) // 2], page.rect.height
        clip = fitz.Rect(page.rect.x0, max(0.0, mid - band * height / 2), page.rect.x1, min(height, mid + band * height / 2))
        pix = page.get_pixmap(dpi=dpi, clip=clip, colorspace=fitz.csGRAY, alpha=False)
        buf = io.BytesIO()
        Image.frombytes("L", (pix.width, pix.height), pix.samples).save(buf, "PNG")
        proc = subprocess.run([exe, "stdin", "stdout", "--psm", "4", "-l", "eng"], input=buf.getvalue(),
                              capture_output=True, env={**os.environ, "OMP_THREAD_LIMIT": "1"}, timeout=60)
        got = _tokens(proc.stdout.decode("utf-8", "replace"), 4)
        vocab = set(_tokens(" ".join(w[4] for w in words), 4))
        out["tokens"] = len(got)
        if len(got) >= OCR_CHECK_MIN_TOKENS:
            out["agreement"] = round(sum(t in vocab for t in got) / len(got), 4)
    out["cpuMs"] = round((_cpu_seconds() - c0) * 1000.0, 1)
    out["wallMs"] = round((time.perf_counter() - t0) * 1000.0, 1)
    return out


# ---- unusual / unsupported features (H9): flagged, never silently dropped ------------------------------
_ANNOT_FEATURE = {
    "Highlight": "annotation-highlight",
    "Underline": "annotation-highlight",
    "StrikeOut": "annotation-highlight",
    "Squiggly": "annotation-highlight",
    "Text": "annotation-text",
    "FreeText": "annotation-freetext",
}
# Features whose content is NOT in the native text layer (or cannot be read at all): the router must
# not treat a trusted text layer as the whole page.
_ATTENTION = frozenset(
    {
        "acroform-filled", "annotation-highlight", "annotation-text", "annotation-freetext", "attachment",
        "javascript", "ocg-hidden", "encrypted-user-password",
    }
)


def _is_js(doc: "fitz.Document", xref: int, path: str) -> bool:
    try:
        t, v = doc.xref_get_key(xref, path + "/S")
    except Exception:
        return False
    return t == "name" and v == "/JavaScript"


def document_features(doc: "fitz.Document") -> set[str]:
    """Document-level features that need no page render: attachments, JS, layers, encryption, size."""
    feats: set[str] = set()
    if doc.embfile_count():
        feats.add("attachment")
    if (doc.metadata or {}).get("encryption"):
        feats.add("encrypted-empty-password")
    for _x, ocg in doc.get_ocgs().items():
        feats.add("ocg-visible" if ocg.get("on") else "ocg-hidden")
    cat = doc.pdf_catalog()
    if cat:
        if _is_js(doc, cat, "OpenAction") or doc.xref_get_key(cat, "Names/JavaScript")[0] != "null":
            feats.add("javascript")
    return feats


def page_unusual_features(doc: "fitz.Document", page: "fitz.Page", rotated_text_ratio: float, fonts_meta: dict) -> set[str]:
    feats: set[str] = set()
    widgets = list(page.widgets() or [])
    if widgets:
        filled = any(w.field_value not in (None, "", False, "Off") for w in widgets)
        feats.add("acroform-filled" if filled else "acroform-empty")
    for a in page.annots() or []:
        feats.add(_ANNOT_FEATURE.get(a.type[1], "annotation-other"))
    for l in page.get_links():
        if l["kind"] == fitz.LINK_URI:
            feats.add("link-uri")
        elif l["kind"] == fitz.LINK_GOTO:
            feats.add("link-internal")
    if page.rotation:
        feats.add("rotated-page")
    elif rotated_text_ratio >= 0.5:
        feats.add("rotated-content")
    if max(page.rect.width, page.rect.height) > 1600:
        feats.add("huge-page")
    if fonts_meta.get("type3"):
        feats.add("type3-font")
    if fonts_meta.get("noToUnicode"):
        feats.add("no-tounicode")
    if _is_js(doc, page.xref, "AA/O") or _is_js(doc, page.xref, "AA/C"):
        feats.add("javascript")
    return feats


def _font_meta(doc: "fitz.Document", page: "fitz.Page") -> dict:
    t3 = nou = 0
    for f in page.get_fonts(full=True):
        if f[2] == "Type3":
            t3 += 1
        elif f[2] == "Type0" and doc.xref_get_key(f[0], "ToUnicode")[0] == "null":
            nou += 1
    return {"type3": t3, "noToUnicode": nou}


def probe_page(page: "fitz.Page", page_count: int, doc_features: "set[str] | None" = None) -> dict:
    t0 = time.perf_counter()
    rect = page.rect
    pw, ph = float(rect.width), float(rect.height)
    area = max(pw * ph, 1e-6)

    text_mask = _Mask(pw, ph)
    img_mask = _Mask(pw, ph)
    vec_mask = _Mask(pw, ph)

    # ---- text layer ----
    d = page.get_text("dict")
    chars = words = math_chars = unmapped = printable = 0
    rot_chars = 0
    fonts: set[str] = set()
    smallest: float | None = None
    parts: list[str] = []
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            d_ = line.get("dir", (1.0, 0.0))
            vertical = abs(d_[0]) < 0.5 and abs(d_[1]) > 0.5
            for span in line.get("spans", []):
                txt = span.get("text", "")
                if not txt.strip():
                    continue
                x0, y0, x1, y1 = span["bbox"]
                text_mask.add(x0, y0, x1, y1)
                parts.append(txt)
                fonts.add(span.get("font", ""))
                size = float(span.get("size", 0) or 0)
                if size > 0 and (smallest is None or size < smallest):
                    smallest = size
                for ch in txt:
                    if ch.isspace():
                        continue
                    chars += 1
                    if vertical:
                        rot_chars += 1
                    cp = ord(ch)
                    if _is_unmapped(cp):
                        unmapped += 1
                    elif _is_math(cp) or ch in _MATH_SINGLE:
                        math_chars += 1
                    if ch.isprintable():
                        printable += 1
                words += len(txt.split())
    unmapped_ratio = unmapped / chars if chars else 0.0
    math_ratio = math_chars / chars if chars else 0.0
    garbled = bool(chars >= 20 and (unmapped_ratio > 0.1 or printable / chars < 0.6))

    # ---- images ----
    largest = 0.0
    best_dpi: float | None = None
    best_area = 0.0
    images: list[dict] = []
    for info in page.get_image_info():
        x0, y0, x1, y1 = info["bbox"]
        bw, bh = max(x1 - x0, 0.0), max(y1 - y0, 0.0)
        img_mask.add(x0, y0, x1, y1)
        a = bw * bh
        images.append(
            {
                "bbox": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                "coverage": round(min(a / area, 1.0), 5),
                "widthPx": int(info.get("width", 0) or 0),
                "heightPx": int(info.get("height", 0) or 0),
                "dpi": round(float(info.get("width", 0) or 0) / (bw / 72.0), 1) if bw > 0 else None,
            }
        )
        cov = min(a / area, 1.0)
        if cov > largest:
            largest = cov
        if a > best_area and bw > 0:
            best_area = a
            best_dpi = float(info.get("width", 0)) / (bw / 72.0)
    image_cov = img_mask.ratio()
    full_page = largest >= 0.85

    # ---- vector drawings ----
    drawings = page.get_drawings()
    h_rules = v_rules = 0
    vec_count = 0
    for dr in drawings:
        r = dr["rect"]
        w, h = float(r.width), float(r.height)
        vec_count += 1
        if w * h >= 0.9 * area and not dr.get("color"):
            continue  # full-page background fill
        if w >= 20 and h <= 2.0:
            h_rules += 1
        elif h >= 12 and w <= 2.0:
            v_rules += 1
        elif dr.get("items") and all(it[0] == "re" for it in dr["items"]):
            # thin filled rectangles used as rules
            for it in dr["items"]:
                rr = it[1]
                if rr.width >= 20 and rr.height <= 2.0:
                    h_rules += 1
                elif rr.height >= 12 and rr.width <= 2.0:
                    v_rules += 1
        vec_mask.add(r.x0, r.y0, r.x1, r.y1)
    covered = text_mask.a | img_mask.a
    uncovered = float((vec_mask.a & ~covered).mean())
    table_rule = float(min(h_rules, v_rules))

    # ---- 72 DPI grayscale render ----
    pix = page.get_pixmap(dpi=PROBE_DPI, colorspace=fitz.csGRAY, alpha=False)
    gray = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    blur = laplacian_variance(gray)
    p1, p99 = np.percentile(gray, [1, 99])
    contrast = float((p99 - p1) / 255.0)
    brightness = float(gray.mean() / 255.0)

    image_count = len(images)
    images.sort(key=lambda im: -im["coverage"])
    host_rects = [tuple(im["bbox"]) for im in images if im["coverage"] >= IMAGE_HOST_COVERAGE]
    sig = text_layer_signals(page, host_rects) if chars else {
        "invisibleTextRatio": 0.0, "textOverImageRatio": 0.0, "controlCharRatio": 0.0, "ocrEngineHint": False}
    common = common_word_ratio(" ".join(parts))
    status = text_layer_status(chars, words, unmapped_ratio, garbled, image_cov, image_count)
    if status in ("ok", "suspect") and is_ocr_layer(sig, words):
        status = "ocr-layer"
    pno = page.number + 1
    facts_line = (
        f"P{pno:02d}: {words} words, {image_count} image{'s' if image_count != 1 else ''}"
        + (f" covering {round(image_cov * 100)}%" if image_count else "")
        + (", text layer ok" if status == "ok" else ", text layer lies over a page image (OCR layer, unverified)" if status == "ocr-layer" else f", text layer {status}")
    )
    doc = page.parent
    unusual = set(doc_features or ()) | page_unusual_features(doc, page, rot_chars / chars if chars else 0.0, _font_meta(doc, page))
    if page_count >= 100 and words < 5 and chars < 40:
        unusual.add("sparse-multipage")
    # unmapped-glyph fonts decode to printable-looking garbage: flag the layer, do not trust it
    if "no-tounicode" in unusual and status == "ok":
        status = "suspect"
        facts_line = facts_line.replace("text layer ok", "text layer suspect")
    probe_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "pageNumber": page.number + 1,
        "pageCount": page_count,
        "charCount": chars,
        "wordCount": words,
        "textCoverage": round(text_mask.ratio(), 5),
        "fontCount": len(fonts),
        "unmappedGlyphRatio": round(unmapped_ratio, 5),
        "mathGlyphRatio": round(math_ratio, 5),
        "tableRuleScore": table_rule,
        "imageCoverage": round(image_cov, 5),
        "largestImageCoverage": round(largest, 5),
        "fullPageImage": full_page,
        "largestImageDpi": round(best_dpi, 1) if best_dpi is not None else None,
        "vectorDrawingCount": vec_count,
        "uncoveredVectorRatio": round(uncovered, 5),
        "garbled": garbled,
        "blur": round(blur, 3),
        "contrast": round(contrast, 4),
        "brightness": round(brightness, 4),
        "textLayerStatus": status,
        **sig,
        "commonWordRatio": common,
        "imageCount": image_count,
        "textFacts": {
            "wordCount": words,
            "imageCount": image_count,
            "imageCoverage": round(image_cov, 5),
            "textLayerStatus": status,
            "line": facts_line,
        },
        "images": images[:32],
        "smallestFontPt": round(smallest, 2) if smallest is not None else None,
        "widthPt": round(pw, 2),
        "heightPt": round(ph, 2),
        "rotation": int(page.rotation),
        "unusualFeatures": sorted(unusual),
        "needsAttention": bool(unusual & _ATTENTION),
        "probeMs": round(probe_ms, 2),
    }


def apply_ocr_check(row: dict, check: dict) -> None:
    """Fold a verification result into the row: agreeing layers become "ok", disagreeing ones "suspect",
    and a check that could not run leaves the layer "ocr-layer" (unverified)."""
    row["ocrLayerCheck"] = check
    agreement = check["agreement"]
    if agreement is None:
        return
    status = "ok" if agreement >= OCR_AGREEMENT_MIN else "suspect"
    old = row["textFacts"]["line"].rsplit(", text layer", 1)[0]
    note = "ok (OCR layer matches the page image)" if status == "ok" else "suspect (OCR layer disagrees with the page image)"
    row["textLayerStatus"] = row["textFacts"]["textLayerStatus"] = status
    row["textFacts"]["line"] = f"{old}, text layer {note}"


def write_thumbnail(page: "fitz.Page", out_dir: Path, long_px: int, stem: str) -> str:
    rect = page.rect
    scale = long_px / max(rect.width, rect.height, 1.0)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{stem}-p{page.number + 1:04d}.png"
    pix.save(str(path))
    return str(path)


def probe_pdf(
    path: str | Path,
    pages: str | None = None,
    thumb_dir: str | Path | None = None,
    thumb_px: int = 384,
    verify_ocr_layer: bool = False,
):
    doc = fitz.open(str(path))
    try:
        stem = Path(path).stem
        if doc.needs_pass:
            # Locked document: emit one explicit row instead of silently yielding nothing.
            yield {
                "pageNumber": 0, "pageCount": 0, "locked": True, "textLayerStatus": "unknown",
                "unusualFeatures": ["encrypted-user-password"], "needsAttention": True,
                "textFacts": {"line": "document locked (user password required)", "textLayerStatus": "unknown"},
            }
            return
        doc_features = document_features(doc)
        for pno in parse_pages(pages, doc.page_count):
            page = doc[pno - 1]
            row = probe_page(page, doc.page_count, doc_features)
            if verify_ocr_layer and row["textLayerStatus"] == "ocr-layer":
                apply_ocr_check(row, ocr_layer_agreement(page))
            if thumb_dir:
                row["thumbnail"] = write_thumbnail(page, Path(thumb_dir), thumb_px, stem)
            yield row
    finally:
        doc.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf")
    ap.add_argument("--pages", default=None, help="1-based, e.g. 1,2,5-7")
    ap.add_argument("--thumb-dir", default=None)
    ap.add_argument("--thumb-px", type=int, default=384)
    ap.add_argument("--verify-ocr-layer", action="store_true",
                    help="re-OCR a few lines of hidden OCR layers (tesseract) and add ocrLayerAgreement")
    args = ap.parse_args(argv)
    for row in probe_pdf(args.pdf, args.pages, args.thumb_dir, args.thumb_px, verify_ocr_layer=args.verify_ocr_layer):
        sys.stdout.write(json.dumps(row, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
