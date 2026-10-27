"""Editable Writer realization. Run only with system Python for its system UNO ABI.

Input is an already frozen, source-blind drawing plan. No authoring or fitting here.
"""
import collections
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
import traceback
import uno
from com.sun.star.beans import PropertyValue

def prop(name, value):
    p = PropertyValue(); p.Name = name; p.Value = value; return p

def enum(kind, value):
    return uno.Enum('com.sun.star.' + kind, value)

def mm(pt):
    return round(pt * 2540 / 72)

def safe_read(obj, keys):
    result = {}
    for key in keys:
        try:
            value = obj.getPropertyValue(key)
            if isinstance(value, (int, str, float, bool)) or value is None:
                result[key] = value
            elif hasattr(value, 'value'):
                result[key] = str(value.value)
            else:
                result[key] = repr(value)
        except Exception as e:
            result[key] = {'unavailable': str(e)}
    return result

def connect(pipe):
    context = uno.getComponentContext()
    resolver = context.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', context)
    for _ in range(100):
        try:
            remote = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
            return remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
        except Exception:
            time.sleep(.1)
    raise RuntimeError('Isolated Writer pipe was not ready after 10 seconds')

def para(cursor, kind, size, leading, color):
    cursor.gotoStart(False)
    cursor.gotoEnd(True)
    cursor.CharFontName = 'Liberation ' + ('Mono' if kind == 'mono' else 'Sans')
    cursor.CharHeight = size
    cursor.CharWeight = 100
    cursor.CharColor = color
    cursor.CharScaleWidth = 100
    cursor.CharAutoKerning = False
    cursor.CharKerning = 0
    cursor.ParaTopMargin = 0
    cursor.ParaBottomMargin = 0
    cursor.ParaLeftMargin = 0
    cursor.ParaRightMargin = 0
    cursor.ParaFirstLineIndent = 0
    cursor.ParaAdjust = 0
    spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
    spacing.Mode = 3
    spacing.Height = mm(leading)
    cursor.ParaLineSpacing = spacing
    try:
        cursor.ParaIsHyphenation = False
    except Exception:
        pass

def rgb(values):
    r, g, b = [round(x * 255) for x in values]
    return (r << 16) | (g << 8) | b

def position(obj, bounds, name, opaque=True):
    x, y, right, bottom = bounds
    obj.AnchorType = enum('text.TextContentAnchorType', 'AT_PAGE')
    obj.AnchorPageNo = 1
    obj.HoriOrient = 0
    obj.VertOrient = 0
    obj.HoriOrientRelation = 7
    obj.VertOrientRelation = 7
    obj.HoriOrientPosition = mm(x)
    obj.VertOrientPosition = mm(y)
    obj.Width = mm(right - x)
    obj.Height = mm(bottom - y)
    obj.Name = name
    obj.Opaque = opaque
    obj.Surround = enum('text.WrapTextMode', 'THROUGH')

def frame(doc, obj, name, bounds):
    fr = doc.createInstance('com.sun.star.text.TextFrame')
    position(fr, bounds, name)
    fr.LeftMargin = 0; fr.RightMargin = 0; fr.TopMargin = 0; fr.BottomMargin = 0
    fr.LeftBorderDistance = 0; fr.RightBorderDistance = 0; fr.TopBorderDistance = 0; fr.BottomBorderDistance = 0
    fr.BackTransparent = True
    fr.FrameIsAutomaticHeight = False
    for edge in ['LeftBorder', 'RightBorder', 'TopBorder', 'BottomBorder']:
        border = uno.createUnoStruct('com.sun.star.table.BorderLine2')
        setattr(fr, edge, border)
    doc.Text.insertTextContent(doc.Text.End, fr, False)
    return fr

