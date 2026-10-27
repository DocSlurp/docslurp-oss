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
from width_readback import width_readback

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
    fr.FillStyle = enum('drawing.FillStyle', 'NONE')
    fr.FillTransparence = 100
    fr.FrameIsAutomaticHeight = False
    fr.SizeType = uno.getConstantByName('com.sun.star.text.SizeType.FIX')
    fr.WidthType = uno.getConstantByName('com.sun.star.text.SizeType.FIX')
    for edge in ['LeftBorder', 'RightBorder', 'TopBorder', 'BottomBorder']:
        border = uno.createUnoStruct('com.sun.star.table.BorderLine2')
        setattr(fr, edge, border)
    doc.Text.insertTextContent(doc.Text.End, fr, False)
    fr.FillStyle = enum('drawing.FillStyle', 'NONE')
    fr.FillTransparence = 100
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
    # A genuine body-owned table avoids an overlapping, paint-owning frame.
    # The native table's own margins locate its grid; no tabs or text grid.
    assert not doc.TextTables.Count, 'This preview path owns one native body table.'
    table = doc.createInstance('com.sun.star.text.TextTable')
    data = obj['data']; rows = len(data); cols = len(data[0])
    table.initialize(rows, cols)
    doc.Text.insertTextContent(doc.Text.Start, table, False)
    table.Name = obj['id'].replace('.', '_') + '_native'
    table.HoriOrient = 0
    table.Width = mm(sum(obj['columnWidthsPt']))
    table.LeftMargin = mm(obj['nativeTablePt'][0])
    table.RightMargin = mm(612-obj['nativeTablePt'][2])
    table.TopMargin = mm(obj['nativeTablePt'][1]); table.BottomMargin = 0
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
    border.Distance = 0; border.IsDistanceValid = True
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
            cell.LeftBorderDistance = mm(obj['paddingPt']); cell.RightBorderDistance = mm(obj['paddingPt'])
            cell.TopBorderDistance = 0; cell.BottomBorderDistance = 0
            cell.VertOrient = 0
            cursor=cell.createTextCursor()
            para(cursor, 'mono', obj['sizePt'], obj['leadingPt'], rgb(obj['color']))
            cursor.CharEscapementHeight = 100
            cursor.CharEscapement = 13 if obj['sizePt']==9 else 12
            cursor.ParaAdjust = 0 if c==0 else 1
            cursor.ParaRightMargin = obj.get('rightInkInsetHmm',0) if c else 0
            cell.BackTransparent = r >= obj['headerRows']
            if r < obj['headerRows']:cell.BackColor = rgb(obj['headerFill'])
    if obj['span']:
        cur = table.createCursorByCellName('B1')
        cur.gotoCellByName('C1', True)
        cur.mergeRange()
        cursor=table.getCellByName('B1').createTextCursor()
        para(cursor,'mono',obj['sizePt'],obj['leadingPt'],rgb(obj['color']))
        cursor.CharEscapementHeight=100
        cursor.CharEscapement=12
        cursor.ParaAdjust=3
    if 'nativeCellPlacements' in obj:
        for placement in obj['nativeCellPlacements']:
            cursor=table.getCellByName(placement['nativeName']).createTextCursor()
            cursor.gotoStart(False);cursor.gotoEnd(True)
            cursor.ParaAdjust=placement['ParaAdjust']
            cursor.ParaLeftMargin=placement['ParaLeftMarginHmm']
            cursor.ParaRightMargin=placement['ParaRightMarginHmm']
    return table

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
    # Force pagination before reading realized geometry; this is not PDF export.
    width_before_pagination={name:width_readback(doc.TextTables.getByName(name)) for name in doc.TextTables.ElementNames}
    rendered_pages=doc.getRendererCount(doc, ())
    objects = []
    for i in range(doc.DrawPage.Count):
        obj = doc.DrawPage.getByIndex(i)
        row = {'index': i, 'identity': obj.Name,
               'properties': safe_read(obj, ['AnchorType', 'AnchorPageNo', 'ZOrder', 'LayerID', 'LayerName', 'Opaque',
                                            'HoriOrientPosition', 'VertOrientPosition', 'Width', 'Height', 'RotateAngle',
                                            'FillStyle','FillTransparence','SizeType','WidthType'])}
        row['nativeType']='WriterTextFrame' if obj.supportsService('com.sun.star.text.TextFrame') else 'DrawingShape'
        try:
            row['text'] = obj.Text.String
        except Exception:
            row['text'] = None
        row['actualDrawPageMembership'] = any(obj == doc.DrawPage.getByIndex(j) for j in range(doc.DrawPage.Count))
        row['container']={'identity':'document.DrawPage','verifiedBy':'actual document DrawPage enumeration and remote-object equality',
                          'membership':row['actualDrawPageMembership']}
        try:
            parent=obj.getParent()
            row['rawParentApi']={'verifiedBy':'XChild.getParent','implementation':parent.getImplementationName(),
                           'equalsActualDrawPage':parent==doc.DrawPage,'equalsActualDocument':parent==doc}
        except Exception as e:
            row['rawParentApi']={'unavailable':str(e),'equivalentEvidence':'actual named membership in document DrawPage; persisted XML checked independently'}
        try:
            anchor = obj.getAnchor()
            if anchor is None:
                row['anchorRange']={'value':None,'reason':'AT_PAGE supplies a page number, not an XTextRange; no body ownership inferred'}
            else:
                row['anchorRange']={'implementation':anchor.Text.getImplementationName(),'bodyTextEquality':anchor.Text==doc.Text}
        except Exception as e:
            row['anchorRange'] = {'unresolved': str(e)}
        objects.append(row)
    tables = []
    bodyTables=[]
    elements=doc.Text.createEnumeration()
    while elements.hasMoreElements():
        element=elements.nextElement()
        if element.supportsService('com.sun.star.text.TextTable'):bodyTables.append(element)
    for name in doc.TextTables.ElementNames:
        table = doc.TextTables.getByName(name)
        anchor=table.getAnchor()
        anchorText=anchor.getText() if anchor is not None else None
        tables.append({'identity': name, 'parent':{'verifiedBy':'actual document Text enumeration and table remote-object equality',
                                                  'bodyMembership':any(table==element for element in bodyTables)},
                       'rawAnchorTextApi':{'isNull':anchorText is None,'bodyTextEquality':anchorText==doc.Text if anchorText else None},
                       'cells': {n: table.getCellByName(n).String for n in table.CellNames},
                       'cellProperties':{n:{'paragraph':safe_read(table.getCellByName(n).createTextCursor(),['ParaAdjust','ParaLeftMargin','ParaRightMargin','CharHeight','CharFontName','CharEscapement','CharEscapementHeight']),
                                            'cell':safe_read(table.getCellByName(n),['LeftBorderDistance','RightBorderDistance','TopBorderDistance','BottomBorderDistance'])} for n in table.CellNames},
                       'properties':safe_read(table,['Width','LeftMargin','RightMargin','TopMargin','HoriOrient']),
                       'widthDiagnosticBeforePagination':width_before_pagination[name],
                       'widthDiagnosticAfterPagination':width_readback(table),
                       'rows': table.Rows.Count, 'cellNames': list(table.CellNames)})
    return {'observedAtUtc': datetime.now(timezone.utc).isoformat(), 'objects': objects, 'tables': tables,
            'expectedObjectIds': [o['id'] for o in plan['objects'] if o['kind']!='table'],
            'pageCount':rendered_pages}

