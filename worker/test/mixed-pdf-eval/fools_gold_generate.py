#!/usr/bin/env python3
"""Build deterministic, source-free mixed-layout PDF extraction fixtures.

The authored references and gold labels are written before any raster damage.
All generated content is invented from the structural spec; this module never
reads another corpus, fixture, label, or source document.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import io
import json
import math
import os
import random
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import fitz
from PIL import Image, ImageEnhance, ImageFilter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle


PAGE_W, PAGE_H = letter
MARGIN = 46
INK = colors.HexColor("#263540")
MUTED = colors.HexColor("#65737D")
TEAL = colors.HexColor("#286C72")
PALE = colors.HexColor("#EAF1F0")
RULE = colors.HexColor("#C7D2D2")
RASTER_SHARES = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
HARD_COUNTS = (0, 2, 4, 6, 8, 10)
LAYOUTS = ("single-column-report", "two-column-technical-note", "side-panel-chart")
GENRES = ("operations review", "equipment guidance", "engineering note", "inspection record", "procurement brief", "research discussion")
TOPICS = ("thermal drift", "flow stability", "seal wear", "power variance", "sensor alignment", "filter loading", "cycle timing", "pressure balance", "material fatigue", "sampling cadence")
LOCATIONS = ("west service bay", "upper test room", "river intake station", "north assembly hall", "field calibration unit", "central stores", "east pump gallery", "instrument bench")
DEVICES = ("PX-41 regulator", "Morrowline gauge", "Kestrel valve", "Aster relay", "Rillmark sensor", "Tandem drive", "Cairn filter", "Vela coupling", "Orchard controller", "Linden meter")
TEAMS = ("Systems Review Office", "Northline Technical Group", "Field Reliability Unit", "Materials Desk", "Process Assurance Team", "Applied Measurements Office")
NOUNS = ("reading", "inspection", "sample", "cycle", "assembly", "work order", "test interval", "spare set")
VERBS = ("remained within the expected band", "shifted after the second interval", "recovered following a controlled reset", "varied with the ambient load", "showed a gradual increase", "held steady through the repeat run")
PARAGRAPH_TAILS = (
    "The review therefore keeps the current limit in place while the next scheduled check gathers a longer comparison window.",
    "Operators should record the opening condition and the final reading together so that later checks retain the same context.",
    "This conclusion is provisional because the latest series covers one duty cycle and does not represent seasonal operation.",
    "A repeat measurement is planned after the replacement interval, with the same instrument position and sampling cadence.",
    "The group found no basis for changing the release sequence, although the observed spread warrants a closer look next month.",
    "The note separates direct observations from interpretation because the available records do not establish a single cause.",
)


@dataclass(frozen=True)
class Family:
    number: int
    layout: str
    raster_share: float


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_json(data: Any) -> str:
    return digest_bytes(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())


def font_path(pattern: str) -> str:
    roots = (Path("/usr/share/fonts/truetype/noto"), Path("/usr/share/fonts/noto"))
    for root in roots:
        if root.exists():
            paths = sorted(root.rglob(pattern))
            if paths:
                return str(paths[0])
    raise RuntimeError(f"Required Noto font not found: {pattern}")


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("FoolsSans", font_path("NotoSans-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("FoolsSansBold", font_path("NotoSans-Bold.ttf")))
    pdfmetrics.registerFont(TTFont("FoolsSerif", font_path("NotoSerif-Regular.ttf")))


def para_style(name: str, *, size: float = 9.2, leading: float = 12.1, color: colors.Color = INK, font: str = "FoolsSans", alignment: int = TA_LEFT) -> ParagraphStyle:
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=leading, textColor=color, alignment=alignment, spaceAfter=0, splitLongWords=1, allowWidows=0, allowOrphans=0)


def pdraw(c: Any, text: str, x: float, top: float, width: float, style: ParagraphStyle, max_height: float | None = None) -> tuple[float, float]:
    p = Paragraph(text, style)
    w, h = p.wrap(width, PAGE_H)
    if max_height is not None and h > max_height + 0.25:
        raise ValueError(f"paragraph overflow: {h:.1f}pt > {max_height:.1f}pt")
    p.drawOn(c, x, top - h)
    return w, h


def words(seed: int, count: int, topic: str, device: str, location: str, team: str, role: str) -> str:
    rng = random.Random(seed)
    phrases = [
        f"During the {role}, the {team} examined {topic} at the {location} using the {device}.",
        f"The opening {rng.choice(NOUNS)} {rng.choice(VERBS)}, while a second pass produced a slightly wider spread.",
        f"Staff compared the result with the preceding work period and retained the existing operating threshold.",
        f"No single observation explains the difference; ambient load, alignment and recent service history remain plausible contributors.",
        f"The current record supports continued operation under routine monitoring, with escalation tied to a repeated boundary crossing.",
        f"Measurements were collected at consistent intervals and entered before any adjustment was made to the assembly.",
        f"The next review will compare a longer sequence and note whether the shift persists after ordinary maintenance.",
    ]
    while sum(len(p.split()) for p in phrases) < count:
        phrases.append(rng.choice(PARAGRAPH_TAILS))
    out: list[str] = []
    for phrase in phrases:
        if sum(len(p.split()) for p in out) + len(phrase.split()) <= count:
            out.append(phrase)
        if sum(len(p.split()) for p in out) >= count - 10:
            break
    return " ".join(out)


def paragraphs_for(seed: int, count: int, topic: str, device: str, location: str, team: str, role: str) -> list[str]:
    full = words(seed, count, topic, device, location, team, role)
    tokens = full.split()
    # Split by sentences, retaining 2–3 coherent paragraphs.
    sentences = full.replace(". ", ".| ").split("|")
    if len(sentences) < 3:
        return [full]
    mid = max(1, len(sentences) // 2)
    return [" ".join(sentences[:mid]).strip(), " ".join(sentences[mid:]).strip()]


def table_data(seed: int, topic: str) -> tuple[list[list[str]], list[str]]:
    rng = random.Random(seed)
    headers = ["Interval", "Observed", "Reference", "Disposition"]
    rows = [headers]
    formulas: list[str] = []
    base = rng.uniform(18.2, 42.6)
    for i in range(1, 5):
        observed = base + rng.uniform(-2.1, 2.4) + i * rng.uniform(-0.28, 0.44)
        low, high = observed - rng.uniform(3.6, 5.1), observed + rng.uniform(4.0, 5.4)
        status = "within band" if low <= observed <= high else "review"
        rows.append([f"Run {i:02d}", f"{observed:.1f} units", f"{low:.1f}–{high:.1f}", status])
    formulas.append(f"Each {topic} observation is compared with its recorded reference interval; no row is derived from a real dataset.")
    return rows, formulas


def make_chart(seed: int, topic: str) -> tuple[list[dict[str, Any]], str]:
    rng = random.Random(seed)
    labels = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"]
    vals = [round(30 + i * 0.7 + rng.uniform(-2.4, 2.5), 1) for i in range(len(labels))]
    series = [{"time": t, "measured": v, "referenceLow": 27.5, "referenceHigh": 37.5} for t, v in zip(labels, vals)]
    return series, "Measured values are plotted against a fixed reference band; points are repeated observations from this invented operating record."


def draw_vector_chart(c: Any, series: list[dict[str, Any]], x: float, top: float, width: float, height: float, title: str) -> None:
    """Draw a compact data chart with vector paths, grid, axis labels, and legend."""
    left, right = x + 23, x + width - 5
    chart_top, chart_bottom = top - 17, top - height + 18
    lo, hi = 24.0, 42.0
    ymap = lambda v: chart_bottom + (v - lo) * (chart_top - chart_bottom) / (hi - lo)
    c.setFillColor(INK)
    c.setFont("FoolsSansBold", 6.3)
    c.drawString(x + 2, top - 8, title[:24])
    c.setFillColor(colors.HexColor("#DCEBEA"))
    c.rect(left, ymap(37.5), right - left, ymap(27.5) - ymap(37.5), fill=1, stroke=0)
    c.setStrokeColor(RULE)
    c.setLineWidth(.35)
    for tick in (25, 30, 35, 40):
        y = ymap(tick)
        c.line(left, y, right, y)
        c.setFont("FoolsSans", 5.2)
        c.setFillColor(MUTED)
        c.drawRightString(left - 3, y - 2, str(tick))
    c.setStrokeColor(TEAL)
    c.setLineWidth(1.15)
    pts = []
    for i, row in enumerate(series):
        px = left + i * (right - left) / (len(series) - 1)
        pts.append((px, ymap(row["measured"])))
    path = c.beginPath()
    path.moveTo(*pts[0])
    for pt in pts[1:]:
        path.lineTo(*pt)
    c.drawPath(path, stroke=1, fill=0)
    c.setFillColor(TEAL)
    for px, py in pts:
        c.circle(px, py, 1.8, fill=1, stroke=0)
    c.setFont("FoolsSans", 4.8)
    c.setFillColor(MUTED)
    for i, row in enumerate(series):
        px = left + i * (right - left) / (len(series) - 1)
        c.drawCentredString(px, chart_bottom - 8, row["time"])
    leg_y = chart_bottom - 16
    c.setStrokeColor(TEAL)
    c.setLineWidth(1.1)
    c.line(left, leg_y, left + 9, leg_y)
    c.setFillColor(MUTED)
    c.drawString(left + 11, leg_y - 2, "Measured")
    c.setFillColor(colors.HexColor("#DCEBEA"))
    c.rect(left + 54, leg_y - 2, 8, 5, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.drawString(left + 65, leg_y - 2, "Reference band")


def table_height(rows: list[list[str]], width: float) -> float:
    t = Table(rows, colWidths=[width * .19, width * .21, width * .28, width * .32], repeatRows=1)
    _, h = t.wrap(width, PAGE_H)
    return h


def draw_table(c: Any, rows: list[list[str]], x: float, top: float, width: float) -> float:
    t = Table(rows, colWidths=[width * .19, width * .21, width * .28, width * .32], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TEAL), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "FoolsSansBold"), ("FONTNAME", (0, 1), (-1, -1), "FoolsSans"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.6), ("LEADING", (0, 0), (-1, -1), 9.4),
        ("GRID", (0, 0), (-1, -1), .45, RULE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F7F7")]),
    ]))
    _, h = t.wrap(width, PAGE_H)
    t.drawOn(c, x, top - h)
    return h


def draw_header(c: Any, family: Family, page: int, title: str, subtitle: str) -> dict[str, list[float]]:
    c.setFillColor(TEAL)
    c.rect(MARGIN, PAGE_H - 29, 27, 3, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.setFont("FoolsSans", 7.4)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 31, f"{title.upper()}  /  {page:02d}")
    c.setFillColor(INK)
    title_style = para_style("title", size=16, leading=18.4, color=INK, font="FoolsSansBold")
    _, htitle = pdraw(c, title, MARGIN, PAGE_H - 56, PAGE_W - 2 * MARGIN, title_style, 40)
    subtitle_style = para_style("subtitle", size=8.7, leading=11.5, color=MUTED, font="FoolsSerif")
    _, hsub = pdraw(c, subtitle, MARGIN, PAGE_H - 62 - htitle, PAGE_W - 2 * MARGIN, subtitle_style, 24)
    c.setStrokeColor(RULE)
    c.setLineWidth(.6)
    c.line(MARGIN, PAGE_H - 75 - htitle - hsub, PAGE_W - MARGIN, PAGE_H - 75 - htitle - hsub)
    return {"heading": [MARGIN, PAGE_H - 58 - htitle, PAGE_W - MARGIN, PAGE_H - 56], "subtitle": [MARGIN, PAGE_H - 64 - htitle - hsub, PAGE_W - MARGIN, PAGE_H - 62 - htitle]}


def draw_footer(c: Any, family: Family, page: int) -> None:
    c.setStrokeColor(RULE)
    c.setLineWidth(.45)
    c.line(MARGIN, 35, PAGE_W - MARGIN, 35)
    c.setFont("FoolsSans", 7.1)
    c.setFillColor(MUTED)
    c.drawString(MARGIN, 23, "Operations record  ·  Controlled review copy")
    c.drawRightString(PAGE_W - MARGIN, 23, f"Page {page} of 10")


def draw_page(c: Any, family: Family, page: int, source_dir: Path) -> dict[str, Any]:
    seed = family.number * 1009 + page * 97 + 41
    rng = random.Random(seed)
    topic, location, device = rng.choice(TOPICS), rng.choice(LOCATIONS), rng.choice(DEVICES)
    team, role = rng.choice(TEAMS), rng.choice(GENRES)
    title = f"{topic.title()} Review and Follow-up"
    subtitle = f"{location.title()} · {team} · Review dated {(date(2024, 2, 5) + timedelta(days=page * 9 + family.number)).strftime('%d %B %Y')}"
    refs = draw_header(c, family, page, title, subtitle)
    body_count = 150 + (page * 7 + family.number * 3) % 28
    paras = paragraphs_for(seed, body_count, topic, device, location, team, role)
    excerpt_count = 47 + (page + family.number) % 17
    excerpt = words(seed + 77, excerpt_count, topic, device, location, team, role)
    commentary = words(seed + 91, 30 + page % 9, topic, device, location, team, role)
    rows, formulas = table_data(seed + 11, topic)
    upper_y = PAGE_H - 92 - 34
    body_style = para_style("body", size=8.65 if family.layout == LAYOUTS[1] else 9.0, leading=11.25)
    section_boxes: list[dict[str, Any]] = []
    if family.layout == LAYOUTS[1]:
        col_gap = 22
        col_w = (PAGE_W - 2 * MARGIN - col_gap) / 2
        # Assign complete prose paragraphs to each column, retaining reading order.
        grouped = [paras[:1], paras[1:]]
        x_positions = [MARGIN, MARGIN + col_w + col_gap]
        body_top = upper_y
        max_body_h = 206
        for col, (x, items) in enumerate(zip(x_positions, grouped)):
            top = body_top
            for i, txt in enumerate(items):
                _, h = pdraw(c, txt, x, top, col_w, body_style, max_body_h)
                section_boxes.append({"id": f"p{page}.body{col + 1}.{i + 1}", "role": "body", "bbox": [x, top - h, x + col_w, top], "text": txt})
                top -= h + 8
        body_bottom = min(b["bbox"][1] for b in section_boxes)
        content_top = body_bottom - 14
    else:
        x, width, top = MARGIN, (318 if family.layout == LAYOUTS[2] else PAGE_W - 2 * MARGIN), upper_y
        mid = (len(paras) + 1) // 2
        for i, txt in enumerate(paras[:mid]):
            _, h = pdraw(c, txt, x, top, width, body_style, 208)
            section_boxes.append({"id": f"p{page}.body.{i + 1}", "role": "body", "bbox": [x, top - h, x + width, top], "text": txt})
            top -= h + 7
        content_top = top - 3
        for i, txt in enumerate(paras[mid:], start=mid):
            _, h = pdraw(c, txt, x, content_top, width, body_style, 208)
            section_boxes.append({"id": f"p{page}.body.{i + 1}", "role": "body", "bbox": [x, content_top - h, x + width, content_top], "text": txt})
            content_top -= h + 7
        content_top -= 5

    # The table remains a native ReportLab object on the first eight pages.
    table_rows = rows if page % 5 not in (0,) else None
    chart_series = None
    chart_note = None
    if family.layout == LAYOUTS[2] and page % 3 == 0:
        chart_series, chart_note = make_chart(seed + 19, topic)
    if family.layout == LAYOUTS[2]:
        # A narrow side panel carries the chart or a compact observation block.
        main_w = 318
        panel_x = MARGIN + main_w + 15
        panel_w = PAGE_W - MARGIN - panel_x
        c.setFillColor(PALE)
        c.roundRect(panel_x, 133, panel_w, 300, 8, fill=1, stroke=0)
        c.setFillColor(TEAL)
        c.setFont("FoolsSansBold", 8)
        c.drawString(panel_x + 10, 417, "OBSERVATION PANEL")
        if chart_series:
            draw_vector_chart(c, chart_series, panel_x + 8, 400, panel_w - 16, 104, f"{topic.title()} by interval")
            pdraw(c, chart_note or "", panel_x + 10, 282, panel_w - 20, para_style("chartnote", size=7.1, leading=9.1, color=INK), 50)
        else:
            note = f"The {device} at {location} held a stable baseline after the adjustment. A second check is due before the next service interval."
            pdraw(c, note, panel_x + 10, 396, panel_w - 20, para_style("side", size=8, leading=10.5), 96)
            c.setFont("FoolsSans", 7.2)
            c.setFillColor(MUTED)
            c.drawString(panel_x + 10, 280, f"Topic: {topic}")
            c.drawString(panel_x + 10, 266, f"Location: {location}")
        table_width = main_w
    else:
        table_width = PAGE_W - 2 * MARGIN
    table_h = 0.0
    table_box = None
    if table_rows:
        table_h = table_height(table_rows, table_width)
        table_top = min(content_top - 9, 400)
        table_bottom = table_top - table_h
        if table_bottom < 199:
            raise ValueError(f"native table overflows usable page on family {family.number} page {page}")
        table_h = draw_table(c, table_rows, MARGIN, table_top, table_width)
        table_box = [MARGIN, table_top - table_h, MARGIN + table_width, table_top]
        c.setFont("FoolsSans", 7.0)
        c.setFillColor(MUTED)
        c.drawString(MARGIN, table_top + 5, "Recorded comparison")
    else:
        table_box = None

    # Embedded excerpt image on selected pages, otherwise selectable inset text.
    inset_x = MARGIN
    inset_width = PAGE_W - 2 * MARGIN
    inset_bottom = 66
    inset_top = min(215, (table_box[1] - 10) if table_box else 232)
    inset_height = max(82, inset_top - inset_bottom)
    if inset_height < 78:
        raise ValueError(f"inset overflow on family {family.number} page {page}")
    c.setFillColor(colors.HexColor("#FBFCFC"))
    c.setStrokeColor(RULE)
    c.roundRect(inset_x, inset_bottom, inset_width, inset_height, 5, fill=1, stroke=1)
    c.setFillColor(TEAL)
    c.setFont("FoolsSansBold", 7.6)
    c.drawString(inset_x + 10, inset_top - 14, "EXTRACT FROM SERVICE RECORD")
    inset_text_top = inset_top - 23
    inset_text_height = inset_height - 48
    if page in (4, 9):
        # This is a genuine embedded screenshot of independently authored text.
        img_w, img_h = 660, 155
        shot = Image.new("RGB", (img_w, img_h), "white")
        from PIL import ImageDraw, ImageFont
        drawer = ImageDraw.Draw(shot)
        drawer.text((12, 10), "Service record · reviewed", fill="#286c72")
        try:
            fnt = ImageFont.truetype(font_path("NotoSans-Regular.ttf"), 15)
        except OSError:
            fnt = ImageFont.load_default()
        line = " ".join(excerpt.split())
        line_parts: list[str] = []
        current = ""
        for token in line.split():
            candidate = f"{current} {token}".strip()
            if current and drawer.textlength(candidate, font=fnt) > img_w - 24:
                line_parts.append(current)
                current = token
            else:
                current = candidate
        if current:
            line_parts.append(current)
        for n, part in enumerate(line_parts[:5]):
            drawer.text((12, 35 + n * 21), part, fill="#263540", font=fnt)
        shot_path = source_dir / f"excerpt-{family.number:03d}-{page:02d}.png"
        shot.save(shot_path)
        draw_w = inset_width - 20
        draw_h = min(inset_text_height - 2, draw_w * img_h / img_w)
        c.drawImage(str(shot_path), inset_x + 10, inset_text_top - draw_h, width=draw_w, height=draw_h, preserveAspectRatio=True)
    else:
        inset_style = para_style("inset", size=7.5, leading=9.2)
        pdraw(c, excerpt, inset_x + 10, inset_text_top, inset_width - 20, inset_style, inset_text_height)
    comment_style = para_style("commentary", size=6.8, leading=8.2, color=MUTED)
    _, comment_h = pdraw(c, commentary, inset_x + 10, inset_bottom + 24, inset_width - 20, comment_style, 18)
    if inset_bottom + 24 - comment_h < inset_bottom + 4:
        raise ValueError(f"inset commentary overflow on family {family.number} page {page}")
    draw_footer(c, family, page)

    # Document-level overflow checks include all authored semantic regions.
    for b in section_boxes:
        x0, y0, x1, y1 = b["bbox"]
        if x0 < MARGIN - .1 or x1 > PAGE_W - MARGIN + .1 or y0 < 35 or y1 > PAGE_H - 35:
            raise ValueError(f"body geometry outside page: {b['id']} {b['bbox']}")

    table_md = "\n".join(["| " + " | ".join(r) + " |" for r in rows[:1]] + ["| " + " | ".join(["---"] * len(rows[0])) + " |"] + ["| " + " | ".join(r) + " |" for r in rows[1:]])
    ordered = [{"id": "heading", "role": "heading", "text": title, "bbox": refs["heading"]}, {"id": "subtitle", "role": "subtitle", "text": subtitle, "bbox": refs["subtitle"]}]
    ordered += [{"id": b["id"], "role": b["role"], "text": b["text"], "bbox": b["bbox"]} for b in section_boxes]
    if table_box:
        ordered.append({"id": f"p{page}.table", "role": "table", "text": table_md, "bbox": table_box})
    ordered.append({"id": f"p{page}.inset", "role": "document-inset", "text": excerpt, "bbox": [inset_x, inset_bottom, inset_x + inset_width, inset_top], "renderedAs": "embedded-screenshot" if page in (4, 9) else "selectable-text"})
    if chart_series:
        ordered.append({"id": f"p{page}.chart", "role": "chart", "text": chart_note, "bbox": [PAGE_W - MARGIN - 154, 253, PAGE_W - MARGIN, 410], "data": chart_series, "renderedAs": "vector-paths"})
    markdown = f"# {title}\n\n{subtitle}\n\n" + "\n\n".join(paras) + "\n\n" + (table_md if table_rows else "") + f"\n\n## Service record excerpt\n\n{excerpt}\n\n{commentary}"
    return {
        "pageId": f"family-{family.number:03d}-page-{page:02d}",
        "expectedMarkdown": markdown,
        "sections": ordered,
        "paragraphs": [{"id": b["id"], "text": b["text"], "bbox": b["bbox"]} for b in section_boxes],
        "tables": [{"id": f"p{page}.table", "rows": rows, "bbox": table_box}] if table_box else [],
        "formulas": formulas if table_box else [],
        "chartData": chart_series,
        "excludedText": [],
        "readingOrder": [s["id"] for s in ordered],
        "bbox": [0, 0, PAGE_W, PAGE_H],
        "contentHash": digest_json({"markdown": markdown, "sections": ordered}),
    }


def author_family(family: Family, source_dir: Path) -> tuple[Path, dict[str, Any]]:
    source_dir.mkdir(parents=True, exist_ok=True)
    source_pdf = source_dir / f"fools_gold_family_{family.number:03d}.pdf"
    c = __import__("reportlab.pdfgen.canvas", fromlist=["Canvas"]).Canvas(str(source_pdf), pagesize=letter, pageCompression=1)
    c.setTitle(f"{TEAMS[family.number % len(TEAMS)]} Technical Review")
    c.setAuthor("Technical Operations")
    c.setCreator("Field Reporting Office")
    c.setProducer(f"ReportLab {__import__('reportlab').Version}")
    c.setSubject("Operating observations and follow-up actions")
    labels: list[dict[str, Any]] = []
    for page in range(1, 11):
        labels.append(draw_page(c, family, page, source_dir))
        c.showPage()
    c.save()
    source = fitz.open(source_pdf)
    if len(source) != 10:
        raise RuntimeError(f"authored PDF has {len(source)} pages, expected 10")
    for ix, page in enumerate(source):
        if page.rect.width != PAGE_W or page.rect.height != PAGE_H:
            raise RuntimeError(f"family {family.number} page {ix + 1} is not letter size")
    source.close()
    return source_pdf, {"family": family.number, "layout": family.layout, "baseRegionRasterShare": family.raster_share, "pages": labels}


def family_for(number: int) -> Family:
    # Each 18-family block crosses three layouts with six independent section raster shares.
    slot = number % 18
    layout_ix, share_ix = divmod(slot, 6)
    return Family(number, LAYOUTS[layout_ix], RASTER_SHARES[share_ix])


def chosen_pages(seed: int, count: int) -> list[int]:
    return sorted(random.Random(seed).sample(range(1, 11), count)) if count else []


def render_page(doc: fitz.Document, page_index: int, dpi: int) -> Image.Image:
    pix = doc[page_index].get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def write_case_previews(pdf: Path, preview_dir: Path, case_id: str, hard_pages: list[int]) -> None:
    preview_dir.mkdir(parents=True, exist_ok=True)
    with fitz.open(pdf) as doc:
        targets = sorted({1, *hard_pages[:1]})
        for page_number in targets:
            img = render_page(doc, page_number - 1, 96)
            img.save(preview_dir / f"{case_id}-p{page_number:02d}.png", format="PNG", optimize=True)


def write_family_contact_sheet(pdf: Path, preview_dir: Path, family: Family) -> None:
    preview_dir.mkdir(parents=True, exist_ok=True)
    thumb_w, thumb_h, gap, label_h = 255, 330, 16, 22
    canvas = Image.new("RGB", (thumb_w * 5 + gap * 6, (thumb_h + label_h) * 2 + gap * 3), "#e9eeee")
    from PIL import ImageDraw
    d = ImageDraw.Draw(canvas)
    with fitz.open(pdf) as doc:
        for i, page in enumerate(doc):
            image = render_page(doc, i, 36)
            image.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            col, row = i % 5, i // 5
            x = gap + col * (thumb_w + gap) + (thumb_w - image.width) // 2
            y = gap + row * (thumb_h + label_h + gap)
            canvas.paste(image, (x, y))
            d.text((gap + col * (thumb_w + gap), y + thumb_h + 3), f"Family {family.number:03d} · Page {i + 1:02d}", fill="#35454e")
    canvas.save(preview_dir / f"family-{family.number:03d}-contact.png", optimize=True)


def degrade_page(image: Image.Image, seed: int, dpi: int) -> tuple[bytes, dict[str, Any]]:
    rng = random.Random(seed)
    image = image.resize((round(PAGE_W * dpi / 72), round(PAGE_H * dpi / 72)), Image.Resampling.LANCZOS)
    skew = rng.uniform(-0.42, 0.42)
    blur = rng.uniform(0.12, 0.32)
    contrast = rng.uniform(0.87, 0.96)
    quality = rng.randint(66, 79)
    progressive = bool(rng.getrandbits(1))
    image = image.rotate(skew, resample=Image.Resampling.BICUBIC, expand=False, fillcolor="white")
    image = image.filter(ImageFilter.GaussianBlur(blur))
    image = ImageEnhance.Contrast(image).enhance(contrast)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=quality, subsampling=2, optimize=False, progressive=progressive)
    return out.getvalue(), {"skewDegrees": round(skew, 3), "blurPx": round(blur, 3), "contrast": round(contrast, 3), "jpegQuality": quality, "progressiveJpeg": progressive}


def section_rasterize(page: fitz.Page, source_page: fitz.Page, share: float, seed: int) -> list[dict[str, Any]]:
    if share <= 0:
        return []
    # Rasterize a centered lower-page region; the declared share is the target area
    # fraction, while the page-specific rectangle is recorded for exact replay.
    rect = fitz.Rect(46, 70, PAGE_W - 46, 70 + (PAGE_H - 140) * share)
    pix = source_page.get_pixmap(matrix=fitz.Matrix(1.35, 1.35), clip=rect, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    payload = io.BytesIO()
    img.save(payload, format="PNG")
    page.draw_rect(rect, color=None, fill=(1, 1, 1), overlay=True)
    page.insert_image(rect, stream=payload.getvalue(), overlay=True)
    # Explicit transform records make each realized region auditable.
    return [{"factor": "section-raster", "bbox": [rect.x0, rect.y0, rect.x1, rect.y1], "targetShare": share, "dpi": 97.2, "seed": seed}]


def variant_case(source_pdf: Path, family: Family, labels: dict[str, Any], hard_count: int, out_root: Path) -> dict[str, Any]:
    family_seed = family.number * 100003 + 481
    hard_pages = chosen_pages(family_seed + hard_count * 701, hard_count)
    case_id = f"mixed-source-{family.number:04d}-hard-{hard_count:03d}"
    temp_pdf = out_root / "sources" / f".{case_id}.authored.pdf"
    final = out_root / "inputs" / "train" / f"{case_id}.pdf"
    final.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open(source_pdf) as src:
        out = fitz.open()
        page_records = []
        for i, src_page in enumerate(src):
            page = out.new_page(width=PAGE_W, height=PAGE_H)
            page.show_pdf_page(page.rect, src, i)
            transforms: list[dict[str, Any]] = []
            if family.raster_share > 0:
                transforms.extend(section_rasterize(page, src_page, family.raster_share, family_seed + i * 17))
            if i + 1 in hard_pages:
                dpi_rng = random.Random(family_seed + i * 23 + hard_count)
                dpi = dpi_rng.randint(85, 125)
                scan_bytes, scan_profile = degrade_page(render_page(src, i, dpi), family_seed + i * 31 + hard_count, dpi)
                page.clean_contents()
                page.draw_rect(page.rect, color=None, fill=(1, 1, 1), overlay=True)
                page.insert_image(page.rect, stream=scan_bytes, overlay=True)
                transforms.append({"factor": "hard-scan", "selected": True, "dpi": dpi, **scan_profile, "seed": family_seed + i * 31 + hard_count})
            else:
                transforms.append({"factor": "hard-scan", "selected": False})
            page_records.append({"pageId": labels["pages"][i]["pageId"], "pageNumber": i + 1, "hardScanned": i + 1 in hard_pages, "sectionRasterShare": family.raster_share, "transforms": transforms})
        out.set_metadata({"title": f"{TEAMS[family.number % len(TEAMS)]} Technical Review", "author": "Technical Operations", "creator": "Field Reporting Office", "producer": f"PyMuPDF {fitz.VersionBind}", "subject": "Operating observations and follow-up actions"})
        temp_pdf.parent.mkdir(parents=True, exist_ok=True)
        out.save(temp_pdf, garbage=4, deflate=True)
        out.close()
    # Exercise actual PDF storage variations without touching rendered content.
    ver = "1.4" if (family.number + hard_count) % 2 == 0 else "1.7"
    qpdf = shutil.which("qpdf")
    if qpdf:
        args = [qpdf, f"--force-version={ver}", "--object-streams=disable" if ver == "1.4" else "--object-streams=generate"]
        if (family.number + hard_count) % 3 == 0:
            args.append("--linearize")
        args += [str(temp_pdf), str(final)]
        subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        temp_pdf.unlink(missing_ok=True)
    else:
        shutil.move(temp_pdf, final)
        ver = "producer-default"
    write_case_previews(final, out_root / "previews" / "train", case_id, hard_pages)
    labels_path = out_root / "labels" / "train" / f"{case_id}.json"
    labels_path.parent.mkdir(parents=True, exist_ok=True)
    label_bundle = {"schema": "mixed-pdf-authored@v2", "family": family.number, "pages": labels["pages"]}
    label_bundle["labelHash"] = digest_json(label_bundle)
    labels_path.write_text(json.dumps(label_bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pdf_sha = digest_bytes(final.read_bytes())
    source_layout_hash = digest_json({"layout": family.layout, "share": family.raster_share, "pages": labels["pages"]})
    manifest = {
        "id": case_id, "family": family.number, "split": "train", "pdf": f"inputs/train/{final.name}",
        "labels": f"labels/train/{labels_path.name}", "sha256": pdf_sha, "labelHash": label_bundle["labelHash"],
        "sourceLayoutHash": source_layout_hash, "hardPercent": hard_count * 10, "hardPageCount": hard_count,
        "hardPageIds": [labels["pages"][p - 1]["pageId"] for p in hard_pages], "baseRegionRasterShare": family.raster_share,
        "pages": page_records, "layout": family.layout, "genre": GENRES[family.number % len(GENRES)],
        "producer": {"tool": "qpdf" if qpdf else "PyMuPDF", "version": subprocess.run([qpdf, "--version"], capture_output=True, text=True).stdout.strip() if qpdf else fitz.VersionBind, "authoredBy": f"ReportLab {__import__('reportlab').Version}", "variantBy": "PyMuPDF + qpdf" if qpdf else "PyMuPDF"},
        "fileProfile": {"pdfVersion": ver, "linearized": bool(qpdf and (family.number + hard_count) % 3 == 0), "xref": "qpdf-controlled", "objectStreams": ver != "1.4", "encrypted": False, "fontsEmbeddedInNativePages": True},
        "provenance": "Invented content generated from the source-free structural specification.",
    }
    manifest_path = out_root / "manifests" / f"{case_id}.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True, help="Corpus output directory")
    p.add_argument("--families", type=str, default="0-89", help="Family number(s): N, comma list, or inclusive range such as 0-17")
    p.add_argument("--workers", type=int, default=1, help="Parallel worker count (reserved; deterministic output is currently serial)")
    p.add_argument("--prototype", action="store_true", help="Restrict to the three layout prototypes at family numbers 0, 6, and 12")
    return p.parse_args()


def parse_families(value: str) -> list[int]:
    nums: set[int] = set()
    for part in value.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = (int(v) for v in part.split("-", 1))
            if hi < lo:
                raise ValueError("family range end must be >= start")
            nums.update(range(lo, hi + 1))
        else:
            nums.add(int(part))
    if not nums or min(nums) < 0 or max(nums) > 89:
        raise ValueError("family numbers must be between 0 and 89")
    return sorted(nums)


def build_family(number: int, root: Path) -> list[str]:
    register_fonts()
    family = family_for(number)
    sources = root / "sources"
    source_pdf, gold = author_family(family, sources)
    write_family_contact_sheet(source_pdf, root / "previews" / "train", family)
    (sources / f"fools_gold_family_{number:03d}.labels.json").write_text(json.dumps(gold, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    case_ids = []
    for hard_count in HARD_COUNTS:
        manifest = variant_case(source_pdf, family, gold, hard_count, root)
        case_ids.append(manifest["id"])
    print(f"family={number:03d} layout={family.layout} sectionRasterShare={family.raster_share:.1f} cases=6", flush=True)
    return case_ids


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.prototype:
        family_nums = [0, 6, 12]
    else:
        family_nums = parse_families(args.families)
    if not args.out.is_absolute():
        args.out = args.out.resolve()
    register_fonts()
    root = args.out
    sources = root / "sources"
    root.mkdir(parents=True, exist_ok=True)
    case_ids: list[str] = []
    workers_used = min(args.workers, len(family_nums))
    if workers_used == 1:
        for number in family_nums:
            case_ids.extend(build_family(number, root))
    else:
        with ProcessPoolExecutor(max_workers=workers_used) as executor:
            futures = {executor.submit(build_family, number, root): number for number in family_nums}
            completed: dict[int, list[str]] = {}
            for future in as_completed(futures):
                completed[futures[future]] = future.result()
            for number in family_nums:
                case_ids.extend(completed[number])
    summary = {"schema": "mixed-pdf-authored@v2", "families": family_nums, "splits": {"train": len(case_ids), "tune": 0, "heldout": 0}, "caseCount": len(case_ids), "workersRequested": args.workers, "workersUsed": workers_used, "prototype": args.prototype, "cases": case_ids}
    (root / "fools_gold_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"generated {len(case_ids)} training cases under {root}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