def add_run(doc, obj):
    text = obj['text']
    size = obj['sizePt']
    kind = obj['font']
    if obj.get('rotation', 0):
        # Real editable drawing text, including the complete rotated axis label.
        sh = doc.createInstance('com.sun.star.drawing.TextShape')
        x, y, r, b = obj['framePt']
        sh.AnchorType = enum('text.TextContentAnchorType', 'AT_PAGE')
        sh.AnchorPageNo = 1
        sh.Position = uno.createUnoStruct('com.sun.star.awt.Point', mm(x), mm(y))
        sh.Size = uno.createUnoStruct('com.sun.star.awt.Size', mm(r-x), mm(b-y))
        sh.Name = obj['id']
        doc.DrawPage.add(sh)
        sh.String = text
        sh.TextLeftDistance = 0; sh.TextRightDistance = 0; sh.TextUpperDistance = 0; sh.TextLowerDistance = 0
        sh.FillStyle = enum('drawing.FillStyle', 'NONE'); sh.LineStyle = enum('drawing.LineStyle', 'NONE')
        para(sh.Text.createTextCursor(), kind, size, obj['leadingPt'], rgb(obj['color']))
        sh.RotateAngle = int(obj['rotation'] * -100)
        return sh
    fr = frame(doc, obj, obj['id'], obj['framePt'])
    fr.Text.String = text
    para(fr.Text.createTextCursor(), kind, size, obj['leadingPt'], rgb(obj['color']))
    offset = 0
    for span in obj.get('spans', []):
        cursor = fr.Text.createTextCursor()
        cursor.gotoStart(False)
        cursor.goRight(offset, False)
        cursor.goRight(len(span['text']), True)
        cursor.CharEscapementHeight = 100
        cursor.CharEscapement = round(-span.get('dyPt', 0) / size * 100)
        offset += len(span['text'])
    return fr

def add_table(doc, obj):
    fr = frame(doc, obj, obj['id'] + '.owner', obj['framePt'])
    # A tiny trailing empty paragraph has no ink and is never intended text.
    para(fr.Text.createTextCursor(), 'mono', obj['sizePt'], obj['rowHeightPt'], rgb(obj['color']))
    table = doc.createInstance('com.sun.star.text.TextTable')
    data = obj['data']; rows = len(data); cols = len(data[0])
    table.initialize(rows, cols)
    fr.Text.insertTextContent(fr.Text.Start, table, False)
    table.Name = obj['id'].replace('.', '_') + '_native'
    table.HoriOrient = 0
    table.Width = mm(sum(obj['columnWidthsPt']))
    table.LeftMargin = 0; table.RightMargin = 0; table.TopMargin = 0; table.BottomMargin = 0
    table.Split = False
    table.RepeatHeadline = False
    table.HeaderRowCount = 0
    positions = table.TableColumnSeparators
    cumulative = 0
    for i in range(cols-1):
        cumulative += obj['columnWidthsPt'][i]
        positions[i].Position = round(cumulative / sum(obj['columnWidthsPt']) * table.TableColumnRelativeSum)
    table.TableColumnSeparators = positions
    border = uno.createUnoStruct('com.sun.star.table.TableBorder2')
    for edge in ['TopLine', 'BottomLine', 'LeftLine', 'RightLine', 'HorizontalLine', 'VerticalLine']:
        line = uno.createUnoStruct('com.sun.star.table.BorderLine2')
        if obj['rules'] and edge in ['TopLine', 'BottomLine', 'HorizontalLine']:
            line.Color = 0xA8B6C0; line.LineWidth = mm(.35)
        setattr(border, edge, line); setattr(border, 'Is' + edge + 'Valid', True)
    table.TableBorder2 = border
    for r in range(rows):
        row = table.Rows.getByIndex(r)
        row.IsAutoHeight = False; row.Height = mm(obj['rowHeightPt'])
        for c in range(cols):
            cell = table.getCellByPosition(c, r)
            cell.String = data[r][c]
            cell.LeftBorderDistance = mm(obj['paddingPt']); cell.RightBorderDistance = 0
            cell.TopBorderDistance = 0; cell.BottomBorderDistance = 0
            cell.VertOrient = 0
            para(cell.createTextCursor(), 'mono', obj['sizePt'], obj['leadingPt'], rgb(obj['color']))
    if obj['span']:
        cur = table.createCursorByCellName('B1')
        cur.gotoCellByName('C1', True)
        cur.mergeRange()
    return fr, table

