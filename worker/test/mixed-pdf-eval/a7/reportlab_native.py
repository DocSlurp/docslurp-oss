"""Complete independent ReportLab realization of a frozen preview page."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Table, TableStyle, Flowable

FONTS = {'sans':('/usr/share/fonts/liberation/LiberationSans-Regular.ttf',.9052734375),
         'mono':('/usr/share/fonts/liberation/LiberationMono-Regular.ttf',.83251953125)}
for kind,(path,_) in FONTS.items(): pdfmetrics.registerFont(TTFont('Pinned'+kind,path))

class NativeCell(Flowable):
    def __init__(self,text,size,width,height):
        super().__init__();self.text=text;self.size=size;self.width=width;self.height=height
    def draw(self):
        self.canv.setFont('Pinnedmono',self.size)
        self.canv.drawString(0,self.height-FONTS['mono'][1]*self.size,self.text)

def table(c,obj,support):
    # Table owns real cells/spans; this is not a string grid facade.
    box=support['containerPt'];data=[]
    for row in obj['data']:
        data.append([NativeCell(v,obj['sizePt'],obj['columnWidthsPt'][i]-obj['paddingPt'],obj['rowHeightPt'])
                     for i,v in enumerate(row)])
    native=Table(data,colWidths=obj['columnWidthsPt'],rowHeights=[obj['rowHeightPt']]*len(data))
    commands=[('LEFTPADDING',(0,0),(-1,-1),obj['paddingPt']),('RIGHTPADDING',(0,0),(-1,-1),0),
              ('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),0),
              ('VALIGN',(0,0),(-1,-1),'TOP'),('TEXTCOLOR',(0,0),(-1,-1),tuple(obj['color']))]
    if obj['span']:commands.append(('SPAN',(1,0),(2,0)))
    if obj['rules']:
        for row in range(len(data)):commands.append(('LINEABOVE',(0,row),(-1,row),.35,(.66,.71,.75)))
        commands.append(('LINEBELOW',(0,-1),(-1,-1),.35,(.66,.71,.75)))
    native.setStyle(TableStyle(commands));native.wrapOn(c,612,792)
    native.drawOn(c,box[0],792-box[1]-obj['rowHeightPt']*len(data))

def export(plan,support,path):
    assert not Path(path).exists()
    c=canvas.Canvas(str(path),pagesize=(612,792),pdfVersion=(1,7),pageCompression=1)
    c.setTitle(plan['title']);c.setAuthor(plan['author']);c.setSubject('Measurement basis and engineering interpretation')
    leaves={l['id']:l for l in support['leaves']}
    for obj in sorted(plan['objects'],key=lambda o:(o.get('z',20),o['id'])):
        c.saveState()
        if obj['kind']=='text':
            c.setFillColorRGB(*obj['color']);c.setFont('Pinned'+obj['font'],obj['sizePt'])
            x,y=obj['baselinePt']
            if obj.get('rotation'):
                c.translate(x,792-y);c.rotate(-obj['rotation']);c.drawString(0,0,obj['text'])
            elif obj.get('spans'):
                for span in obj['spans']:
                    c.drawString(x,792-y-span.get('dyPt',0),span['text'])
                    x+=pdfmetrics.stringWidth(span['text'],'Pinned'+obj['font'],obj['sizePt'])
            else:
                for i,line in enumerate(obj['text'].split('\n')):c.drawString(x,792-y-i*obj['leadingPt'],line)
        elif obj['kind']=='table':
            c.setFillColorRGB(*obj['color']);table(c,obj,leaves[obj['id']])
        elif obj['kind']=='rect':
            x,y,r,b=obj['rectPt'];c.setFillColorRGB(*obj['fill']);c.rect(x,792-b,r-x,b-y,fill=1,stroke=0)
        else:
            c.setStrokeColorRGB(*obj['color']);c.setLineWidth(obj['widthPt'])
            p=c.beginPath()
            for i,(x,y) in enumerate(obj['pointsPt']):
                if i:p.lineTo(x,792-y)
                else:p.moveTo(x,792-y)
            c.drawPath(p,stroke=1,fill=0)
        c.restoreState()
    c.showPage();c.save()
