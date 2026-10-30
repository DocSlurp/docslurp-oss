"""Complete ReportLab and Writer native paths, authored by stable block IDs."""
import base64
import copy
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
import math
from pathlib import Path
import tempfile
from xml.sax.saxutils import escape

import fitz
import numpy as np
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Table, TableStyle
from reportlab.lib.utils import ImageReader

from fools_gold_v4_common import *
from fools_gold_v4_content import display_content

FONTS=font_paths()
for _kind,_p in FONTS.items():
    _font=TTFont('V4'+_kind,str(_p))
    # Use the installed font's horizontal ascender/descender, not ReportLab's
    # OS/2 typo metric selection. This makes support consistent across Writer
    # and ReportLab without scaling any glyph or disguising the actual font.
    _metrics=fitz.Font(fontfile=str(_p))
    _font.face.ascent=_metrics.ascender*1000
    _font.face.descent=_metrics.descender*1000
    pdfmetrics.registerFont(_font)
METRICS={k:fitz.Font(fontfile=str(p)) for k,p in FONTS.items()}


def width(text,kind,size): return pdfmetrics.stringWidth(text,'V4'+kind,size)


def split_lines(text, count, max_width, kind, size):
    """Explicit breaks, no reflow at export. Never horizontally scale glyphs."""
    if '\n' in text:
        lines=text.split('\n')
        if len(lines)==count:return lines
    ws=norm(text).split();n=len(ws)
    # DP chooses valid breaks with a long first line and ragged last line. Short
    # blocks may intentionally break earlier to reproduce measured whitespace.
    memo={}
    def solve(i,left):
        key=(i,left)
        if key in memo:return memo[key]
        if left==0:return (0,[]) if i==n else None
        best=None
        for j in range(i+1,n-left+2):
            t=' '.join(ws[i:j]);w=width(t,kind,size)
            if w>max_width+1e-6:break
            rest=solve(j,left-1)
            if rest is None:continue
            # At least one line approaches occupied width; remaining ones can
            # be shorter. Favor longer early lines as ordinary paragraph flow.
            cost=(max_width-w)**2*(.04 if left==1 else 1)+rest[0]
            if best is None or cost<best[0]:best=(cost,[t]+rest[1])
        memo[key]=best;return best
    result=solve(0,count)
    if result is None:raise ValueError(f'Cannot typeset {count} lines at {max_width}: {text}')
    return result[1]


def glyph_line(block_id,text,x,top,size,kind,start,ordinal,visible=True):
    # Liberation hhea metrics are also emitted into ReportLab's embedded font
    # descriptor. Each code point is planned before any native PDF exists.
    f=METRICS[kind];height=(f.ascender-f.descender)*size
    chars=[];offset=start
    for c in text:
        advance=width(c,kind,size)
        chars.append(dict(id=f'{block_id}.g{ordinal:04d}',text=c,
                          bboxPt=[x,top,x+max(advance,.001),top+height],
                          visible=visible,blockId=block_id,logicalOffset=offset,displayOrdinal=ordinal))
        x+=advance;offset+=1;ordinal+=1
    return chars


def equation(q,a,b,x,y,display,unit):
    value=(Decimal(x)/Decimal(y)).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
    return dict(display=display,latex=f'{q} = \\frac{{{a}}}{{{b}}}',
                ast=dict(op='equal',args=[dict(op='symbol',name=q),dict(op='divide',args=[dict(op='symbol',name=a),dict(op='symbol',name=b)])]),
                variables=[dict(symbol=q,valueDecimal=str(value),unit=unit+'/s'),dict(symbol=a,valueDecimal=str(x),unit=unit),dict(symbol=b,valueDecimal=str(y),unit='s')],
                valueDecimal=str(value),absoluteTolerance=0.000001,
                constraints=['rounding=ROUND_HALF_UP; decimal_places=6',f'{b} > 0'])


