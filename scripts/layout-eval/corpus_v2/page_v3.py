"""Layout corpus V3 helpers layered on the unchanged V2 ``Page`` contract.

Adds what the V3 coverage gaps need, without new manifest formats:

* script fonts (Hebrew, Devanagari, Naskh Arabic, CJK faces inside .ttc
  collections) plus a glyph-coverage guard: text whose characters are absent
  from the chosen font fails before any raster exists;
* rule-explicit tables (``none``/``booktabs``/``horizontal``/``grid``) with
  spanning multi-level headers, numeric alignment, authored empty cells and
  continuation metadata;
* bar, grouped-bar, line, scatter and pie charts whose axis, tick and legend
  text is native component text inside the chart region;
* native logos, coupons, barcodes and form fields;
* real-asset regions (photos, engravings, genuine handwriting) carrying their
  rights receipt and, for handwriting, an imported transcript with explicit
  non-native confidence.

Pages remain review candidates. Nothing here admits a benchmark.
"""
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps
from fontTools.ttLib import TTFont

try:
    from .page import Page, FONT_FILES, FONT_INDEX, save_json
except ImportError:
    from page import Page, FONT_FILES, FONT_INDEX, save_json

V3_ROOT = Path('/home/dan/data/docslurp-evals/layout-corpus-v3')
REAL_ASSETS = V3_ROOT / 'assets' / 'real'
GENERATED_ASSETS = V3_ROOT / 'assets' / 'generated'
NOTO = '/usr/share/fonts/noto/'
CJK = '/usr/share/fonts/noto-cjk/'
GS = '/usr/share/fonts/gsfonts/'

EXTRA_FONTS = {
    'hebrew': (NOTO + 'NotoSansHebrew-Regular.ttf', 0),
    'hebrew-bold': (NOTO + 'NotoSansHebrew-Bold.ttf', 0),
    'hebrew-serif': (NOTO + 'NotoSerifHebrew-Regular.ttf', 0),
    'hebrew-serif-bold': (NOTO + 'NotoSerifHebrew-Bold.ttf', 0),
    'deva': (NOTO + 'NotoSansDevanagari-Regular.ttf', 0),
    'deva-bold': (NOTO + 'NotoSansDevanagari-Bold.ttf', 0),
    'deva-serif': (NOTO + 'NotoSerifDevanagari-Regular.ttf', 0),
    'naskh': (NOTO + 'NotoNaskhArabic-Regular.ttf', 0),
    'naskh-bold': (NOTO + 'NotoNaskhArabic-Bold.ttf', 0),
    'cjk-jp': (CJK + 'NotoSansCJK-Regular.ttc', 0),
    'cjk-jp-bold': (CJK + 'NotoSansCJK-Bold.ttc', 0),
    'cjk-kr': (CJK + 'NotoSansCJK-Regular.ttc', 1),
    'cjk-kr-bold': (CJK + 'NotoSansCJK-Bold.ttc', 1),
    'cjk-sc': (CJK + 'NotoSansCJK-Regular.ttc', 2),
    'cjk-sc-bold': (CJK + 'NotoSansCJK-Bold.ttc', 2),
    'cjk-sc-serif': (CJK + 'NotoSerifCJK-Regular.ttc', 2),
    'noto-serif': (NOTO + 'NotoSerif-Regular.ttf', 0),
    'noto-serif-bold': (NOTO + 'NotoSerif-Bold.ttf', 0),
    'noto-serif-italic': (NOTO + 'NotoSerif-Italic.ttf', 0),
    'noto-sans': (NOTO + 'NotoSans-Regular.ttf', 0),
    'noto-sans-bold': (NOTO + 'NotoSans-Bold.ttf', 0),
    'century': (GS + 'C059-Roman.otf', 0),
    'century-bold': (GS + 'C059-Bold.otf', 0),
    'century-italic': (GS + 'C059-Italic.otf', 0),
    'palatino': (GS + 'P052-Roman.otf', 0),
    'palatino-bold': (GS + 'P052-Bold.otf', 0),
    'palatino-italic': (GS + 'P052-Italic.otf', 0),
    'gothic': (GS + 'URWGothic-Book.otf', 0),
    'gothic-bold': (GS + 'URWGothic-Demi.otf', 0),
    'sans-italic': (GS + 'NimbusSans-Italic.otf', 0),
    'mono-bold': (GS + 'NimbusMonoPS-Bold.otf', 0),
}
for _name, (_path, _index) in EXTRA_FONTS.items():
    FONT_FILES[_name] = _path
    if _index:
        FONT_INDEX[_name] = _index

