#!/usr/bin/env python3
"""Clean-room mixed PDF corpus builder, gated before full expansion.

The persisted authoring model is the source of labels. No customer files or model
services are accessed. Full corpus generation requires a separate audit and build.
"""
import argparse
import copy
from concurrent.futures import ProcessPoolExecutor
import html
import math
import os
import tempfile
import hashlib
import io
import json
import random
import re
import subprocess
from pathlib import Path

import fitz
import reportlab
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageStat
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

W, H = 612, 792
FAMILIES = (0, 6, 12)
SANS = '/usr/share/fonts/noto/NotoSans-Regular.ttf'
SERIF = '/usr/share/fonts/noto/NotoSerif-Regular.ttf'
pdfmetrics.registerFont(TTFont('NotoSans', SANS))
pdfmetrics.registerFont(TTFont('NotoSerif', SERIF))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(obj, ensure_ascii=False, indent=2).encode() + b'\n')


def split_for(family):
    if not 0 <= family < 90:
        raise ValueError('family outside 0..89')
    return 'train' if family < 54 else 'tune' if family < 72 else 'heldout'


def wrapped(text, font, size, width):
    lines, line = [], ''
    for word in text.split():
        candidate = (line + ' ' + word).strip()
        if line and pdfmetrics.stringWidth(candidate, font, size) > width:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def world_for(family):
    rng = random.Random(61008 + family)
    topics = ['Cooling circuit', 'Inspection interval', 'Material handling', 'Pressure control', 'Energy recovery', 'Instrument calibration', 'Valve maintenance', 'Filter loading', 'Thermal storage', 'Flow measurement', 'Seal inspection', 'Supply routing', 'Sensor drift', 'Pump capacity', 'Ventilation balance', 'Bearing wear', 'Batch scheduling', 'Water recovery']
    return {'family': f'mixed-source-{family:04d}', 'topic': topics[(family * 7) % len(topics)],
            'target': rng.randint(42, 67), 'baseline': rng.randint(18, 29),
            'genre': ['operational report', 'equipment guidance', 'engineering brief', 'inspection record', 'procurement summary', 'research discussion'][(family // 3) % 6], 'units': 'minutes', 'revision': f'{1 + family % 4}.{family % 9}'}


def author(family):
    world = world_for(family)
    layout = (family // 6) % 3
    pages = []
    for i in range(10):
        n = i + 1
        topic = world['topic'].lower()
        title = f'{world["topic"]}: {world["genre"]}'
        subtitle = f'{world["genre"].capitalize()} {n} | Revision {world["revision"]} | Technical operations'
        paras = [
            f'The review considers the {topic} under a sequence of controlled operating conditions. The team recorded the starting state, confirmed the measurement interval, and compared each observation with the agreed acceptance range. The preferred setting balances reliable response with the time needed to inspect the equipment. Readings were taken after the system reached a stable condition, so the comparison does not treat the initial transient as normal operation. The observations support a measured adjustment rather than a replacement of the complete assembly.',
            f'The proposed interval is {world["target"]} minutes, while the earlier baseline was {world["baseline"]} minutes. This difference reflects the practical time required to complete the checks without interrupting the surrounding process. Operators should record exceptions when a reading falls outside the expected range and repeat the measurement before changing the setting. A single unusual observation is not sufficient evidence of a persistent fault.',
            'Implementation depends on keeping the inspection sequence consistent across shifts. The record should identify the condition before adjustment, the action taken, and the result after the system settles. If access to a measurement point is restricted, the unresolved item remains open until the next available inspection. This approach preserves a clear basis for comparing later observations and helps distinguish a gradual drift from a short-lived disturbance.'
        ]
        # Alternate substantive phrasing across families and pages while preserving
        # the family world and the reading budgets.
        subjects = [
            ('Service crews compared the accessible components before selecting a maintenance interval.', 'The record distinguishes gradual wear from a temporary change in the surrounding load.'),
            ('The inspection sequence begins with a stable reading and a check of the instrument connection.', 'A second observation helps determine whether the deviation persists after the equipment settles.'),
            ('The engineering review weighs response time against the effort needed to verify each adjustment.', 'The proposed sequence keeps a repeatable record of the conditions around each measurement.'),
            ('Purchasing decisions depend on the remaining service capacity and the availability of compatible parts.', 'The assessment retains the existing assembly until a measured change justifies replacement.'),
            ('A controlled comparison was used to examine changes over successive operating periods.', 'The observations are limited to the recorded conditions and should not be generalized without another review.'),
            ('The guidance assigns a separate verification step after every adjustment to the operating setting.', 'Unresolved readings remain visible in the log until the next inspection can be completed.')
        ]
        a, b = subjects[(family // 3 + i) % len(subjects)]
        paras[0] = a + ' ' + paras[0].split('. ', 1)[1]
        paras[2] = b + ' ' + paras[2].split('. ', 1)[1]
        substitutions = [
            ('The team recorded the starting state, confirmed the measurement interval, and compared each observation with the agreed acceptance range.', 'The team logged the starting condition, verified the timing, and compared each reading with the accepted range.'),
            ('The preferred setting balances reliable response with the time needed to inspect the equipment.', 'The selected setting accounts for both equipment response and the effort needed to inspect it.'),
            ('This difference reflects the practical time required to complete the checks without interrupting the surrounding process.', 'The revised interval allows staff to complete the checks while the surrounding process continues.'),
            ('Operators should record exceptions when a reading falls outside the expected range and repeat the measurement before changing the setting.', 'When a reading lies outside the expected range, staff repeat the measurement and record the exception before making an adjustment.'),
            ('The record should identify the condition before adjustment, the action taken, and the result after the system settles.', 'Each entry identifies the initial condition, the action, and the result after the equipment settles.'),
            ('This approach preserves a clear basis for comparing later observations and helps distinguish a gradual drift from a short-lived disturbance.', 'These records allow later comparisons and help separate gradual drift from a short disturbance.')
        ]
        # Rotate independently authored wording by genre and page, retaining shared facts.
        for j, (old, new) in enumerate(substitutions):
            if (family // 3 + i + j) % 3:
                paras = [paragraph.replace(old, new) for paragraph in paras]
        inset_variants = [
            ('Inspection record',
             'Before changing the setting, confirm the instrument reading and record the condition of the accessible connections. Repeat the check after the equipment has reached a steady state. Record the measured result beside the original value and flag any unresolved difference for the next inspection.',
             'The retained extract records the control used during the review. Its wording separates the inspection decision from the later verification, so a reviewer can trace the action without assuming that a single reading explains every operating condition.'),
            ('Service instruction',
             'Isolate the accessible section before checking its fasteners and surfaces. Restore the normal operating position after the inspection, then compare the instrument reading with the value recorded before access. List any part that cannot be reached so the next service interval includes a separate follow-up.',
             'The instruction connects the access sequence to a repeat measurement. It leaves unresolved components on the service list instead of treating incomplete access as evidence that all components are in acceptable condition.'),
            ('Control log',
             'Record the starting reading at the designated point and allow the equipment to settle before making an adjustment. Enter the revised setting and the later reading in separate fields. If the second reading is unstable, leave the result open and repeat the check during the next operating period.',
             'The log keeps the original measurement separate from the result after adjustment. That distinction makes the sequence auditable and prevents an unstable reading from being counted as a completed verification.'),
            ('Acceptance extract',
             'Check the accessible connections and verify the measurement instrument before accepting the recorded condition. An item remains open when the result cannot be repeated or the measurement point is unavailable. Close the item only after a later check confirms a stable reading and the action has been recorded.',
             'The acceptance wording makes repeatability a condition of closure. The surrounding review uses that requirement to distinguish a documented result from a provisional reading that still requires follow-up.'),
            ('Supply condition',
             'Confirm compatibility with the installed connection and retain the recorded dimensions with the purchase request. A replacement should be requested only after inspection identifies a need that cannot be resolved by adjustment. Record the availability of the part and keep unresolved compatibility questions open until they are checked.',
             'The purchasing condition ties a request to a documented need and a compatibility check. It avoids treating a scheduled inspection as an automatic instruction to replace an otherwise serviceable assembly.'),
            ('Review protocol',
             'Use the same measurement point for each comparison and record the operating condition at the start of the check. Repeat an unexpected result before drawing a conclusion. Keep the initial and repeated values together so a later reviewer can evaluate whether the change persisted through the inspection interval.',
             'The protocol preserves the context around each measurement and requires a repeat for an unexpected result. The comparison therefore remains limited to the conditions actually recorded during the review.')
        ]
        inset_title, inset, commentary = inset_variants[(family//3+i) % len(inset_variants)]
        rows = [['Check', 'Before', 'After', 'Status'], ['Interval', str(world['baseline']), str(world['target']), 'Revised'], ['Reading', '48.2', '47.9', 'Stable'], ['Review', 'Open', 'Logged', 'Complete'], ['Follow-up', 'Pending', 'Scheduled', 'Tracked']]
        caption = 'Table 1. Review checkpoints and recorded outcomes.'
        footer = f'Operations review  |  {n}'
        # Positions are authored in top-left points. Paragraphs have independent boxes.
        blocks = [
            {'id': f'p{n}.heading', 'role': 'heading', 'text': title, 'bbox': [44, 42, 568, 64]},
            {'id': f'p{n}.subtitle', 'role': 'subtitle', 'text': subtitle, 'bbox': [44, 69, 568, 84]},
        ]
        if layout == 1:
            positions = [[44, 103, 297, 260], [315, 103, 568, 260], [44, 268, 297, 410]]
        elif layout == 2:
            positions = [[44, 103, 380, 214], [44, 220, 380, 335], [44, 341, 380, 455]]
        else:
            positions = [[44, 103, 568, 183], [44, 190, 568, 270], [44, 277, 568, 357]]
        for j, para in enumerate(paras):
            blocks.append({'id': f'p{n}.paragraph{j+1}', 'role': 'paragraph', 'text': para, 'bbox': positions[j]})
        if layout == 2:
            table_box, comment_box, inset_box, cap_box = [398, 103, 568, 206], [398, 239, 568, 345], [398, 355, 568, 525], [398, 210, 568, 232]
        elif layout == 1:
            table_box, comment_box, inset_box, cap_box = [315, 276, 568, 383], [44, 430, 568, 471], [44, 480, 568, 576], [315, 386, 568, 403]
        else:
            table_box, comment_box, inset_box, cap_box = [44, 374, 568, 473], [44, 495, 568, 538], [44, 548, 568, 642], [44, 476, 568, 490]
        is_chart = (family + i) % 3 == 0
        chart = {'title': 'Operating response', 'xLabel': 'Check', 'yLabel': 'Reading', 'series': [{'name': 'Measured', 'values': [world['baseline'], world['baseline'] + 4, world['target'] - 3, world['target']]}, {'name': 'Reference', 'values': [world['target']] * 4}], 'xTicks': ['1', '2', '3', '4'], 'yTicks': ['0', '20', '40', '60', '80'], 'bbox': table_box} if is_chart else None
        if chart: caption = 'Figure 1. Operating response across four checks.'
        blocks.extend([
            {'id': f'p{n}.technical', 'role': 'chart' if chart else 'table', 'bbox': table_box},
            {'id': f'p{n}.caption', 'role': 'caption', 'text': caption, 'bbox': cap_box},
            {'id': f'p{n}.commentary', 'role': 'commentary', 'text': commentary, 'bbox': comment_box},
            {'id': f'p{n}.inset', 'role': 'inset', 'text': inset, 'title': inset_title, 'bbox': inset_box, 'asScreenshot': (family+i) % 4 == 0},
            {'id': f'p{n}.footer', 'role': 'footer', 'text': footer, 'bbox': [44, 752, 568, 766]},
        ])
        section_strings = [title, subtitle, *paras, caption, commentary, inset_title, inset, footer]
        if chart:
            chart_text = [chart['title'], chart['xLabel'], chart['yLabel'],
                          *[series['name'] for series in chart['series']],
                          *chart['xTicks'], *chart['yTicks']]
            chart['visibleText'] = chart_text
            section_strings.extend(chart_text)
            technical_markdown = '\n\n'.join(chart_text)
        else:
            technical_markdown = '\n'.join(['| ' + ' | '.join(rows[0]) + ' |',
                '| ' + ' | '.join(['---'] * len(rows[0])) + ' |',
                *['| ' + ' | '.join(row) + ' |' for row in rows[1:]]])
        markdown = '\n\n'.join([f'# {title}', subtitle, *paras, technical_markdown,
                               caption, commentary, f'**{inset_title}**\n\n{inset}', footer])
        difficulty_plan = {'outline': (family+i) % 4 == 0,
                           'decoy': {'text': f'Calibration review reference {n}',
                                     'bbox': [44, 704, 310, 730], 'mode': 'occluded'}
                                    if (family+i) % 3 == 1 else None,
                           'rotationDegrees': 90 if (family+i) % 4 == 2 else 0}
        page = {'pageId': f'family-{family:04d}-p{n:02d}', 'expectedMarkdown': markdown,
                'sections': section_strings, 'paragraphs': paras + [commentary, inset],
                'tables': [] if chart else [{'rows': rows, 'bbox': table_box}], 'charts': [chart] if chart else [], 'formulas': [], 'excludedText': [],
                'bbox': [0, 0, W, H], 'blocks': blocks,
                'readingOrder': [b['id'] for b in blocks], 'difficultyPlan': difficulty_plan}
        page['contentHash'] = digest(canonical(page))
        pages.append(page)
    return {'family': f'mixed-source-{family:04d}', 'split': split_for(family), 'world': world, 'layout': ['single-column', 'two-column', 'side-panel'][layout], 'pages': pages}


def draw_text(c, block, size, font, leading, pad=0):
    x0, y0, x1, y1 = block['bbox']
    lines = wrapped(block['text'], font, size, x1 - x0 - 2*pad)
    if len(lines) * leading > y1 - y0 - 2*pad + .01:
        raise ValueError(f"text overflow: {block['id']} {len(lines)*leading} > {y1-y0-2*pad}")
    c.setFont(font, size)
    for j, line in enumerate(lines):
        c.drawString(x0 + pad, H - y0 - pad - size - j*leading, line)


def render_reportlab(model, path):
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1, pageCompression=1)
    c.setTitle(model['world']['topic'] + ' operating review')
    c.setAuthor('Technical Operations')
    c.setSubject('Operating review and inspection record')
    for page in model['pages']:
        for b in page['blocks']:
            role = b['role']
            c.setFillColor(colors.HexColor('#172a34'))
            if role == 'heading': draw_text(c, b, 16, 'NotoSans', 19)
            elif role == 'subtitle': draw_text(c, b, 9, 'NotoSans', 11)
            elif role == 'paragraph': draw_text(c, b, 10, 'NotoSerif', 12)
            elif role == 'commentary': draw_text(c, b, 9, 'NotoSerif', 11)
            elif role in ('caption', 'footer'): draw_text(c, b, 8, 'NotoSans', 10)
            elif role == 'inset':
                x0, y0, x1, y1 = b['bbox']
                c.setStrokeColor(colors.HexColor('#829ca2'))
                c.setFillColor(colors.HexColor('#f3f7f6'))
                c.rect(x0, H-y1, x1-x0, y1-y0, fill=1, stroke=1)
                c.setFillColor(colors.HexColor('#172a34'))
                title = dict(b, text=b['title'], bbox=[x0+8,y0+6,x1-8,y0+21])
                draw_text(c, title, 9, 'NotoSans', 11)
                content = dict(b, bbox=[x0+8,y0+25,x1-8,y1-6])
                draw_text(c, content, 9, 'NotoSerif', 11)
            elif role == 'table':
                x0, y0, x1, y1 = b['bbox']
                rows = page['tables'][0]['rows']
                table = Table(rows, colWidths=[(x1-x0)/4]*4, rowHeights=(y1-y0)/len(rows))
                table.setStyle(TableStyle([('FONTNAME',(0,0),(-1,-1),'NotoSans'), ('FONTSIZE',(0,0),(-1,-1),7), ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#dcebea')), ('GRID',(0,0),(-1,-1),.35,colors.HexColor('#97a9a9')), ('VALIGN',(0,0),(-1,-1),'MIDDLE'), ('LEFTPADDING',(0,0),(-1,-1),3)]))
                table.wrapOn(c, x1-x0, y1-y0)
                table.drawOn(c, x0, H-y1)
        c.showPage()
    c.save()




def document_metadata(model):
    # The actual rendering tools are recorded in the manifest. Document-facing
    # metadata describes the document's office and export context without a tell.
    genre = model['world']['genre']
    office = {'operational report': 'Operations Records',
              'equipment guidance': 'Equipment Services',
              'engineering brief': 'Engineering Records',
              'inspection record': 'Inspection Services',
              'procurement summary': 'Supply Records',
              'research discussion': 'Technical Research'}[genre]
    family = int(model['family'][-4:])
    year, month, day = 2022 + family % 4, 1 + (family * 5) % 12, 1 + (family * 7) % 25
    date = f'{year:04d}{month:02d}{day:02d}'
    return {'title': model['world']['topic'] + ': ' + genre, 'author': office,
            'subject': genre.capitalize(), 'creator': office,
            'producer': office + ' PDF export',
            'creationDate': f"D:{date}090000+00'00'", 'modDate': f"D:{date}091500+00'00'"}


def add_charts(model, path, scratch):
    import matplotlib
    matplotlib.use('Agg')
    matplotlib.rcParams.update({'pdf.fonttype': 42, 'font.family': 'Noto Sans'})
    import matplotlib.pyplot as plt
    assembled = fitz.open(path)
    for i, data_page in enumerate(model['pages']):
        if not data_page['charts']: continue
        chart = data_page['charts'][0]
        rect = fitz.Rect(chart['bbox'])
        fig, ax = plt.subplots(figsize=(rect.width/72, rect.height/72))
        for series in chart['series']:
            ax.plot([1, 2, 3, 4], series['values'], linewidth=.8, label=series['name'])
        ax.set_title(chart['title'], fontsize=6, pad=1)
        ax.set_xlabel(chart['xLabel'], fontsize=5, labelpad=0)
        ax.set_ylabel(chart['yLabel'], fontsize=5, labelpad=0)
        ax.set_xticks([1,2,3,4], chart['xTicks'])
        ax.set_yticks([0,20,40,60,80], chart['yTicks'])
        ax.tick_params(labelsize=4, length=1, pad=1)
        ax.legend(fontsize=4, loc='upper left', frameon=False, ncol=2)
        fig.subplots_adjust(left=.18, right=.96, top=.83, bottom=.25)
        buf = io.BytesIO(); fig.savefig(buf, format='pdf'); plt.close(fig)
        with fitz.open(stream=buf.getvalue(), filetype='pdf') as plot:
            assembled[i].show_pdf_page(rect, plot, 0)
    assembled.set_metadata(document_metadata(model))
    tmp = scratch/'charts-composed.pdf'
    assembled.save(tmp, garbage=4, deflate=True, no_new_id=1)
    assembled.close()
    tmp.replace(path)


def render_libreoffice(model, path, source_dir, scratch):
    # Each HTML block is exported by Writer/Web, then positioned as vector PDF
    # content in its pre-authored page region. Gold never comes from extraction.
    source_dir.mkdir(parents=True, exist_ok=True)
    inputs = []
    for page_index, data in enumerate(model['pages']):
        for block_index, block in enumerate(data['blocks']):
            if block['role'] == 'chart': continue
            rect = fitz.Rect(block['bbox'])
            width = max(30, int((rect.width - 12) / .75))
            role = block['role']
            if role == 'table':
                rows = data['tables'][0]['rows']
                inner = '<table border="1" cellspacing="0" cellpadding="2" width="100%">' + ''.join('<tr>' + ''.join('<td>'+html.escape(cell)+'</td>' for cell in row) + '</tr>' for row in rows) + '</table>'
            elif role == 'inset':
                inner = '<b>' + html.escape(block['title']) + '</b><br>' + html.escape(block['text'])
            else:
                inner = html.escape(block['text'])
            size = 4 if role == 'heading' else 1 if role in ('footer', 'caption') else 2
            face = 'Noto Serif' if role in ('paragraph', 'commentary', 'inset') else 'Noto Sans'
            markup = '<html><head><meta charset="utf-8"></head><body><table width="' + str(width) + '" cellspacing="0" cellpadding="0"><tr><td><font face="' + face + '" size="' + str(size) + '">' + inner + '</font></td></tr></table></body></html>'
            filename = f'p{page_index:02d}-b{block_index:02d}'
            source = source_dir/(filename+'.html'); source.write_text(markup, encoding='utf8')
            inputs.append((page_index, block_index, filename, source))
    profile = (scratch/'lo-profile').as_uri()
    command = ['soffice', '-env:UserInstallation='+profile, '--headless', '--convert-to', 'pdf', '--outdir', str(scratch)] + [str(v[3]) for v in inputs]
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    doc = fitz.open()
    for _ in model['pages']: doc.new_page(width=W, height=H)
    for pi, bi, filename, _ in inputs:
        block = model['pages'][pi]['blocks'][bi]
        target = fitz.Rect(block['bbox'])
        with fitz.open(scratch/(filename+'.pdf')) as src:
            if len(src) != 1: raise ValueError('LibreOffice block overflow '+filename)
            text_blocks = [fitz.Rect(v[:4]) for v in src[0].get_text('blocks') if v[4].strip()]
            if not text_blocks: raise ValueError('LibreOffice empty block '+filename)
            bounds = fitz.Rect(text_blocks[0])
            for r in text_blocks[1:]: bounds |= r
            bounds += (-1, -1, 1, 1)
            pad = 3 if block['role'] in ('inset', 'table') else 0
            available = target + (pad, pad, -pad, -pad)
            scale = min(1., available.width / bounds.width, available.height / bounds.height)
            if scale < .72: raise ValueError(f'LibreOffice block too large {filename} scale={scale}')
            dest = fitz.Rect(available.x0, available.y0, available.x0+bounds.width*scale, available.y0+bounds.height*scale)
            if block['role'] == 'inset':
                doc[pi].draw_rect(target, color=(.51,.61,.64), fill=(.95,.97,.96), width=.5)
            doc[pi].show_pdf_page(dest, src, 0, clip=bounds)
    doc.set_metadata({'title': model['world']['topic']+' operating review', 'author': 'Technical Operations', 'creator': 'LibreOffice Writer/Web'})
    doc.save(path, garbage=4, deflate=True, no_new_id=1); doc.close()

def verify_native(model, path):
    with fitz.open(path) as doc:
        assert len(doc) == 10
        for i, page in enumerate(doc):
            assert tuple(page.rect) == (0, 0, W, H)
            text = ' '.join(page.get_text().split())
            for block in model['pages'][i]['blocks']:
                local_text = ' '.join(re.sub(r'-\s*\n\s*', '-', page.get_textbox(fitz.Rect(block['bbox']))).split())
                if block['role'] == 'chart':
                    expected = [page_label for page_label in ('Operating response', 'Check', 'Reading', 'Measured', 'Reference')]
                elif block['role'] == 'table':
                    expected = [cell for row in model['pages'][i]['tables'][0]['rows'] for cell in row]
                elif block['role'] == 'inset': expected = [block['title'], block['text']]
                else: expected = [block['text']]
                for item in expected:
                    if ' '.join(item.split()) not in local_text:
                        raise ValueError(f"native geometry or source fidelity: page {i+1}, {block['id']}: {item}")


def scan_bytes(page, dpi, angle, blur, contrast, quality):
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi/72, dpi/72), alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
    img = img.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor='white')
    img = ImageEnhance.Contrast(img).enhance(contrast).filter(ImageFilter.GaussianBlur(blur))
    out = io.BytesIO(); img.save(out, 'JPEG', quality=quality, subsampling=2)
    return out.getvalue()


def transformed_bbox(bbox, angle, dpi):
    # PIL rotates in pixel space about the image centre; pixmap rounding matters.
    width = math.ceil(W*dpi/72); height = math.ceil(H*dpi/72)
    c, sn = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    points = []
    for x in (bbox[0], bbox[2]):
        for y in (bbox[1], bbox[3]):
            px, py = x*width/W-width/2, y*height/H-height/2
            points.append(((c*px+sn*py+width/2)*W/width, (-sn*px+c*py+height/2)*H/height))
    return [max(0, min(p[0] for p in points)), max(0, min(p[1] for p in points)),
            min(W, max(p[0] for p in points)), min(H, max(p[1] for p in points))]


def rotate90_bbox(bbox):
    # PDF rotation is clockwise in top-left display coordinates.
    return [H-bbox[3], bbox[0], H-bbox[1], bbox[2]]


def outline_section(page, original, block):
    rect = fitz.Rect(block['bbox'])
    before = original.get_pixmap(matrix=fitz.Matrix(2,2), clip=rect, alpha=False)
    # PyMuPDF converts the actual rendered glyphs to SVG paths, then to PDF
    # paths. The reference stays authored text; the conversion never labels it.
    svg = original.get_svg_image(text_as_path=True).encode('utf-8')
    with fitz.open(stream=svg, filetype='svg') as vector_source:
        vector_pdf = vector_source.convert_to_pdf()
    with fitz.open(stream=vector_pdf, filetype='pdf') as vectors:
        if vectors[0].get_text().strip(): raise ValueError('outline conversion left text')
        page.add_redact_annot(rect, fill=(1,1,1))
        page.apply_redactions(images=0, graphics=0, text=0)
        page.show_pdf_page(rect, vectors, 0, clip=rect)
    if page.get_textbox(rect).strip(): raise ValueError('outlined section still contains text')
    after = page.get_pixmap(matrix=fitz.Matrix(2,2), clip=rect, alpha=False)
    difference = ImageChops.difference(Image.frombytes('RGB', (before.width,before.height), before.samples),
                                       Image.frombytes('RGB', (after.width,after.height), after.samples))
    mean = sum(ImageStat.Stat(difference).mean)/3
    if mean > 8: raise ValueError(f'outlined section visual change {block["id"]}: {mean:.3f}')
    return round(mean, 5)


def labels_for_case(model, metadata):
    pages = copy.deepcopy(model['pages'])
    for gold, meta in zip(pages, metadata):
        # Plans live in the authored source; case gold describes realized content.
        gold.pop('difficultyPlan', None)
        if meta['hardScan']:
            for block in gold['blocks']:
                block['bbox'] = transformed_bbox(block['bbox'], meta['skewDegrees'], meta['dpi'])
            for item in gold['tables'] + gold['charts']:
                item['bbox'] = transformed_bbox(item['bbox'], meta['skewDegrees'], meta['dpi'])
        elif meta['rotationDegrees'] == 90:
            for block in gold['blocks']: block['bbox'] = rotate90_bbox(block['bbox'])
            for item in gold['tables'] + gold['charts']: item['bbox'] = rotate90_bbox(item['bbox'])
            gold['bbox'] = [0, 0, H, W]
        gold['excludedText'] = [d['text'] for d in meta['excludedBlocks']]
        gold['excludedBlocks'] = copy.deepcopy(meta['excludedBlocks'])
        gold['geometryTransform'] = {'skewDegrees': meta.get('skewDegrees', 0),
                                     'dpi': meta.get('dpi'), 'rotationDegrees': meta['rotationDegrees']}
    return {'schema':'mixed-pdf-authored@v2', 'family':model['family'], 'split':model['split'], 'pages':pages}


def make_case(model, native, output, hard_percent, region_share, seed, region_seed):
    rng = random.Random(seed)
    chosen = set(rng.sample(range(10), hard_percent // 10))
    eligible_all = [(i, b['id']) for i, pg in enumerate(model['pages']) for b in pg['blocks'] if b['role'] == 'paragraph']
    region_selection = set(random.Random(region_seed).sample(eligible_all, round(len(eligible_all)*region_share)))
    out = fitz.open(); metadata = []
    with fitz.open(native) as base:
        for i, original in enumerate(base):
            if i in chosen:
                params = {'dpi': rng.randint(85,125), 'skewDegrees': round(rng.uniform(-.7,.7),2), 'blurRadius': .25, 'contrast': 1.04, 'jpegQuality': rng.randint(72,88)}
                data = scan_bytes(original, **{'dpi':params['dpi'], 'angle':params['skewDegrees'], 'blur':params['blurRadius'], 'contrast':params['contrast'], 'quality':params['jpegQuality']})
                page = out.new_page(width=W, height=H)
                page.insert_image(page.rect, stream=data)
                metadata.append({'pageId': model['pages'][i]['pageId'], 'hardScan': True, **params, 'rasterizedSections': [], 'insetScreenshot': any(b.get('asScreenshot', False) for b in model['pages'][i]['blocks']), 'rotationDegrees': 0, 'excludedBlocks': [], 'outlinedSections': []})
            else:
                out.insert_pdf(base, from_page=i, to_page=i)
                page = out[-1]
                eligible = [b for b in model['pages'][i]['blocks'] if b['role'] == 'paragraph']
                chosen_blocks = [b for b in eligible if (i, b['id']) in region_selection]
                for block in chosen_blocks:
                    rect = fitz.Rect(block['bbox'])
                    pix = original.get_pixmap(matrix=fitz.Matrix(2,2), clip=rect, alpha=False)
                    page.add_redact_annot(rect, fill=(1,1,1))
                    page.apply_redactions(images=0, graphics=0, text=0)
                    page.insert_image(rect, stream=pix.tobytes('png'))
                    # Images replace the native text; no original words may remain in the region.
                    if page.get_textbox(rect).strip():
                        raise ValueError(f"section still has text: {block['id']}")
                inset = next(b for b in model['pages'][i]['blocks'] if b['role'] == 'inset')
                if inset['asScreenshot']:
                    rect = fitz.Rect(inset['bbox'])
                    pix = original.get_pixmap(matrix=fitz.Matrix(2,2), clip=rect, alpha=False)
                    page.add_redact_annot(rect, fill=(1,1,1))
                    page.apply_redactions(images=0, graphics=0, text=0)
                    page.insert_image(rect, stream=pix.tobytes('png'))
                    if page.get_textbox(rect).strip():
                        raise ValueError(f"inset still has text: {inset['id']}")
                plan = model['pages'][i]['difficultyPlan']
                outlined = []
                candidates = [b for b in eligible if b not in chosen_blocks]
                if plan['outline'] and candidates:
                    block = candidates[0]
                    visual_error = outline_section(page, original, block)
                    outlined.append({'id': block['id'], 'bbox': list(block['bbox']),
                                     'method': 'svg-glyph-paths', 'meanPixelError': visual_error})
                excluded = []
                if plan['decoy']:
                    decoy = copy.deepcopy(plan['decoy'])
                    rect = fitz.Rect(decoy['bbox'])
                    page.insert_text(fitz.Point(rect.x0+2, rect.y0+16), decoy['text'], fontsize=9, fontname='NotoDecoy', fontfile=SANS)
                    page.draw_rect(rect, color=None, fill=(1,1,1), overlay=True)
                    if decoy['text'] not in page.get_textbox(rect): raise ValueError('occluded text missing')
                    pixels = page.get_pixmap(matrix=fitz.Matrix(1,1), clip=rect, alpha=False)
                    if min(pixels.samples) < 250: raise ValueError('decoy is not completely occluded')
                    excluded.append(decoy)
                rotation = plan['rotationDegrees']
                if rotation:
                    page.set_rotation(rotation)
                    for item in excluded + outlined: item['bbox'] = rotate90_bbox(item['bbox'])
                metadata.append({'pageId': model['pages'][i]['pageId'], 'hardScan': False,
                                 'rasterizedSections': [b['id'] for b in chosen_blocks],
                                 'insetScreenshot': inset['asScreenshot'], 'rotationDegrees': rotation,
                                 'excludedBlocks': excluded, 'outlinedSections': outlined})
    out.set_metadata(document_metadata(model))
    out.save(output, garbage=4, deflate=True, no_new_id=1)
    out.close()
    with fitz.open(output) as check:
        for i in chosen:
            if check[i].get_text().strip(): raise ValueError(f'hard page {i+1} contains native text')
    return metadata


def storage_variant(pdf, family, variant):
    # Rotate storage properties independently of hard-page share over families.
    profile = (family // 6 + variant) % 4
    version = '1.4' if profile in (0, 1) else '1.7'
    objects = 'disable' if version == '1.4' else 'generate'
    linearized = profile in (1, 3)
    candidate = pdf.with_suffix('.qpdf.pdf')
    command = ['qpdf', '--deterministic-id', '--force-version='+version, '--object-streams='+objects]
    if linearized: command.append('--linearize')
    subprocess.run(command + [str(pdf), str(candidate)], check=True, capture_output=True)
    with fitz.open(pdf) as before, fitz.open(candidate) as after:
        if len(before) != len(after): raise ValueError('storage conversion page count')
        for a, b in zip(before, after):
            if a.get_pixmap(alpha=False).samples != b.get_pixmap(alpha=False).samples:
                raise ValueError('storage conversion changed pixels')
            if a.get_text() != b.get_text(): raise ValueError('storage conversion changed text')
    candidate.replace(pdf)
    return {'pdfVersion': version, 'objectStreams': objects, 'linearized': linearized,
            'visualComparison': 'exact pixels at 72 dpi'}


def build_family(root, family):
    cases = []
    model = author(family)
    family_id, split = model['family'], model['split']
    source = root/'sources'/f'{family_id}.json'
    write_json(root/'worlds'/f'{family_id}.json', model['world'])
    write_json(source, model)  # Persist the complete authored model before rendering.
    source_hash = digest(source.read_bytes())
    native_dir = root/'native'; native_dir.mkdir(exist_ok=True)
    native = native_dir/f'{family_id}.pdf'
    with tempfile.TemporaryDirectory(prefix='fools-gold-v2-', dir=os.environ['TMPDIR']) as temporary:
        scratch = Path(temporary)
        os.environ['MPLCONFIGDIR'] = str(scratch/'matplotlib')
        producer = 'LibreOffice Writer/Web HTML export' if (family//6)%2 else 'ReportLab'
        if producer.startswith('LibreOffice'):
            version = subprocess.run(['soffice', '--version'], check=True, capture_output=True, text=True, timeout=30).stdout.strip()
            render_libreoffice(model, native, native_dir/f'{family_id}-html', scratch)
        else:
            version = reportlab.Version
            render_reportlab(model, native)
        add_charts(model, native, scratch)
        verify_native(model, native)
        for variant, percent in enumerate(range(0,101,20)):
            case_id = f'{family_id}-hard-{percent:03d}'
            pdf = root/'inputs'/split/f'{case_id}.pdf'; pdf.parent.mkdir(parents=True,exist_ok=True)
            label = root/'labels'/split/f'{case_id}.json'; label.parent.mkdir(parents=True,exist_ok=True)
            share = ((family + family // 6) % 6) / 5
            pages = make_case(model, native, pdf, percent, share, family*100+variant+123, family+911)
            profile = storage_variant(pdf, family, variant)
            write_json(label, labels_for_case(model, pages))
            cases.append({'id':case_id, 'family':family_id, 'split':split,
                          'pdf':str(pdf.relative_to(root)), 'labels':str(label.relative_to(root)),
                          'source':str(source.relative_to(root)), 'native':str(native.relative_to(root)),
                          'sha256':digest(pdf.read_bytes()), 'labelHash':digest(label.read_bytes()),
                          'sourceLayoutHash':source_hash, 'hardPercent':percent,
                          'baseRegionRasterShare':share, 'pages':pages, 'layout':model['layout'],
                          'genre':model['world']['genre'], 'producer':producer,
                          'producerVersion':version, 'compositor':f'PyMuPDF {fitz.VersionBind}',
                          'storageProfile':profile})
    print(f'completed {family_id}', flush=True)
    return cases


def main():
    parser = argparse.ArgumentParser(description='Build prototypes, or full corpus only after independent audit.')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--family', type=int, choices=FAMILIES, help='Build one of the three authorized prototype families')
    parser.add_argument('--workers', type=int, choices=(1,2,3), default=3, help='Family workers; maximum 3 on this host')
    parser.add_argument('--audit-approved', action='store_true', help='Confirm the independent audit has authorized full expansion')
    parser.add_argument('--audited-spec-sha256', help='SHA-256 of the final audited spec; required for full expansion')
    parser.add_argument('--plan', action='store_true', help='Describe routing without generating files')
    args = parser.parse_args()
    if args.full and args.family is not None: parser.error('--family cannot be combined with --full')
    families = list(range(90)) if args.full else [args.family] if args.family is not None else list(FAMILIES)
    if args.plan:
        print(json.dumps({'families':len(families), 'cases':len(families)*6, 'pageCount':len(families)*60, 'workers':args.workers, 'splits':{name:sum(split_for(f)==name for f in families) for name in ('train','tune','heldout')}}))
        return
    if args.full:
        if not args.audit_approved or not args.audited_spec_sha256:
            parser.error('--full requires --audit-approved and --audited-spec-sha256 after the independent audit')
        spec = Path(__file__).resolve().parents[3]/'docs/evals/mixed-pdf-yield-v1/fools-gold-spec.md'
        if digest(spec.read_bytes()) != args.audited_spec_sha256.lower():
            parser.error('the audited spec SHA-256 does not match the current spec')
    if not args.output: parser.error('--output is required')
    if os.environ.get('TMPDIR') != '/home/dan/tmp/agents' or os.environ.get('TMP') != os.environ['TMPDIR'] or os.environ.get('TEMP') != os.environ['TMPDIR']:
        parser.error('set TMPDIR, TMP and TEMP to /home/dan/tmp/agents')
    root = args.output.resolve(); root.mkdir(parents=True, exist_ok=False)
    # A fresh child per family ensures LibreOffice, matplotlib and temporary
    # profiles cannot leak state between jobs. Only the parent writes the manifest.
    with ProcessPoolExecutor(max_workers=args.workers, max_tasks_per_child=1) as pool:
        batches = list(pool.map(build_family, [root]*len(families), families))
    cases = [case for batch in batches for case in batch]
    files = {str(path.relative_to(root)): digest(path.read_bytes()) for path in sorted(root.rglob('*')) if path.is_file()}
    write_json(root/'manifest.json', {'schema':'mixed-pdf-authored@v2', 'status':'await-independent-audit', 'families':len(families), 'pageCount':len(cases)*10, 'cases':sorted(cases, key=lambda c:c['id']), 'files':files})

if __name__ == '__main__': main()