def illustration(seed):
    """Text-free material diagram, not a disguised excerpt or screenshot."""
    rng=np.random.default_rng(seed);im=Image.new('RGB',(680,510),(228,234,237));d=ImageDraw.Draw(im)
    for i in range(8):
        x=35+i*77;y=45+int(rng.integers(0,80))
        d.rounded_rectangle([x,y,x+53,430-int(rng.integers(0,65))],12,fill=(119+i*8,144+i*6,154+i*5),outline=(68,89,100),width=3)
        d.ellipse([x+12,y+15,x+41,y+42],fill=(215,224,228),outline=(83,107,118),width=2)
    out=BytesIO();im.save(out,format='PNG');return out.getvalue()


def author(spec,family,world,spec_hash):
    layout=layout_for(spec,family);pages=[];resolved=[]
    for wp in world['pages']:
        pid=f'f{family["familyId"]:04d}.p{wp["number"]:02d}'
        texts,table,params=display_content(world,wp,family)
        from fools_gold_v4_enriched import material
        texts,tables,formulas,figures=material(spec,family,world,wp,texts,table)
        blocks=[];placements={};table_layouts={};figure_layouts={}
        for t in layout['blocks']:
            bid=pid+'.'+t['id'];typ=t['typography'];text=texts.get(t['id'],'');glyphs=[];cells=[]
            b=dict(id=bid,templateId=t['id'],role=t['role'],visible=t['visible'],bboxPt=t['bbox_pt'],
                   bboxNormalized=t['bbox_normalized'],containerPt=t['container_pt'],zOrder=t['z_order'],
                   readingRank=t['reading_rank'],displayText=text,glyphs=glyphs,fonts=[],cells=cells,
                   formula=None,chart=None,assetHash=None,
                   semanticClass='quoted' if t['role']=='quoted-excerpt' else 'decoy' if not t['visible'] else 'decoration' if not typ else 'ordinary')
            if typ:
                size=typ['font_size_pt'];lead=typ['leading_pt'];kind=typ['font_class']
                b['fonts']=[dict(family=typ['family'],fileHash=file_hash(FONTS[kind]),sizePt=size,leadingPt=lead,weight=typ['weight'],embedded=True,subset=True)]
                if t['id'] in figures:
                    from fools_gold_v4_figures import math_asset,chart_asset
                    figure=figures[t['id']]
                    if figure['kind']=='chart':
                        chart=figure['chart'];raw,labels=chart_asset(chart,t['bbox_pt'],bid,FONTS)
                        offset=ordinal=0;pieces=[]
                        for label in labels:
                            literal=label['text'];box=label['bbox'];gg=[]
                            if label['rotation'] in [90,90.0]:
                                advance=(box[3]-box[1])/max(1,len(literal))
                                for j,ch in enumerate(literal):gg.append(dict(id=f'{bid}.g{ordinal+j:04d}',text=ch,bboxPt=[box[0],box[3]-(j+1)*advance,box[2],box[3]-j*advance],visible=True,blockId=bid,logicalOffset=offset+j,displayOrdinal=ordinal+j))
                            else:
                                gg=glyph_line(bid,literal,box[0],box[1],label['size'],'sans',offset,ordinal)
                            glyphs.extend(gg);offset+=len(literal)+1;ordinal+=len(gg);pieces.append(literal)
                            if label['id'].startswith('tick-'):
                                axis=label['id'].split('-')[1];chart['ticks'].append(dict(axis=axis,valueDecimal=literal,displayText=literal,bboxPt=box))
                            if label['id'].startswith('legend-'):chart['legend'].append(dict(displayText=literal,seriesIndex=int(label['id'].split('-')[-1]),bboxPt=box))
                        b['displayText']='\n'.join(pieces);chart['textGlyphIds']=[g['id'] for g in glyphs];b['chart']=chart
                        b['bboxPt']=t['bbox_pt']
                    else:
                        latex=r'\mathrm{Rule}\ '+f'{wp["number"]:02d}'+r':\ '+figure['latex']
                        raw,labels=math_asset(latex,t['bbox_pt']);literal=figures[t['id']]['formula']['display'];positions={};cursor=0
                        for j,label in enumerate(labels):
                            char=label['text'];start=0 if char=='―' else cursor;pos=literal.find(char,start)
                            if pos<0:raise ValueError('Math glyph does not resolve to literal: '+repr(char)+' in '+literal)
                            if char!='―':cursor=pos+1
                            glyphs.append(dict(id=f'{bid}.g{j:04d}',text=char,bboxPt=label['bbox'],visible=True,blockId=bid,logicalOffset=pos,displayOrdinal=pos))
                        glyphs.sort(key=lambda g:g['logicalOffset']);b['displayText']=literal;b['formula']=formulas[t['id']]
                        b['bboxPt']=union_box(g['bboxPt'] for g in glyphs)
                    # These complete SVG assets contain actual font outlines,
                    # not a native text font resource. Record the true math/
                    # chart font and each subscript size instead of claiming
                    # the surrounding mono paragraph font owned those glyphs.
                    font_records={}
                    for label in labels:
                        key=(label.get('fontFamily','Liberation Sans'),label.get('fontHash',file_hash(FONTS['sans'])),float(label['size']))
                        font_records[key]=dict(family=key[0],fileHash=key[1],sizePt=key[2],leadingPt=lead,weight=400,embedded=False,subset=False)
                    b['fonts']=list(font_records.values())
                    b['assetHash']=sha(raw);b['bboxNormalized']=normalized(b['bboxPt'])
                    figure_layouts[bid]=dict(svgBase64=base64.b64encode(raw).decode(),bbox=t['bbox_pt'],assetHash=sha(raw),kind=figure['kind'])
                elif t['id'] in tables:
                    table_info=tables[t['id']];table=table_info['data'];spans=table_info['spans'];separator=table_info['separator']
                    shape=t['table_shape'];colwidths=shape['column_widths_pt'];rh=shape['row_height_pt']
                    if family['classId']=='P' and family['layoutId']=='B':colwidths=[v*.9 for v in [54,48,66,48]]
                    ordinal=0;offset=0;rowstrings=[];drawcells=[]
                    for r,row in enumerate(table):
                        xx=t['bbox_pt'][0];drawrow=[];rs=[]
                        for c,val in enumerate(row):
                            covered=any(r0<=r<=r1 and c0<c<=c1 for r0,c0,r1,c1 in spans)
                            if covered:drawrow.append('');xx+=colwidths[c];continue
                            span=next((s for s in spans if (r,c)==(s[0],s[1])),None)
                            printed=val+((separator if separator is not None else ' ') if c<len(row)-1 else '')
                            # Spaces that align cells belong to layout, not extra
                            # inferred logical text. Literal pipes remain gold.
                            cg=glyph_line(bid,printed,xx,t['bbox_pt'][1]+r*rh,size,kind,offset,ordinal)
                            glyphs.extend(cg);ordinal+=len(cg);offset+=len(printed)
                            meaningful=cg[:len(val)]
                            cell_box=[xx,t['bbox_pt'][1]+r*rh,xx+colwidths[c],t['bbox_pt'][1]+r*rh+rh]
                            # A cell's own typographic support is smaller than its
                            # layout cell. Full support may have overlapping line
                            # boxes; ink does not overlap the neighboring row.
                            denom=world.get('durationUnit','h' if family['layoutId']=='C' else 's')
                            header=r in shape['header_rows']
                            cellunit='label' if header else ['identifier',denom,world['unit'],world['unit']+'/'+denom][c]
                            if t['id']=='discussion.mini-table' and not header:cellunit=['identifier',world['unit'],'label'][c]
                            cells.append(dict(row=r,column=c,rowSpan=1 if span is None else span[2]-r+1,columnSpan=1 if span is None else span[3]-c+1,displayText=val,
                                              value=val,unit=cellunit,
                                              bboxPt=union_box(g['bboxPt'] for g in meaningful),glyphIds=[g['id'] for g in meaningful],visible=True))
                            drawrow.append(printed);rs.append(printed);xx+=colwidths[c]
                        rowstrings.append(''.join(rs).rstrip());offset+=1
                        drawcells.append(drawrow)
                    b['displayText']='\n'.join(rowstrings)
                    table_layouts[bid]=dict(data=drawcells,columnWidths=colwidths,rowHeight=rh,top=t['bbox_pt'][1],left=t['bbox_pt'][0],size=size,kind=kind,spans=spans,ruled=table_info['ruled'])
                else:
                    n=t['budget']['lines'][1] if family['classId']=='E1' and t['id'].startswith('body.') else t['budget']['lines'][0]
                    maxw=t['container_pt'][2]-t['bbox_pt'][0]
                    lines=split_lines(text,n,maxw,kind,size)
                    offset=ordinal=0
                    for i,line in enumerate(lines):
                        gg=glyph_line(bid,line,t['bbox_pt'][0],t['bbox_pt'][1]+i*lead,size,kind,offset,ordinal,t['visible'])
                        glyphs.extend(gg);offset+=len(line)+1;ordinal+=len(gg)
                    b['displayText']='\n'.join(lines)
                    placements[bid]=dict(lines=lines,left=t['bbox_pt'][0],top=t['bbox_pt'][1],size=size,leading=lead,kind=kind)
                if glyphs and t['id'] not in figures:
                    b['bboxPt']=union_box(g['bboxPt'] for g in glyphs if not g['text'].isspace())
                    if t['id'] in tables and tables[t['id']]['ruled']:b['bboxPt']=union_box([b['bboxPt'],t['bbox_pt']])
                    b['bboxNormalized']=normalized(b['bboxPt'])
            if t['id']=='math.rule' and family['classId']=='P':
                b['formula']=equation(*params,b['displayText'],world['unit'])
                if family['layoutId']=='C':
                    for variable in b['formula']['variables']:
                        variable['unit']=variable['unit'].replace('/s','/h') if variable['symbol']==params[0] else 'h' if variable['symbol']==params[2] else variable['unit']
            if t['id'] in formulas:b['formula']=formulas[t['id']]
            if t['id']=='math.constraint':
                b['formula']=dict(display=b['displayText'],latex=f'[{wp["lower"]},{wp["upper"]}] \\pm 0.4',
                                  ast=dict(op='and',args=[dict(op='interval',args=[dict(op='constant',valueDecimal=str(wp['lower'])),dict(op='constant',valueDecimal=str(wp['upper']))]),dict(op='tolerance',args=[dict(op='constant',valueDecimal='0.4')])]),
                                  variables=[],valueDecimal='0.4',absoluteTolerance=.4,
                                  constraints=['lower < upper','absolute tolerance > 0','rounding=ROUND_HALF_UP; decimal_places=1',f'unit={world["unit"]}'])
            if t['id']=='side.image':b['assetHash']=sha(illustration(world['seed']+wp['number']))
            blocks.append(b)
        if wp['number'] in spec['transform_contract']['prototype_page_schedule']['occluded_decoy']:
            bid=pid+'.hidden.decoy';text=f'Archive reference {wp["number"]:02d}-closed'
            top=85.32;size=9;gg=glyph_line(bid,text,35,top,size,'sans',0,0,False)
            block=dict(id=bid,templateId='hidden.decoy',role='decoy',visible=False,bboxPt=union_box(g['bboxPt'] for g in gg),bboxNormalized=normalized(union_box(g['bboxPt'] for g in gg)),containerPt=[35,85.32,213,98],zOrder=1,readingRank=None,displayText=text,glyphs=gg,fonts=[dict(family='Liberation Sans',fileHash=file_hash(FONTS['sans']),sizePt=size,leadingPt=12,weight=400,embedded=True,subset=True)],cells=[],formula=None,chart=None,assetHash=None,semanticClass='decoy')
            blocks.append(block);placements[bid]=dict(lines=[text],left=35,top=top,size=size,leading=12,kind='sans')
            cover=dict(id=pid+'.hidden.cover',templateId='hidden.cover',role='occluder',visible=True,bboxPt=[31,81,217,102],bboxNormalized=normalized([31,81,217,102]),containerPt=[31,81,217,102],zOrder=2,readingRank=None,displayText='',glyphs=[],fonts=[],cells=[],formula=None,chart=None,assetHash=None,semanticClass='decoration')
            blocks.append(cover)
        order=[pid+'.'+i for i in layout['reading_order']];lookup={b['id']:b for b in blocks};ordered=[lookup[i] for i in order]
        texts=[b['displayText'] for b in ordered]
        page=dict(id=pid,number=wp['number'],sizePt=[612,792],layoutContractId=family['classId']+'-'+family['layoutId'],blocks=blocks,readingOrder=order,
                  expectedMarkdown='\n\n'.join(texts),sections=texts,paragraphs=texts,
                  blockIdsForSections=order,blockIdsForParagraphs=order,
                  visibleGlyphCount=sum(len([g for g in b['glyphs'] if g['visible'] and not g['text'].isspace()]) for b in blocks))
        pages.append(page);resolved.append(dict(id=pid,placements=placements,tables=table_layouts,figures=figure_layouts,blocks=copy.deepcopy(blocks)))
    record=freeze(dict(schema='mixed-pdf-authoring@4',familyId=family['familyId'],split=family['split'],classId=family['classId'],layoutId=family['layoutId'],specHash=spec_hash,worldHash=world['worldHash'],producerPath=family['producerPath'],seed=family['worldSeed'],pages=pages),'authoringHash')
    return record,dict(schema='mixed-pdf-layout@4',authoringHash=record['authoringHash'],pages=resolved)


