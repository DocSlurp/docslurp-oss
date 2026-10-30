#!/usr/bin/python
"""System-Python UNO bridge; only newly authored Writer files are accepted.

Writer's FODT importer drops table children of draw:text-box on this version.
Create real TextTable instances in those existing frames, then save the complete
editable ODT and export the complete document once. No ReportLab fragments.
"""
import json
from pathlib import Path
import sys
import time
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.style import LineSpacing
from com.sun.star.text import TableColumnSeparator


def property(name,value):
    p=PropertyValue();p.Name=name;p.Value=value;return p


def mm100(pt):return round(pt*2540/72)


def main():
    data=json.load(sys.stdin);local=uno.getComponentContext()
    resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local)
    context=None
    for _ in range(100):
        try:context=resolver.resolve('uno:pipe,name='+data['pipe']+';urp;StarOffice.ComponentContext');break
        except Exception:time.sleep(.1)
    if context is None:raise RuntimeError('isolated Writer pipe did not become ready')
    desktop=context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',context)
    doc=desktop.loadComponentFromURL(Path(data['fodt']).as_uri(),'_blank',0,(property('Hidden',True),property('ReadOnly',False),property('UpdateDocMode',0)))
    if doc is None:raise RuntimeError('Writer did not load the newly authored FODT')
    frames=doc.getTextFrames();proof=[]
    for page in data['layout']['pages']:
        for bid,t in page['tables'].items():
            name=bid.replace('.','_')
            if frames.hasByName(name):frame=frames.getByName(name)
            else:
                # FODT draw:text-box is a Drawing TextShape in this importer,
                # not a Writer TextFrame. Replace that empty shape by a true
                # page-anchored TextFrame before inserting the native table.
                dp=doc.getDrawPage();old=None
                for index in range(dp.getCount()):
                    shape=dp.getByIndex(index)
                    if shape.getName()==name:old=shape;break
                if old is None:raise RuntimeError('missing authored table shape '+name)
                dp.remove(old)
                frame=doc.createInstance('com.sun.star.text.TextFrame')
                frame.setName(name);frame.AnchorType=uno.Enum('com.sun.star.text.TextContentAnchorType','AT_PAGE')
                frame.AnchorPageNo=int(page['id'].split('.p')[1]);frame.Width=mm100(sum(t['columnWidths'])+1);frame.Height=mm100(t['rowHeight']*len(t['data'])+2)
                frame.FrameIsAutomaticHeight=False
                frame.HoriOrient=0;frame.HoriOrientRelation=7;frame.HoriOrientPosition=mm100(t['left'])
                frame.VertOrient=0;frame.VertOrientRelation=7
                correction=0
                if t['kind']=='sans':
                    # Whole Writer export calibration retained with diagnostic
                    # before/after glyph reports. Fixed line boxes center the
                    # font support and add this font's internal leading.
                    font_height=1.1171875*t['size']
                    correction=max(0,(t['rowHeight']-font_height)/2)+.116*t['size']
                frame.VertOrientPosition=mm100(t['top']-.15-correction)
                frame.Surround=uno.Enum('com.sun.star.text.WrapTextMode','THROUGH')
                frame.BackTransparent=True
                frame.FillStyle=uno.Enum('com.sun.star.drawing.FillStyle','NONE')
                for side in ['Top','Bottom','Left','Right']:
                    setattr(frame,side+'BorderDistance',0)
                    border=uno.createUnoStruct('com.sun.star.table.BorderLine2');border.LineStyle=32767;border.LineWidth=0;border.OuterLineWidth=0;border.InnerLineWidth=0;border.LineDistance=0;setattr(frame,side+'Border',border)
                doc.Text.insertTextContent(doc.Text.createTextCursor(),frame,False)
            text=frame.getText();text.setString('')
            columns=len(t['data'][0]);table=doc.createInstance('com.sun.star.text.TextTable');table.initialize(len(t['data']),columns)
            text.insertTextContent(text.createTextCursor(),table,False)
            table.Name=name+'_native';table.HoriOrient=0;table.Width=mm100(sum(t['columnWidths']))
            table.LeftMargin=0;table.RightMargin=0;table.TopMargin=0;table.BottomMargin=0
            table.RepeatHeadline=False
            table_border=uno.createUnoStruct('com.sun.star.table.TableBorder2')
            line=uno.createUnoStruct('com.sun.star.table.BorderLine2');line.LineStyle=32767;line.LineWidth=0
            for side in ['Top','Bottom','Left','Right','Horizontal','Vertical']:
                chosen=line
                if t.get('ruled') and side in ['Top','Bottom','Horizontal']:
                    chosen=uno.createUnoStruct('com.sun.star.table.BorderLine2');chosen.LineStyle=0;chosen.LineWidth=9;chosen.Color=0x67747f
                setattr(table_border,side+'Line',chosen);setattr(table_border,'Is'+side+'LineValid',True)
            table_border.Distance=0;table_border.IsDistanceValid=True;table.TableBorder2=table_border
            # Widths preserve the handoff's native cell grid. Relative separators
            # are supported directly by Writer and survive in editable ODT.
            total=table.TableColumnRelativeSum;acc=0;separators=[]
            for w in t['columnWidths'][:-1]:
                acc+=w;s=TableColumnSeparator();s.Position=round(acc/sum(t['columnWidths'])*total);s.IsVisible=True;separators.append(s)
            table.TableColumnSeparators=tuple(separators)
            for r,row in enumerate(t['data']):
                tr=table.Rows.getByIndex(r);tr.IsAutoHeight=False;tr.Height=mm100(t['rowHeight'])
                for c,value in enumerate(row):
                    if any(r0<=r<=r1 and c0<c<=c1 for r0,c0,r1,c1 in t.get('spans',[])):continue
                    cell=table.getCellByPosition(c,r);cell.setString(value)
                    for side in ['Top','Bottom','Left','Right']:
                        setattr(cell,side+'BorderDistance',0)
                        border=getattr(cell,side+'Border');border.OuterLineWidth=0;border.InnerLineWidth=0;border.LineDistance=0;setattr(cell,side+'Border',border)
                    cell.VertOrient=0
                    cursor=cell.createTextCursor();cursor.gotoEnd(True)
                    cursor.CharFontName='Liberation Mono' if t['kind']=='mono' else 'Liberation Sans';cursor.CharHeight=t['size'];cursor.CharColor=0x14191f
                    cursor.CharWeight=100.0;cursor.ParaAdjust=0
                    cursor.CharKerning=0;cursor.CharAutoKerning=False
                    cursor.ParaTopMargin=0;cursor.ParaBottomMargin=0;cursor.ParaLeftMargin=0;cursor.ParaRightMargin=0
                    spacing=LineSpacing();spacing.Mode=3;spacing.Height=mm100(t['rowHeight']);cursor.ParaLineSpacing=spacing
            # Fill the rectangular grid before merging. Writer cannot address
            # arbitrary grid positions after a row contains merged cells.
            for r0,c0,r1,c1 in t.get('spans',[]):
                cur=table.createCursorByCellName(chr(65+c0)+str(r0+1));cur.gotoCellByName(chr(65+c1)+str(r1+1),True);cur.mergeRange()
            # Apply the table-wide border after per-cell formatting, preserving
            # explicitly ruled derivatives and truly unruled prototypes.
            table.TableBorder2=table_border
            tail=text.createTextCursor();tail.gotoEnd(False);tail.CharHeight=.1;tail.ParaTopMargin=0;tail.ParaBottomMargin=0
            spacing=LineSpacing();spacing.Mode=3;spacing.Height=1;tail.ParaLineSpacing=spacing
            proof.append(dict(blockId=bid,service='com.sun.star.text.TextTable',rows=len(t['data']),columns=columns,spans=t.get('spans',[])))
    props=doc.getDocumentProperties();props.Author=data['world']['role'];props.Title=data['world']['title'];props.Subject='Inspection record and supporting observations'
    doc.storeAsURL(Path(data['odt']).as_uri(),(property('FilterName','writer8'),property('Overwrite',False)))
    options=tuple(property(k,v) for k,v in dict(SelectPdfVersion=0,UseTaggedPDF=False,ExportBookmarks=False,ExportNotes=False).items())
    doc.storeToURL(Path(data['pdf']).as_uri(),(property('FilterName','writer_pdf_Export'),property('Overwrite',False),property('FilterData',options)))
    count=doc.getTextTables().getCount();doc.close(True);desktop.terminate()
    print(json.dumps(dict(tables=proof,totalNativeTables=count,producerOwner='LibreOffice Writer',completeDocument=True)))


if __name__=='__main__':main()