_CMAPS = {}


def missing_glyphs(face, text):
    """Characters of ``text`` the face cannot map (whitespace and joiners excluded)."""
    key = (FONT_FILES[face], FONT_INDEX.get(face, 0))
    if key not in _CMAPS:
        _CMAPS[key] = set(TTFont(key[0], fontNumber=key[1], lazy=True).getBestCmap())
    ignorable = {0x200c, 0x200d, 0x200e, 0x200f, 0xfe0f}
    return sorted({c for c in text if not c.isspace() and ord(c) not in ignorable and ord(c) not in _CMAPS[key]})


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    return sha_bytes(Path(path).read_bytes())


def load_receipt(asset_id):
    """Real assets must ship a receipt with license evidence and matching bytes."""
    receipt_path = REAL_ASSETS / f'{asset_id}.receipt.json'
    receipt = json.loads(receipt_path.read_text())
    for key in ('license', 'license_evidence', 'sha256', 'download_url', 'archive_item_id'):
        if not receipt.get(key):
            raise ValueError(f'Real asset {asset_id} receipt lacks {key}')
    files = sorted(p for p in REAL_ASSETS.glob(asset_id + '.*') if p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp') and not p.name.endswith('.work.jpg'))
    original = next((p for p in files if sha_file(p) == receipt['sha256']), None)
    if original is None:
        raise ValueError(f'Real asset {asset_id}: no file matches receipt sha256')
    work = REAL_ASSETS / f'{asset_id}.work.jpg'
    if work.exists():
        if receipt.get('work_sha256') != sha_file(work):
            raise ValueError(f'Real asset {asset_id}: work copy hash mismatch')
        usable = work
    else:
        usable = original
    return receipt, receipt_path, original, usable


class PageV3(Page):
    """Page with V3 helpers. ``cluster`` is the original-composition source group."""

    def __init__(self, id, width, height, cluster, features, brief, paper='#fffdf7', document_id=None, page_number=1):
        super().__init__(id, width, height, paper=paper, document_id=document_id, page_number=page_number)
        self.source['schema'] = 'layout-editorial-pilot-source-v2'
        self.source['corpus'] = {'name': 'layout-corpus-v3', 'source_cluster': cluster,
                                 'declared_features': sorted(features), 'brief': brief,
                                 'feature_declaration_status': 'author-declared; verify by visual review before counting'}
        self.source['limitations'] = ['Authored synthetic composition (V3). Review candidate / silver only; not human-adjudicated gold.']

    # ---- text ---------------------------------------------------------------
    def text(self, text, x, y, width, size=20, face='serif', color='#242522', leading=None, label='paragraph', tracking=0, direction=None, language=None, **attrs):
        missing = missing_glyphs(face, text)
        if missing:
            raise ValueError(f'Font {face} lacks glyphs {missing!r} for: {text[:50]}')
        return super().text(text, x, y, width, size, face, color, leading, label, tracking, direction, language, **attrs)

    def text_width(self, text, size, face, direction=None, language=None):
        layout = {k: v for k, v in {'direction': direction, 'language': language}.items() if v is not None}
        return self.font(face, size).getlength(text, **layout)

    def line_text(self, text, x, y, size, face, color='#242522', align='left', label=None, direction=None, language=None, **attrs):
        """Single unwrapped line; ``x`` is the left, right or centre anchor."""
        w = self.text_width(text, size, face, direction, language)
        left = {'left': x, 'right': x - w, 'center': x - w / 2}[align]
        return self.text(text, left, y, w + 2, size, face, color, label=label, direction=direction, language=language, **attrs)

    # ---- graphics -----------------------------------------------------------
    def dashed_rect(self, box, color='#222222', dash=10, gap=6, width=2):
        x0, y0, x1, y1 = box
        for a, b, horizontal, fixed in ((x0, x1, True, y0), (x0, x1, True, y1), (y0, y1, False, x0), (y0, y1, False, x1)):
            pos = a
            while pos < b:
                end = min(pos + dash, b)
                self.line([pos, fixed, end, fixed] if horizontal else [fixed, pos, fixed, end], color, width)
                pos = end + gap

    def barcode(self, box, digits, ink='#111111', caption_face='mono', caption_size=14):
        """Deterministic bar pattern (not a decodable symbology) with native digits."""
        x0, y0, x1, y1 = box
        bits = ''.join(format(int(hashlib.sha256((digits + str(i)).encode()).hexdigest()[:2], 16), '08b') for i in range(12))
        bar_bottom = y1 - caption_size - 6
        unit = (x1 - x0) / len(bits)
        for i, bit in enumerate(bits):
            if bit == '1':
                self.rectangle([x0 + i * unit, y0, x0 + (i + 1) * unit, bar_bottom], ink)
        self.line_text(digits, (x0 + x1) / 2, bar_bottom + 3, caption_size, caption_face, ink, align='center')
        return self.region('figure', [x0, y0, x1, y1], None, kind='barcode-pattern', decodable=False,
                           note='Authored bar pattern; digits are native text; not a valid symbology.')

    def checkbox(self, x, y, size=18, checked=False, ink='#222222'):
        self.rectangle([x, y, x + size, y + size], None, outline=ink, width=2)
        if checked:
            self.line([x + 3, y + size * .55, x + size * .42, y + size - 3, x + size - 2, y + 2], ink, 3)

    def field(self, x, y, width, label_text, value=None, size=17, face='sans', value_face='mono', ink='#222222', value_ink='#1d3a8a', line_color='#444444'):
        """Form field: native caption, underline, optional typed value."""
        self.text(label_text, x, y, width, size - 3, face, '#555555', label=None)
        line_y = y + size * 2.4
        self.line([x, line_y, x + width, line_y], line_color, 1)
        if value:
            self.text(value, x + 4, line_y - size - 6, width - 8, size, value_face, value_ink, label=None)
        return line_y

    def image_component(self, path, box, background=None):
        """Paste an asset inside a composite without creating its own region."""
        path = Path(path)
        self.source['commands'].append({'op': 'image', 'path': str(path.resolve()), 'bbox': list(box)})
        return {'path': str(path.resolve()), 'sha256': sha_file(path), 'bbox': list(box)}

    # ---- real assets ------------------------------------------------------------
    def real_asset(self, asset_id, box, label, crop=None, transcript=None, transcript_confidence=None, **attrs):
        """Place a receipt-backed real image. ``crop`` is in usable-image pixels."""
        receipt, receipt_path, original, usable = load_receipt(asset_id)
        path = usable
        crop_record = None
        if crop:
            with Image.open(usable) as im:
                cropped = im.convert('RGB').crop(tuple(round(v) for v in crop))
            GENERATED_ASSETS.mkdir(parents=True, exist_ok=True)
            tag = sha_bytes(json.dumps([asset_id, list(crop)]).encode())[:12]
            path = GENERATED_ASSETS / f'{asset_id}-crop-{tag}.png'
            if not path.exists():
                cropped.save(path)
            crop_record = {'crop_box_in_usable_pixels': list(crop), 'usable_sha256': sha_file(usable), 'crop_sha256': sha_file(path)}
        with Image.open(path) as im:
            w, h = im.size
        bw, bh = box[2] - box[0], box[3] - box[1]
        if abs(w / h - bw / bh) / (w / h) > 0.03:
            attrs['fit_policy'] = 'centre-crop to frame aspect (ImageOps.fit); placed extent equals frame'
        asset = {'kind': 'real-rights-cleared-asset', 'asset_id': asset_id, 'license': receipt['license'],
                 'archive_item_id': receipt['archive_item_id'], 'source_page_url': receipt.get('source_page_url'),
                 'download_url': receipt['download_url'], 'original_sha256': receipt['sha256'],
                 'receipt_path': str(receipt_path), 'receipt_sha256': sha_file(receipt_path), 'crop': crop_record}
        self.image(path, box, label=label, asset=asset, extent_policy='placed-asset-frame-not-tight-ink', **attrs)
        region = self.source['regions'][-1]
        if transcript is not None:
            region['text'] = transcript
            region['attributes']['transcript_provenance'] = transcript_confidence['provenance_note']
            region['attributes']['confidence_overrides'] = {'textTranscription': transcript_confidence['axis']}
        return region

    # ---- tables -----------------------------------------------------------------
    def table_v3(self, box, header_rows, body_rows, widths, rules='none', align=None, row_height=30, header_height=None,
                 face='sans', size=16, header_face=None, ink='#1f2421', rule_color='#3a3a3a', pad=6,
                 continuation_id=None, row_offset=0, row_roles=None, indent=None, header_fill=None, zebra=None):
        """Explicit-rule table. ``header_rows`` cells are ``(text, colspan)``; body cells are strings.

        rules: ``none`` (whitespace only: no lines, no fills), ``booktabs`` (top/mid/bottom rules),
        ``horizontal`` (rule under every row), ``grid`` (all cell borders).
        """
        if rules not in ('none', 'booktabs', 'horizontal', 'grid'):
            raise ValueError(rules)
        if rules == 'none' and (header_fill or zebra):
            raise ValueError('A borderless table may not use fills')
        x0, y0, x1, y1 = box
        cols = len(widths)
        if abs(sum(widths) - 1) > 1e-6:
            raise ValueError('Invalid widths')
        align = align or ['left'] + ['right'] * (cols - 1)
        header_face = header_face or (face + '-bold' if face + '-bold' in FONT_FILES else face)
        header_height = header_height or row_height
        edges = [x0]
        for w in widths:
            edges.append(edges[-1] + (x1 - x0) * w)
        cells = []
        y = y0
        rule_commands = []

        def put(text, cx0, cx1, cy, height, alignment, font_face, level_indent=0):
            if text == '':
                return
            text_w = self.text_width(text, size, font_face)
            inner = cx1 - cx0 - 2 * pad - level_indent
            if text_w > inner:
                # wrap within the cell; still native component text
                self.text(text, cx0 + pad + level_indent, cy + (height - size * 1.2 * 2) / 2 + 1, inner, size, font_face, ink, leading=size * 1.2, label=None)
                return
            if alignment == 'right':
                left = cx1 - pad - text_w
            elif alignment == 'center':
                left = (cx0 + cx1 - text_w) / 2
            else:
                left = cx0 + pad + level_indent
            self.text(text, left, cy + (height - size) / 2 - 1, text_w + 2, size, font_face, ink, label=None)

        for level, header in enumerate(header_rows):
            if header_fill:
                self.rectangle([x0, y, x1, y + header_height], header_fill)
            col = 0
            for text, span in header:
                cb = [edges[col], y, edges[col + span], y + header_height]
                alignment = 'center' if span > 1 else align[col]
                put(text, cb[0], cb[2], y, header_height, alignment, header_face)
                cells.append({'row': level, 'column': col, 'row_span': 1, 'col_span': span, 'logical_row': 0, 'header_level': level,
                              'text': text, 'bbox': cb, 'polygon': [[cb[0], cb[1]], [cb[2], cb[1]], [cb[2], cb[3]], [cb[0], cb[3]]],
                              'is_header': True, 'empty': text == ''})
                if span > 1 and rules == 'booktabs' and text:
                    rule_commands.append([cb[0] + 6, cb[3] - 2, cb[2] - 6, cb[3] - 2])
                col += span
            if col != cols:
                raise ValueError(f'Header row {level} spans {col} of {cols} columns')
            y += header_height
            if rules in ('horizontal', 'grid'):
                self.line([x0, y, x1, y], rule_color, 1)
        header_bottom = y
        roles = row_roles or ['data'] * len(body_rows)
        for index, row in enumerate(body_rows):
            if len(row) != cols:
                raise ValueError('Missing authored table cells')
            ri = len(header_rows) + index
            if zebra and index % 2 == 1:
                self.rectangle([x0, y, x1, y + row_height], zebra)
            role = roles[index]
            for ci, value in enumerate(row):
                cb = [edges[ci], y, edges[ci + 1], y + row_height]
                level_indent = (indent[index] if indent else 0) if ci == 0 else 0
                cell_face = header_face if role in ('total', 'subtotal', 'carried-forward', 'brought-forward', 'section') else face
                put(value, cb[0], cb[2], y, row_height, align[ci], cell_face, level_indent)
                cells.append({'row': ri, 'column': ci, 'row_span': 1, 'col_span': 1, 'logical_row': row_offset + index + 1,
                              'text': value, 'bbox': cb, 'polygon': [[cb[0], cb[1]], [cb[2], cb[1]], [cb[2], cb[3]], [cb[0], cb[3]]],
                              'is_header': False, 'row_role': role, 'empty': value == ''})
            y += row_height
            if rules in ('horizontal', 'grid'):
                self.line([x0, y, x1, y], rule_color, 1)
        if y > y1 + 0.01:
            raise ValueError(f'Authored table overflow {y} > {y1}')
        if rules == 'booktabs':
            self.line([x0, y0, x1, y0], rule_color, 2)
            self.line([x0, header_bottom, x1, header_bottom], rule_color, 1)
            self.line([x0, y, x1, y], rule_color, 2)
            for r in rule_commands:
                self.line(r, rule_color, 1)
        if rules == 'grid':
            self.line([x0, y0, x1, y0], rule_color, 1)
            for e in edges:
                self.line([e, y0, e, y], rule_color, 1)
        tag = {'none': 'borderless', 'grid': 'bordered'}.get(rules, 'mixed-rules')
        return self.region('table', [x0, y0, x1, y], None, cells=cells, columns=cols, rows=len(header_rows) + len(body_rows),
                           header_rows=len(header_rows), border=rules == 'grid', rule_style=rules, rules_condition_tag=tag,
                           fills={'header': header_fill, 'zebra': zebra}, continuation_id=continuation_id,
                           header_repeated=bool(continuation_id) and row_offset > 0, logical_row_offset=row_offset,
                           multi_level_header=len(header_rows) > 1 or any(span > 1 for h in header_rows for _, span in h))

    # ---- charts -------------------------------------------------------------------
    def chart_v3(self, box, kind, categories, series, title=None, y_label=None, x_label=None, colors=None, panel='#f4f2ea',
                 ink='#2a2d2b', grid='#cfccc0', y_max=None, ticks=5, legend=True, unit='', face='sans', size=14, value_labels=False):
        """kind: bar, grouped-bar, stacked-bar, hbar, line, scatter, pie. ``series`` maps name -> values.

        For scatter, values are (x, y) pairs and ``categories`` gives (x_min, x_max).
        """
        colors = colors or ['#2f6f8f', '#d9822b', '#6a994e', '#9b5de5', '#c44536']
        x0, y0, x1, y1 = box
        self.rectangle(box, panel)
        top = y0 + 14
        if title:
            top = self.text(title, x0 + 16, y0 + 12, x1 - x0 - 32, size + 3, face + '-bold' if face + '-bold' in FONT_FILES else face, ink, label=None) + 8
        names = list(series)
        legend_h = 0
        if legend and len(names) > 1 or kind == 'pie':
            legend_h = size + 16
        bottom = y1 - 16 - legend_h
        data_record = {'kind': kind, 'categories': categories, 'series': series, 'title': title, 'y_label': y_label, 'x_label': x_label, 'unit': unit}
        if kind == 'pie':
            values = series[names[0]]
            total = sum(values)
            diameter = min(bottom - top, (x1 - x0) * .55)
            cx, cy = x0 + 24 + diameter / 2, top + (bottom - top) / 2
            GENERATED_ASSETS.mkdir(parents=True, exist_ok=True)
            scale = 4
            im = Image.new('RGB', (round(diameter * scale), round(diameter * scale)), panel)
            d = ImageDraw.Draw(im)
            start = -90
            for i, v in enumerate(values):
                extent = 360 * v / total
                d.pieslice([0, 0, im.width - 1, im.height - 1], start, start + extent, fill=colors[i % len(colors)], outline=panel, width=scale * 2)
                start += extent
            im = im.resize((round(diameter), round(diameter)), Image.Resampling.LANCZOS)
            path = GENERATED_ASSETS / f'pie-{sha_bytes(json.dumps([values, colors, panel, round(diameter)]).encode())[:16]}.png'
            im.save(path)
            component = self.image_component(path, [cx - diameter / 2, cy - diameter / 2, cx - diameter / 2 + round(diameter), cy - diameter / 2 + round(diameter)])
            data_record['graphic_asset'] = {**component, 'kind': 'authored-pie-raster-PIL', 'rights': 'authored for this corpus'}
            lx = cx + diameter / 2 + 30
            ly = top + 6
            for i, (cat, v) in enumerate(zip(categories, values)):
                self.rectangle([lx, ly + 3, lx + 14, ly + 17], colors[i % len(colors)])
                self.text(f'{cat}  {v}{unit}', lx + 22, ly, x1 - lx - 30, size, face, ink, label=None)
                ly += size + 12
                if ly > y1 - 10:
                    raise ValueError('Pie legend overflow')
            return self.region('chart', box, None, chart_kind=kind, chart_data=data_record, axis_text=False, legend=True)
        if kind == 'hbar':
            values = series[names[0]]
            label_w = max(self.text_width(c, size, face) for c in categories) + 20
            left, right = x0 + 16 + label_w, x1 - 60
            rh = (bottom - top) / len(values)
            vmax = y_max or max(values)
            for i, (cat, v) in enumerate(zip(categories, values)):
                yy = top + i * rh
                self.text(cat, x0 + 16, yy + (rh - size) / 2 - 1, label_w, size, face, ink, label=None)
                self.rectangle([left, yy + rh * .18, left + (right - left) * v / vmax, yy + rh * .82], colors[0])
                self.line_text(f'{v}{unit}', left + (right - left) * v / vmax + 6, yy + (rh - size) / 2 - 1, size, face, ink)
            self.line([left, top, left, bottom], ink, 1)
            return self.region('chart', box, None, chart_kind=kind, chart_data=data_record, axis_text=True, legend=False)
        # cartesian charts
        label_space = 0
        if y_label:
            label_space = size + 10
        tick_w = 0
        if kind == 'scatter':
            values_y = [p[1] for s in series.values() for p in s]
        elif kind == 'stacked-bar':
            values_y = [sum(vals) for vals in zip(*series.values())]
        else:
            values_y = [v for s in series.values() for v in s]
        vmax = y_max or nice_max(max(values_y))
        tick_values = [vmax * i / ticks for i in range(ticks + 1)]
        tick_text = [fmt_tick(v) for v in tick_values]
        tick_w = max(self.text_width(t, size - 1, face) for t in tick_text) + 10
        left = x0 + 16 + label_space + tick_w
        right = x1 - 20
        x_axis_h = size + 12 + (size + 8 if x_label else 0)
        plot_bottom = bottom - x_axis_h
        if y_label:
            self.text(y_label, x0 + 14, top - 2, max(self.text_width(y_label, size - 1, face) + 4, 40), size - 1, face, ink, label=None)
            top += size + 8
        for v, t in zip(tick_values, tick_text):
            yy = plot_bottom - (plot_bottom - top) * v / vmax
            self.line([left, yy, right, yy], grid, 1)
            self.line_text(t, left - 6, yy - size / 2 - 1, size - 1, face, ink, align='right')
        self.line([left, top, left, plot_bottom], ink, 1)
        self.line([left, plot_bottom, right, plot_bottom], ink, 1)
        n = len(categories)
        if kind in ('bar', 'grouped-bar', 'stacked-bar'):
            slot = (right - left) / n
            group = len(names) if kind == 'grouped-bar' else 1
            bar_w = slot * .7 / group
            for i, cat in enumerate(categories):
                sx = left + i * slot + slot * .15
                base = plot_bottom
                for si, name in enumerate(names):
                    v = series[name][i]
                    hgt = (plot_bottom - top) * v / vmax
                    if kind == 'stacked-bar':
                        self.rectangle([sx, base - hgt, sx + bar_w, base], colors[si % len(colors)])
                        base -= hgt
                    else:
                        bx = sx + si * bar_w
                        self.rectangle([bx, plot_bottom - hgt, bx + bar_w - 2, plot_bottom], colors[si % len(colors)])
                        if value_labels:
                            self.line_text(fmt_tick(v), bx + bar_w / 2, plot_bottom - hgt - size - 4, size - 2, face, ink, align='center')
                self.line_text(cat, left + i * slot + slot / 2, plot_bottom + 6, size - 1, face, ink, align='center')
        elif kind == 'line':
            for si, name in enumerate(names):
                pts = []
                for i, v in enumerate(series[name]):
                    xx = left + (right - left) * (i + .5) / n
                    yy = plot_bottom - (plot_bottom - top) * v / vmax
                    pts.extend([xx, yy])
                    self.ellipse([xx - 4, yy - 4, xx + 4, yy + 4], colors[si % len(colors)])
                self.line(pts, colors[si % len(colors)], 3)
            step = max(1, math.ceil(n / 12))
            for i, cat in enumerate(categories):
                if i % step == 0:
                    self.line_text(cat, left + (right - left) * (i + .5) / n, plot_bottom + 6, size - 1, face, ink, align='center')
        elif kind == 'scatter':
            xmin, xmax = categories
            for si, name in enumerate(names):
                for px, py in series[name]:
                    xx = left + (right - left) * (px - xmin) / (xmax - xmin)
                    yy = plot_bottom - (plot_bottom - top) * py / vmax
                    self.ellipse([xx - 4, yy - 4, xx + 4, yy + 4], colors[si % len(colors)])
            for i in range(6):
                v = xmin + (xmax - xmin) * i / 5
                xx = left + (right - left) * i / 5
                self.line([xx, plot_bottom, xx, plot_bottom + 4], ink, 1)
                self.line_text(fmt_tick(v), xx, plot_bottom + 6, size - 1, face, ink, align='center')
        else:
            raise ValueError(kind)
        if x_label:
            self.line_text(x_label, (left + right) / 2, plot_bottom + size + 12, size - 1, face, ink, align='center')
        if legend_h:
            lx = left
            ly = y1 - 14 - size
            for si, name in enumerate(names):
                name_w = self.text_width(name, size, face)
                if lx + 22 + name_w > x1 - 8:
                    raise ValueError('Legend overflow')
                self.rectangle([lx, ly + 2, lx + 14, ly + 16], colors[si % len(colors)])
                self.text(name, lx + 22, ly, name_w + 2, size, face, ink, label=None)
                lx += 22 + name_w + 26
        return self.region('chart', box, None, chart_kind=kind, chart_data=data_record, axis_text=True, legend=bool(legend_h))

    # ---- math ---------------------------------------------------------------------
    def equation(self, latex, x, y, width, size=22, display=True, group=None, component=False):
        """Reuse the V2 mathtext renderer, but keep V3 assets and receipts under the V3 root."""
        try:
            from . import scientific
        except ImportError:
            import scientific
        previous = scientific.REFERENCE_ROOT
        scientific.REFERENCE_ROOT = V3_ROOT / 'assets'
        try:
            return scientific.equation(self, latex, x, y, width, size=size, display=display, group=group, component=component)
        finally:
            scientific.REFERENCE_ROOT = previous


def nice_max(v):
    exponent = 10 ** math.floor(math.log10(v))
    for m in (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if m * exponent >= v:
            return m * exponent
    return 10 * exponent


def fmt_tick(v):
    if abs(v - round(v)) < 1e-9:
        return f'{int(round(v)):,}'
    return f'{v:,.1f}'