def native_reportlab(authoring,resolved,world,path,only=None,omit=None):
    out=BytesIO();c=canvas.Canvas(out,pagesize=(612,792),pageCompression=1,invariant=1,pdfVersion=(1,7),initialFontName='V4sans')
    c.setTitle(world['title']);c.setAuthor(world['role']);c.setSubject('Inspection record and supporting observations')
    c.setCreator('ReportLab '+__import__('reportlab').Version)
    c._doc.info.producer='ReportLab '+__import__('reportlab').Version
    import calendar,datetime
    from reportlab.lib.utils import TimeStamp
    _epoch=str(calendar.timegm(datetime.datetime.fromisoformat(world['date']+'T08:00:00').timetuple()))
    _old=os.environ.get('SOURCE_DATE_EPOCH');os.environ['SOURCE_DATE_EPOCH']=_epoch
    c._doc._timeStamp=TimeStamp(invariant=False)
    if _old is None:os.environ.pop('SOURCE_DATE_EPOCH',None)
    else:os.environ['SOURCE_DATE_EPOCH']=_old
    for page,r in zip(authoring['pages'],resolved['pages']):
        for b in sorted(page['blocks'],key=lambda b:b['zOrder']):
            bid=b['id']
            if only is not None and b['templateId'] not in only:continue
            if omit and bid in omit:continue
            c._code.append('/V4Block << /ID ('+bid+') >> BDC')
            x0,y0,x1,y1=b['bboxPt'];role=b['role'];c.setFillColorRGB(.08,.1,.12)
            if bid in r.get('figures',{}):
                from fools_gold_v4_figures import reportlab_svg
                figure=r['figures'][bid];reportlab_svg(c,base64.b64decode(figure['svgBase64']),figure['bbox'])
            elif bid in r['tables']:
                t=r['tables'][bid];size=t['size'];kind=t['kind'];rh=t['rowHeight'];asc=METRICS[kind].ascender*size
                table=Table(t['data'],colWidths=t['columnWidths'],rowHeights=[rh]*len(t['data']))
                # Table draws a genuine 5x4 object. Padding locates baseline so
                # occupied glyph support starts at the measured table top.
                table.setStyle(TableStyle([('FONTNAME',(0,0),(-1,-1),'V4'+kind),('FONTSIZE',(0,0),(-1,-1),size),('LEADING',(0,0),(-1,-1),size),('TEXTCOLOR',(0,0),(-1,-1),(.08,.1,.12)),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),rh-asc),('VALIGN',(0,0),(-1,-1),'BOTTOM')]))
                for r0,c0,r1,c1 in t.get('spans',[]):table.setStyle(TableStyle([('SPAN',(c0,r0),(c1,r1))]))
                if t.get('ruled'):table.setStyle(TableStyle([('LINEBELOW',(0,0),(-1,-1),.25,(.4,.45,.5)),('LINEABOVE',(0,0),(-1,0),.25,(.4,.45,.5))]))
                table.wrapOn(c,612,792);table.drawOn(c,t['left'],792-t['top']-rh*len(t['data']))
            elif bid in r['placements']:
                p=r['placements'][bid];c.setFont('V4'+p['kind'],p['size'])
                asc=METRICS[p['kind']].ascender*p['size']
                for i,line in enumerate(p['lines']):c.drawString(p['left'],792-p['top']-asc-i*p['leading'],line)
            elif role in ['panel-background','occluder','decoration','auxiliary-background']:
                if role=='panel-background':c.setFillColorRGB(.93,.95,.965)
                elif role=='occluder':c.setFillColorRGB(1,1,1)
                else:c.setFillColorRGB(.48,.59,.66)
                c.rect(x0,792-y1,x1-x0,y1-y0,fill=1,stroke=0)
            elif role=='text-free-image':
                raw=illustration(world['seed']+page['number']);c.drawImage(ImageReader(BytesIO(raw)),x0,792-y1,x1-x0,y1-y0,mask=None)
            c._code.append('EMC')
        c.showPage()
    c.save();save(path,out.getvalue())


