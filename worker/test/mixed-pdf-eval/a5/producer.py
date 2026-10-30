"""Complete ReportLab E exporter; Writer counterpart owns its full document."""
import base64
from io import BytesIO
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as ReportLabTTFont
from reportlab.platypus import Table,TableStyle
from reportlab.lib.utils import ImageReader
from support import *


def reportlab_export(authoring,resolved,world,path,orders=None,omit=()):
    for kind,font in FONTS.items():
        rr=ReportLabTTFont('A5'+kind,str(font.path))
        rr.face.ascent=font.asc*1000;rr.face.descent=font.desc*1000
        pdfmetrics.registerFont(rr)
    out=BytesIO();c=canvas.Canvas(out,pagesize=(612,792),pageCompression=1,invariant=1,pdfVersion=(1,7),initialFontName='A5sans')
    import reportlab
    c.setCreator('ReportLab '+reportlab.Version);c._doc.info.producer='ReportLab '+reportlab.Version
    c.setTitle(world['title']);c.setAuthor(world['role']);c.setSubject('Operating observations and materials review')
    # The reproducible clock belongs to this newly authored family.
    import calendar,datetime
    from reportlab.lib.utils import TimeStamp
    previous=os.environ.get('SOURCE_DATE_EPOCH');os.environ['SOURCE_DATE_EPOCH']=str(calendar.timegm(datetime.datetime.fromisoformat(world['date']+'T08:00:00').timetuple()))
    c._doc._timeStamp=TimeStamp(invariant=False)
    if previous is None:os.environ.pop('SOURCE_DATE_EPOCH',None)
    else:os.environ['SOURCE_DATE_EPOCH']=previous
    for index,(page,r) in enumerate(zip(authoring['pages'],resolved['pages'])):
        lookup={b['id']:b for b in page['blocks']}
        order=orders[index] if orders else r['paintOrder']
        for bid in order:
            b=lookup[bid]
            if bid in omit:continue
            c._code.append('/A5Block << /ID ('+bid+') >> BDC')
            c.setFillColorRGB(.08,.1,.12);box=b['containerPt']
            if bid in r['tables']:
                t=r['tables'][bid];font=FONTS[t['kind']];rh=t['rowHeight'];size=t['size']
                table=Table(t['data'],colWidths=t['columnWidths'],rowHeights=[rh]*len(t['data']))
                table.setStyle(TableStyle([('FONTNAME',(0,0),(-1,-1),'A5'+t['kind']),('FONTSIZE',(0,0),(-1,-1),size),('LEADING',(0,0),(-1,-1),size),
                    ('TEXTCOLOR',(0,0),(-1,-1),(.08,.1,.12)),('LEFTPADDING',(0,0),(-1,-1),t['padding']),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),rh-font.asc*size),('VALIGN',(0,0),(-1,-1),'BOTTOM')]))
                for a,d,b,e in t['spans']:table.setStyle(TableStyle([('SPAN',(d,a),(e,b))]))
                if t['ruled']:
                    table.setStyle(TableStyle([('LINEBELOW',(0,0),(-1,-1),.25,(.4,.45,.5)),('LINEABOVE',(0,0),(-1,0),.25,(.4,.45,.5))]))
                table.wrapOn(c,612,792);table.drawOn(c,t['left'],792-t['top']-rh*len(t['data']))
            elif bid in r['draw']:
                d=r['draw'][bid]
                if d.get('plotSvg'):
                    # This source-blind generic renderer only consumes our own
                    # matplotlib paths; labels are native font text below.
                    import sys
                    sys.path.insert(0,str(CLEAN/'runtime'))
                    from fools_gold_v4_figures import reportlab_svg
                    reportlab_svg(c,base64.b64decode(d['plotSvg']),d['box'])
                for literal,x,y,kind,size,rotation in d['runs']:
                    c.saveState();c.setFont('A5'+kind,size);c.translate(x,792-y);c.rotate(-rotation);c.drawString(0,0,literal);c.restoreState()
                c.setStrokeColorRGB(.08,.1,.12);c.setLineWidth(.3)
                for x,y,a,b in d['paths']:c.line(x,792-y,a,792-b)
                for line,color in d.get('coloredPaths',[]):
                    from reportlab.lib.colors import HexColor
                    c.setStrokeColor(HexColor(color));c.setLineWidth(.85);x,y,a,b=line;c.line(x,792-y,a,792-b)
            elif b['role']=='text-free-image':
                import sys
                sys.path.insert(0,str(CLEAN/'runtime'))
                from fools_gold_v4_native import illustration
                c.drawImage(ImageReader(BytesIO(illustration(world['seed']+page['number']))),box[0],792-box[3],box[2]-box[0],box[3]-box[1])
            else:
                color=(.88,.89,.9) if b['templateId']=='overlay.cover' else (1,1,1) if b['role']=='occluder' else (.93,.95,.965) if b['role']=='panel-background' else (.84,.875,.9) if b['role']=='auxiliary-panel' else (.48,.59,.66)
                c.setFillColorRGB(*color);c.rect(box[0],792-box[3],box[2]-box[0],box[3]-box[1],fill=1,stroke=0)
            c._code.append('EMC')
        c.showPage()
    c.save();save(path,out.getvalue())


def export(authoring,resolved,world,directory,name='native',orders=None,omit=()):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);pdf=directory/(name+'.pdf')
    assert not pdf.exists(),pdf
    if authoring['producerPath']=='reportlab-full':
        reportlab_export(authoring,resolved,world,pdf,orders,omit)
        return dict(path=str(pdf),owner='ReportLab',pages=len(authoring['pages']),complete=True)
    from producer_writer import native_writer
    import copy
    rr=copy.deepcopy(resolved)
    if orders:
        for r,order in zip(rr['pages'],orders):r['paintOrder']=order
    original=directory/(name+'.writer-export.pdf')
    proof=native_writer(authoring,rr,world,directory/(name+'.fodt'),original,omit=set(omit))
    # Writer's native export has a separate immutable history entry. This E-only
    # structural step owns no layout and never uses ReportLab fragments.
    from stream_order import reorder_writer
    filtered=copy.deepcopy(authoring)
    for page in filtered['pages']:page['blocks']=[b for b in page['blocks'] if b['id'] not in omit]
    for page in rr['pages']:page['paintOrder']=[bid for bid in page['paintOrder'] if bid not in omit]
    stream_proof=reorder_writer(original,pdf,filtered,rr)
    return dict(path=str(pdf),owner='LibreOffice Writer',pages=len(authoring['pages']),complete=True,nativeStreamRewrite=stream_proof,**proof)