def add_path(doc, obj):
    if obj['kind'] == 'rect':
        sh = doc.createInstance('com.sun.star.drawing.RectangleShape')
        x, y, right, bottom = obj['rectPt']
        sh.Position = uno.createUnoStruct('com.sun.star.awt.Point', mm(x), mm(y))
        sh.Size = uno.createUnoStruct('com.sun.star.awt.Size', mm(right-x), mm(bottom-y))
        sh.FillStyle = enum('drawing.FillStyle', 'SOLID')
        sh.FillColor = rgb(obj['fill'])
        sh.LineStyle = enum('drawing.LineStyle', 'NONE')
    else:
        sh = doc.createInstance('com.sun.star.drawing.PolyLineShape')
        pts = obj['pointsPt']
        x = min(p[0] for p in pts); y = min(p[1] for p in pts)
        right = max(p[0] for p in pts); bottom = max(p[1] for p in pts)
        sh.Position = uno.createUnoStruct('com.sun.star.awt.Point', mm(x), mm(y))
        sh.Size = uno.createUnoStruct('com.sun.star.awt.Size', max(1, mm(right-x)), max(1, mm(bottom-y)))
        # Points remain absolute document coordinates after PolyPolygon assignment.
        poly = tuple(uno.createUnoStruct('com.sun.star.awt.Point', mm(a), mm(b)) for a,b in pts)
        sh.PolyPolygon = (poly,)
        sh.LineColor = rgb(obj['color']); sh.LineWidth = mm(obj['widthPt'])
        sh.FillStyle = enum('drawing.FillStyle', 'NONE')
    sh.AnchorType = enum('text.TextContentAnchorType', 'AT_PAGE'); sh.AnchorPageNo = 1
    sh.Name = obj['id']; doc.DrawPage.add(sh)
    sh.Opaque = obj.get('z', 20) >= 15
    return sh

def readback(doc, plan):
    objects = []
    for i in range(doc.DrawPage.Count):
        obj = doc.DrawPage.getByIndex(i)
        row = {'index': i, 'identity': obj.Name,
               'properties': safe_read(obj, ['AnchorType', 'AnchorPageNo', 'ZOrder', 'LayerID', 'LayerName', 'Opaque',
                                            'HoriOrientPosition', 'VertOrientPosition', 'Width', 'Height', 'RotateAngle'])}
        try:
            anchor = obj.Anchor
            owner = anchor.Text
            if owner == doc.Text:
                row['parent'] = 'document-body'
            else:
                row['parent'] = {'unresolved': 'actual anchor text differs from body; no proxy fallback'}
            row['anchorTextImplementation'] = owner.getImplementationName()
        except Exception as e:
            row['parent'] = {'unresolved': str(e)}
        objects.append(row)
    tables = []
    for name in doc.TextTables.ElementNames:
        table = doc.TextTables.getByName(name)
        tables.append({'identity': name, 'parent': 'table-owner frame, verified separately from persisted content.xml',
                       'cells': {n: table.getCellByName(n).String for n in table.CellNames},
                       'rows': table.Rows.Count, 'cellNames': list(table.CellNames)})
    return {'observedAtUtc': datetime.now(timezone.utc).isoformat(), 'objects': objects, 'tables': tables,
            'expectedObjectIds': [o['id'] + ('.owner' if o['kind'] == 'table' else '') for o in plan['objects']],
            'pageCount': doc.CurrentController.PageCount if hasattr(doc.CurrentController, 'PageCount') else 'unavailable'}

def main():
    pipe, plan_path, directory = sys.argv[1:]
    directory = Path(directory)
    plan = json.loads(Path(plan_path).read_text())
    desktop = connect(pipe)
    doc = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
    style = doc.StyleFamilies.getByName('PageStyles').getByName('Standard')
    style.Width = mm(612); style.Height = mm(792)
    style.LeftMargin = 0; style.RightMargin = 0; style.TopMargin = 0; style.BottomMargin = 0
    style.HeaderIsOn = False; style.FooterIsOn = False
    doc.DocumentProperties.Title = plan['title']
    doc.DocumentProperties.Author = plan['author']
    for obj in sorted(plan['objects'], key=lambda o: (o.get('z', 20), o['id'])):
        if obj['kind'] == 'text': add_run(doc, obj)
        elif obj['kind'] == 'table': add_table(doc, obj)
        else: add_path(doc, obj)
    doc.refresh()
    stem = plan['stem']
    (directory / (stem + '.readback-before.json')).write_text(json.dumps(readback(doc, plan), indent=2))
    source = directory / (stem + '.odt')
    doc.storeAsURL(uno.systemPathToFileUrl(str(source)), (prop('FilterName', 'writer8'), prop('Overwrite', False)))
    doc.close(True)
    doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(source)), '_blank', 0, (prop('Hidden', True),))
    doc.refresh()
    (directory / (stem + '.readback-reloaded.json')).write_text(json.dumps(readback(doc, plan), indent=2))
    pdf = directory / (stem + '.pdf')
    doc.storeToURL(uno.systemPathToFileUrl(str(pdf)), (prop('FilterName', 'writer_pdf_Export'),
        prop('FilterData', (prop('SelectPdfVersion', 17), prop('UseTaggedPDF', False), prop('ExportBookmarks', False))), prop('Overwrite', False)))
    doc.close(True)
    print(str(pdf))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