NS='''xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"'''


def text_xml(text):
    # Writer collapses XML spaces. text:s preserves exactly the authored glyphs.
    return ''.join('<text:s/>' if c==' ' else escape(c) for c in text)


def native_writer(authoring,resolved,world,fodt,pdf,only=None,omit=None):
    styles=[];body=[];included_tables=set()
    for page,r in zip(authoring['pages'],resolved['pages']):
        frames=[]
        for b in sorted(page['blocks'],key=lambda b:b['zOrder']):
            bid=b['id'];tid=b['templateId']
            if only is not None and tid not in only:continue
            if omit and bid in omit:continue
            name=bid.replace('.','_');x0,y0,x1,y1=b['containerPt'];kind='sans';size=10;lead=14.7705
            content='';fill='none';color='#edf2f6'
            if bid in r.get('figures',{}):
                figure=r['figures'][bid];x0,y0,x1,y1=figure['bbox'];content='<draw:image xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><office:binary-data>'+figure['svgBase64']+'</office:binary-data></draw:image>'
            elif bid in r['placements'] or bid in r['tables']:
                t=r['placements'].get(bid,r['tables'].get(bid));kind=t['kind'];size=t['size'];lead=t.get('leading',t.get('rowHeight'))
                # Explicit paragraph line box. Writer uses its font ascent plus
                # internal leading; baseline offset is calibrated once below.
                x0=t['left'];y0=t['top']
                # Font metrics in Writer's fixed line-height mode: baseline is
                # ascender + half(extra leading). Remove that extra leading.
                fontheight=(METRICS[kind].ascender-METRICS[kind].descender)*size
                y0-=max(0,(lead-fontheight)/2)
                # Measured on a fresh whole-document Writer calibration: its
                # fixed line box adds 0.18 em to sans and .0175 em to mono.
                y0-=size*(.18 if kind=='sans' else .0175)
                x1=max(x1,x0+max((width(z,kind,size) for z in t.get('lines',[''])),default=1)+2)
                y1=max(y1,y0+lead*len(t.get('lines',t.get('data',[])))+3)
                styles.append(f'<style:style style:name="p_{name}" style:family="paragraph"><style:paragraph-properties fo:margin="0pt" fo:line-height="{lead}pt" fo:padding="0pt" fo:text-align="start"/><style:text-properties style:font-name="{kind}" fo:font-family="Liberation {"Mono" if kind=="mono" else "Sans"}" fo:font-size="{size}pt" fo:color="#14191f" style:letter-kerning="false" fo:hyphenate="false"/></style:style>')
                if bid in r['tables']:
                    included_tables.add(bid)
                    data=t['data'];cw=t['columnWidths'];rh=t['rowHeight']
                    styles.append(f'<style:style style:name="tbl_{name}" style:family="table"><style:table-properties table:align="left" fo:margin="0pt" style:width="{sum(cw)}pt"/></style:style>')
                    styles.append(f'<style:style style:name="cell_{name}" style:family="table-cell"><style:table-cell-properties fo:padding="0pt" fo:border="none" style:vertical-align="top"/></style:style>')
                    styles.append(f'<style:style style:name="row_{name}" style:family="table-row"><style:table-row-properties style:row-height="{rh}pt" style:use-optimal-row-height="false"/></style:style>')
                    cols=[]
                    for j,w in enumerate(cw):
                        styles.append(f'<style:style style:name="col_{name}_{j}" style:family="table-column"><style:table-column-properties style:column-width="{w}pt"/></style:style>');cols.append(f'<table:table-column table:style-name="col_{name}_{j}"/>')
                    rows=[]
                    for row in data:
                        rows.append(f'<table:table-row table:style-name="row_{name}">'+''.join(f'<table:table-cell table:style-name="cell_{name}" office:value-type="string"><text:p text:style-name="p_{name}">{text_xml(value)}</text:p></table:table-cell>' for value in row)+'</table:table-row>')
                    content=f'<table:table table:name="{name}" table:style-name="tbl_{name}">'+''.join(cols+rows)+'</table:table>'
                    # Trailing paragraph required by Writer, kept zero-height.
                    content+='<text:p text:style-name="empty"/>'
                else:content=f'<text:p text:style-name="p_{name}">'+('<text:line-break/>'.join(text_xml(line) for line in t['lines']))+'</text:p>'
            elif b['role']=='text-free-image':
                content='<draw:image xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><office:binary-data>'+base64.b64encode(illustration(world['seed']+page['number'])).decode()+'</office:binary-data></draw:image>'
            elif b['role'] in ['panel-background','occluder','decoration','auxiliary-background']:
                fill='solid';color='#edf2f6' if b['role']=='panel-background' else '#ffffff' if b['role']=='occluder' else '#7a96a8'
                content='<text:p text:style-name="empty"/>'
            else:continue
            styles.append(f'<style:style style:name="fr_{name}" style:family="graphic"><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="page" style:vertical-pos="from-top" style:vertical-rel="page" fo:padding="0pt" fo:border="none" draw:fill="{fill}" draw:fill-color="{color}" draw:stroke="none" fo:background-color="{color if fill=="solid" else "transparent"}"/></style:style>')
            attrs=f'draw:style-name="fr_{name}" draw:name="{name}" text:anchor-type="page" text:anchor-page-number="{page["number"]}" svg:x="{x0}pt" svg:y="{y0}pt" svg:width="{x1-x0}pt" svg:height="{y1-y0}pt" draw:z-index="{b["zOrder"]}"'
            if b['role'] in ['panel-background','occluder','decoration','auxiliary-background']:frames.append('<draw:rect '+attrs+'/>')
            elif b['role']=='text-free-image' or bid in r.get('figures',{}):frames.append('<draw:frame '+attrs+'>'+content+'</draw:frame>')
            else:frames.append('<draw:frame '+attrs+'><draw:text-box>'+content+'</draw:text-box></draw:frame>')
        body.append('<text:p text:style-name="'+('first' if page['number']==1 else 'newpage')+'">'+''.join(frames)+'</text:p>')
    xml='<?xml version="1.0" encoding="UTF-8"?><office:document '+NS+' office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">'
    xml+='<office:meta><dc:title>'+escape(world['title'])+'</dc:title><dc:creator>'+escape(world['role'])+'</dc:creator><meta:creation-date>'+world['date']+'T08:00:00</meta:creation-date><dc:date>'+world['date']+'T08:02:00</dc:date></office:meta>'
    xml+='<office:font-face-decls><style:font-face style:name="sans" svg:font-family="Liberation Sans"/><style:font-face style:name="mono" svg:font-family="Liberation Mono"/></office:font-face-decls>'
    xml+='<office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:margin="0pt"/><style:text-properties style:font-name="sans" fo:font-size="10pt"/></style:default-style></office:styles>'
    xml+='<office:automatic-styles><style:page-layout style:name="letter"><style:page-layout-properties fo:page-width="612pt" fo:page-height="792pt" fo:margin="0pt" style:print-orientation="portrait"/></style:page-layout>'
    xml+='<style:style style:name="empty" style:family="paragraph"><style:paragraph-properties fo:line-height="0.01pt" fo:margin="0pt"/><style:text-properties fo:font-size="0.01pt"/></style:style>'
    xml+='<style:style style:name="first" style:family="paragraph" style:master-page-name="Standard"><style:paragraph-properties fo:line-height="1pt"/></style:style><style:style style:name="newpage" style:family="paragraph" style:master-page-name="Standard"><style:paragraph-properties fo:break-before="page" fo:line-height="1pt"/></style:style>'
    xml+=''.join(styles)+'</office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="letter"/></office:master-styles><office:body><office:text>'+''.join(body)+'</office:text></office:body></office:document>'
    save(fodt,xml)
    profile=Path(tempfile.mkdtemp(prefix='v4-writer-',dir=TEMP_ROOT))
    # SelectPdfVersion=0 is PDF 1.7, not the default 2.0 used by newer Writer.
    pipe='fools_gold_v4_'+sha(str(profile).encode())[:18]
    command=['soffice','-env:UserInstallation='+profile.as_uri(),'--headless','--norestore','--nodefault','--nofirststartwizard','--accept=pipe,name='+pipe+';urp;StarOffice.ServiceManager']
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    odt=fodt.with_suffix('.odt')
    filtered=copy.deepcopy(resolved)
    for page in filtered['pages']:page['tables']={bid:t for bid,t in page['tables'].items() if bid in included_tables}
    payload=dict(pipe=pipe,fodt=str(fodt),odt=str(odt),pdf=str(pdf),layout=filtered,world=world)
    try:
        result=subprocess.run(['/usr/bin/python',str(Path(__file__).with_name('fools_gold_v4_writer.py'))],input=canonical(payload),capture_output=True,timeout=120)
        if result.returncode:raise RuntimeError(result.stdout.decode()+result.stderr.decode())
        if not pdf.exists():raise RuntimeError('Writer export produced no PDF')
    finally:
        if process.poll() is None:process.terminate()
        process.communicate(timeout=15)
    # Disposable profile only; editable/native artifacts remain durable.
    import shutil
    shutil.rmtree(profile)
    return dict(command=[str(x) for x in command],stdout=result.stdout.decode(),editableOdt=str(odt),exportProfile=dict(SelectPdfVersion=0,UseTaggedPDF=False,ExportBookmarks=False,ExportNotes=False))


def render_native(authoring,resolved,world,directory,name='native',only=None,omit=None):
    directory=Path(directory);pdf=directory/(name+'.pdf')
    if pdf.exists():raise FileExistsError(pdf)
    directory.mkdir(parents=True,exist_ok=True)
    if authoring['producerPath']=='reportlab-full':
        native_reportlab(authoring,resolved,world,pdf,only,omit)
        return dict(pdf=pdf,producer='ReportLab',version=__import__('reportlab').Version,command=['reportlab.pdfgen.canvas'],editable=None)
    fodt=directory/(name+'.fodt')
    proof=native_writer(authoring,resolved,world,fodt,pdf,only,omit)
    return dict(pdf=pdf,producer='LibreOffice Writer',version=run(['soffice','--version']).stdout.decode().strip(),editable=fodt,**proof)