def main():
    from export_binding import bind_export, identity, require
    import os
    import importlib.util
    pipe, plan_path, directory, context_path = sys.argv[1:]
    context = json.loads(Path(context_path).read_bytes())
    require(context['pipe'] == pipe, 'Wrong UNO pipe')
    tools = {role: value['path'] for role, value in context['tools'].items()}
    for role, expected in context['tools'].items():
        require(identity(tools[role]) == expected, 'Launch tool changed: ' + role)
    required_tools = {'writer': str(Path(__file__).resolve()),
                      'binding': str(Path(__file__).with_name('export_binding.py').resolve()),
                      'widthReadback': str(Path(__file__).with_name('width_readback.py').resolve()),
                      'python': str(Path(sys.executable).resolve()),
                      'uno': str(Path(uno.__file__).resolve()),
                      'pyuno': str(Path(importlib.util.find_spec('pyuno').origin).resolve())}
    for role, path in required_tools.items():
        require(tools.get(role) == path, 'Missing actual tool identity: ' + role)
    desktop = connect(pipe)
    def build(plan):
        for obj in plan['objects']:
            if obj['kind'] == 'table':
                require(all('|' not in cell for row in obj['data'] for cell in row), 'Pipes in native cells')
        doc = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
        try:
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
            return doc
        except Exception:
            doc.close(True)
            raise
    def reopen(path):
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(path)), '_blank', 0,
            (prop('Hidden', True), prop('ReadOnly', True),
             prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),
             prop('UpdateDocMode', uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE'))))
        require(doc is not None, 'Reopen returned no document')
        return doc
    def actual(doc, plan):
        doc.refresh()
        return readback(doc, plan)
    def save(doc, path):
        doc.storeAsURL(uno.systemPathToFileUrl(str(path)), (prop('FilterName', 'writer8'), prop('Overwrite', False)))
    def export_pdf(doc, path):
        doc.storeToURL(uno.systemPathToFileUrl(str(path)), (prop('FilterName', 'writer_pdf_Export'),
            prop('FilterData', (prop('SelectPdfVersion', 17), prop('UseTaggedPDF', False), prop('ExportBookmarks', False))),
            prop('Overwrite', False)))
    execution = {**context, 'writerPid': os.getpid(), 'writerArgv': sys.argv,
                 'pythonVersion': sys.version, 'contextIdentity': identity(context_path),
                 'loadProperties': {'Hidden': True, 'ReadOnly': True, 'MacroExecutionMode': 'NEVER_EXECUTE', 'UpdateDocMode': 'NO_UPDATE'},
                 'exportFilter': {'name': 'writer_pdf_Export', 'SelectPdfVersion': 17, 'UseTaggedPDF': False, 'ExportBookmarks': False}}
    # Include the exact launch context in all subsequent source guards.
    tools['context'] = str(Path(context_path).absolute())
    result = bind_export(plan_path, directory, tools, execution, build=build, save=save,
                         close=lambda doc: doc.close(True), reopen=reopen, readback=actual, export_pdf=export_pdf)
    print(str(result))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
