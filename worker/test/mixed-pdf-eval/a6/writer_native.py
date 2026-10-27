"""Complete Writer realization of an immutable a6 native scene.

Run with the system Python providing UNO. No ReportLab import or PDF insertion.
Frames own their backgrounds; panel text and tables are anchored inside the owner.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.style import LineSpacing
from com.sun.star.table import BorderLine2


def props(**kwargs):
    return tuple(PropertyValue(k, 0, v, 0) for k, v in kwargs.items())


def mm(pt): return round(pt * 2540 / 72)


def rgb(value):
    return sum(round(c * 255) << shift for c, shift in zip(value, (16, 8, 0)))


def font(cursor, run, leading=None):
    cursor.CharFontName = 'Liberation ' + ('Mono' if run['font'] == 'mono' else 'Sans')
    cursor.CharHeight = float(run['size'])
    cursor.CharWeight = 100.0
    cursor.CharColor = rgb(run.get('color', [0.08, 0.1, 0.12]))
    cursor.CharAutoKerning = False
    cursor.CharKerning = 0
    cursor.CharScaleWidth = 100
    cursor.CharEscapementHeight = 100
    cursor.CharEscapement = int(run.get('baselineShiftPct', 0))
    cursor.ParaAdjust = 0
    cursor.ParaTopMargin = 0
    cursor.ParaBottomMargin = 0
    cursor.ParaLeftMargin = 0
    cursor.ParaRightMargin = 0
    cursor.ParaFirstLineIndent = 0
    cursor.ParaLineSpacing = LineSpacing(3, mm(leading or run['size'] * 1.2))


def set_frame(doc, text, anchor, name, box, background=None, page=None):
    f = doc.createInstance('com.sun.star.text.TextFrame')
    f.Name = name
    f.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AT_PAGE' if page else 'AT_FRAME')
    if page: f.AnchorPageNo = page
    f.Width = mm(box[2] - box[0])
    f.Height = mm(box[3] - box[1])
    f.SizeType = 1  # FIX, native frame geometry is not an auto-size request.
    f.FrameIsAutomaticHeight = False
    f.HoriOrient = 0
    f.VertOrient = 0
    f.HoriOrientRelation = 7 if page else 0
    f.VertOrientRelation = 7 if page else 0
    f.HoriOrientPosition = mm(box[0] - (0.1 if page else 0))
    f.VertOrientPosition = mm(box[1])
    f.LeftMargin = f.RightMargin = f.TopMargin = f.BottomMargin = 0
    f.LeftBorderDistance = f.RightBorderDistance = f.TopBorderDistance = f.BottomBorderDistance = 0
    border = BorderLine2()
    for side in ('LeftBorder', 'RightBorder', 'TopBorder', 'BottomBorder'): setattr(f, side, border)
    f.Surround = uno.Enum('com.sun.star.text.WrapTextMode', 'THROUGH')
    f.BackTransparent = background is None
    if background is not None: f.BackColor = rgb(background)
    text.insertTextContent(anchor, f, False)
    return f


def readback(doc, phase):
    """Actual persisted UNO properties; unsupported fields are explicit."""
    objects = []
    names = doc.TextFrames.getElementNames()
    frame_owners = {}
    for name in names:
        frame = doc.TextFrames.getByName(name)
        frame_owners[frame.Text] = name
    for name in names:
        frame = doc.TextFrames.getByName(name)
        record = dict(id=name, type='TextFrame', phase=phase)
        for prop in ('AnchorType', 'AnchorPageNo', 'ZOrder', 'LayerID', 'HoriOrientPosition',
                     'VertOrientPosition', 'Width', 'Height', 'BackColor', 'BackTransparent'):
            try:
                value = frame.getPropertyValue(prop)
                record[prop] = value.value if isinstance(value, uno.Enum) else value
            except Exception as e:
                record[prop] = dict(unsupported=type(e).__name__, equivalent='PDF native paint trace and owning frame chain')
        try:
            record['parent'] = frame_owners.get(frame.Anchor.getText(), 'document-body')
        except Exception as e:
            record['parent'] = dict(unsupported=type(e).__name__, equivalent='ODT content.xml containment')
        objects.append(record)
    for name in doc.TextTables.getElementNames():
        table = doc.TextTables.getByName(name)
        rec = dict(id=name, type='TextTable', rows=table.Rows.Count, cells=list(table.CellNames))
        for prop in ('AnchorType', 'AnchorPageNo', 'ZOrder', 'LayerID'):
            try:
                value = table.getPropertyValue(prop)
                rec[prop] = value.value if isinstance(value, uno.Enum) else value
            except Exception as e:
                rec[prop] = dict(unsupported=type(e).__name__, equivalent='owning native frame, ODT table anchor and PDF cell paint order')
        try: rec['parent'] = frame_owners.get(table.Anchor.getText(), 'document-body')
        except Exception: rec['parent'] = 'resolve-from-ODT-XML'
        objects.append(rec)
    draw = []
    for index in range(doc.DrawPage.Count):
        shape = doc.DrawPage.getByIndex(index)
        rec = dict(index=index, type=shape.ShapeType)
        for prop in ('Name', 'ZOrder', 'LayerID', 'AnchorPageNo'):
            try: rec[prop] = shape.getPropertyValue(prop)
            except Exception as e: rec[prop] = dict(unsupported=type(e).__name__)
        draw.append(rec)
    return dict(phase=phase, pages=doc.CurrentController.PageCount, objects=objects, drawPage=draw)


def persisted_object_evidence(odt):
    draw='{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}'
    text='{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
    table='{urn:oasis:names:tc:opendocument:xmlns:table:1.0}'
    with zipfile.ZipFile(odt) as archive: root=ET.fromstring(archive.read('content.xml'))
    objects=[]
    def visit(node,parent='document-body',page=None):
        if node.tag==draw+'frame':
            name=node.get(draw+'name')
            anchor_page=node.get(text+'anchor-page-number')
            page=int(anchor_page) if anchor_page is not None else page
            objects.append(dict(id=name,parent=parent,actualPageAnchor=page,
                anchorType=node.get(text+'anchor-type'),layer=node.get(draw+'layer'),
                realizedZIndex=node.get(draw+'z-index'),attributes=dict(node.attrib)))
            parent=name
        if node.tag==table+'table':
            objects.append(dict(id=node.get(table+'name'),parent=parent,actualPageAnchor=page,
                layer='inherited-native-text-container',attributes=dict(node.attrib)))
        for child in node:visit(child,parent,page)
    visit(root)
    return dict(basis='Complete ODT content.xml after save and reload; actual containment, anchors and serialized layer/order',objects=objects)


def table_into(doc, owner, block):
    table = doc.createInstance('com.sun.star.text.TextTable')
    data = block['table']['data']
    table.initialize(len(data), len(data[0]))
    owner.Text.insertTextContent(owner.Text.createTextCursor(), table, False)
    table.Name = block['id'].replace('.', '_') + '_native'
    table.HoriOrient = 0
    table.Width = mm(sum(block['table']['widths']))
    table.LeftMargin = table.RightMargin = table.TopMargin = table.BottomMargin = 0
    table.RepeatHeadline = False
    border = BorderLine2()
    border.Color = rgb([0.35, 0.4, 0.45])
    border.LineWidth = mm(0.3) if block['table']['ruled'] else 0
    for row in range(len(data)):
        table.Rows.getByIndex(row).IsAutoHeight = False
        table.Rows.getByIndex(row).Height = mm(block['table']['rowHeight'])
        for col in range(len(data[0])):
            cell = table.getCellByPosition(col, row)
            cell.LeftBorderDistance = mm(block['table']['padding'])
            cell.RightBorderDistance = cell.TopBorderDistance = cell.BottomBorderDistance = 0
            for side in ('LeftBorder', 'RightBorder', 'TopBorder', 'BottomBorder'):
                setattr(cell, side, border)
            cell.String = data[row][col]
            cursor = cell.createTextCursor()
            cursor.gotoStart(False)
            cursor.gotoEnd(True)
            font(cursor, block['runs'][0], block['table']['rowHeight'])
    widths = block['table']['widths']
    total = sum(widths)
    separators = list(table.TableColumnSeparators)
    offset = 0
    for i, s in enumerate(separators):
        offset += widths[i]
        s.Position = round(offset / total * 10000)
        s.IsVisible = True
    table.TableColumnSeparators = tuple(separators)
    # Every physical cell is populated before merging. Subsequent access uses anchors.
    for r0, c0, r1, c1 in block['table']['spans']:
        cursor = table.createCursorByCellName(f'{chr(65+c0)}{r0+1}')
        cursor.gotoCellByName(f'{chr(65+c1)}{r1+1}', True)
        cursor.mergeRange()
    return table


def realize(doc, scene):
    page_style = doc.StyleFamilies.getByName('PageStyles').getByName('Standard')
    page_style.Width = mm(612)
    page_style.Height = mm(792)
    for side in ('LeftMargin', 'RightMargin', 'TopMargin', 'BottomMargin'): setattr(page_style, side, 0)
    body = doc.Text
    cursor = body.createTextCursor()
    # Real body paragraphs establish all ten pages; AT_PAGE frames never substitute for pagination.
    cursor.CharHeight = 1.0
    cursor.ParaTopMargin = cursor.ParaBottomMargin = 0
    for i in range(10):
        if i:
            body.insertControlCharacter(cursor, 0, False)
            cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
        body.insertString(cursor, '', False)
    owners = {}
    all_frames = []
    for page in scene['pages']:
        lookup = {b['id']: b for b in page['blocks']}
        for bid in page['paintOrder']:
            b = lookup[bid]
            parent_id = b.get('owner')
            parent = owners.get(parent_id)
            box = list(b['box'])
            if parent is not None:
                parent_box = lookup[parent_id]['box']
                box = [box[0]-parent_box[0], box[1]-parent_box[1], box[2]-parent_box[0], box[3]-parent_box[1]]
                text, anchor = parent.Text, parent.Text.createTextCursor()
            else: text, anchor = body, body.createTextCursor()
            if b.get('graphic'):
                graphic = doc.createInstance('com.sun.star.text.TextGraphicObject')
                graphic.Name = b['id']
                graphic.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AT_PAGE' if parent is None else 'AT_FRAME')
                if parent is None: graphic.AnchorPageNo = page['number']
                graphic.GraphicURL = Path(b['graphic']).as_uri()
                graphic.Width = mm(box[2]-box[0]);graphic.Height = mm(box[3]-box[1])
                graphic.HoriOrient = graphic.VertOrient = 0
                graphic.HoriOrientRelation = graphic.VertOrientRelation = 7 if parent is None else 0
                graphic.HoriOrientPosition = mm(box[0]);graphic.VertOrientPosition = mm(box[1])
                graphic.Surround = uno.Enum('com.sun.star.text.WrapTextMode', 'THROUGH')
                text.insertTextContent(anchor, graphic, False)
                all_frames.append((graphic,b))
                continue
            f = set_frame(doc, text, anchor, b['id'], box, b.get('background'),
                          None if parent is not None else page['number'])
            owners[bid] = f
            all_frames.append((f, b))
            if b.get('table'):
                table_into(doc, f, b)
            else:
                # Scene text runs have explicit lines; no automatic wrapping is relied upon.
                c = f.Text.createTextCursor()
                for i, run in enumerate(b.get('runs', [])):
                    if i: f.Text.insertControlCharacter(c, 0, False)
                    font(c, run, b.get('leading', run['size']*1.2))
                    f.Text.insertString(c, run['text'], False)
    doc.refresh()
    doc.calculateAll() if hasattr(doc, 'calculateAll') else None
    # Requested global order is applied only after every native table has been inserted.
    # Correctness still depends on the independent readback and original PDF visibility gate.
    for z, (f, b) in enumerate(all_frames):
        try: f.ZOrder = z
        except Exception: pass
    doc.refresh()
    return all_frames


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('scene', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--profile', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.profile.mkdir(parents=True, exist_ok=True)
    for key in ('TMPDIR', 'TMP', 'TEMP'): os.environ[key] = '/home/dan/tmp/agents'
    name = 'a6_' + uuid.uuid4().hex
    connection = f'pipe,name={name};urp;StarOffice.ComponentContext'
    log = (args.output / 'soffice.log').open('xb')
    proc = subprocess.Popen(['soffice', f'-env:UserInstallation={args.profile.as_uri()}', '--headless',
        '--norestore', '--nodefault', '--nofirststartwizard', f'--accept={connection}'], stdout=log, stderr=log)
    doc = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        context = None
        for _ in range(100):
            try: context = resolver.resolve('uno:' + connection); break
            except Exception:
                if proc.poll() is not None: raise RuntimeError('LibreOffice exited before UNO connection')
                time.sleep(0.1)
        assert context is not None, 'UNO pipe did not become ready'
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        doc = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, props(Hidden=True))
        scene = json.loads(args.scene.read_bytes())
        assert len(scene['pages']) == 10
        realize(doc, scene)
        before = readback(doc, 'after-tables-and-final-order')
        odt = args.output / 'complete.odt'
        doc.storeAsURL(odt.as_uri(), props(FilterName='writer8', Overwrite=False))
        doc.storeToURL((args.output / 'complete.fodt').as_uri(), props(FilterName='OpenDocument Text Flat XML', Overwrite=False))
        doc.close(True)
        doc = desktop.loadComponentFromURL(odt.as_uri(), '_blank', 0, props(Hidden=True))
        after = readback(doc, 'after-ODT-reload')
        doc.storeToURL((args.output / 'original.pdf').as_uri(), props(FilterName='writer_pdf_Export',
            FilterData=props(SelectPdfVersion=0, UseTaggedPDF=False, ExportBookmarks=False)))
        with (args.output / 'object-readback.json').open('x') as f:
            json.dump(dict(before=before, after=after,persisted=persisted_object_evidence(odt)), f, indent=2)
        doc.close(True)
        doc = None
        desktop.terminate()
    finally:
        if doc is not None:
            try: doc.close(True)
            except Exception: pass
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill()
        log.close()


if __name__ == '__main__': main()
