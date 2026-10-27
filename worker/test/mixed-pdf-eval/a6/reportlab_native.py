"""Complete ReportLab documents; real Table objects and Matplotlib plots."""
from __future__ import annotations
from io import BytesIO
import math
from pathlib import Path
import numpy as np
from PIL import Image
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Table, TableStyle
from reportlab.lib.utils import ImageReader
from contract import FONTS, digest, save

INK=[.08,.1,.12]
SERIES=[[.18,.32,.48],[.48,.34,.26]]
for kind,font in FONTS.items():pdfmetrics.registerFont(TTFont('A6-'+kind,str(font.path)))


class NativeTable(Table):
    """Table's native span/grid engine with an explicit font-derived baseline."""
    def _drawCell(self,cellval,cellstyle,pos,size):
        x,y=pos;w,h=size
        self.canv.setFillColorRGB(*INK)
        self.canv.setFont(self._a6Font,self._a6Size)
        self.canv.drawString(x+self._a6Padding,y+h-FONTS[self._a6Kind].asc*self._a6Size,str(cellval))


def draw_table(canvas,block,real):
    t=real['table'];kind='mono' if block['templateId']=='matrix.table' else 'sans';size=block['fonts'][0]['sizePt']
    table=NativeTable(t['data'],colWidths=t['widths'],rowHeights=[t['rowHeight']]*len(t['data']))
    table._a6Font='A6-'+kind;table._a6Kind=kind;table._a6Size=size;table._a6Padding=t['padding']
    styles=[('LEFTPADDING',(0,0),(-1,-1),t['padding']),('RIGHTPADDING',(0,0),(-1,-1),0),
            ('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),0)]
    for r0,c0,r1,c1 in t['spans']:styles.append(('SPAN',(c0,r0),(c1,r1)))
    if t['ruled']:styles.append(('GRID',(0,0),(-1,-1),.3,(.35,.4,.45)))
    table.setStyle(TableStyle(styles));table.wrapOn(canvas,612,792)
    box=block['containerPt'];table.drawOn(canvas,box[0],792-box[1]-len(t['data'])*t['rowHeight'])


def plot_figure(block,real):
    import matplotlib
    matplotlib.use('Agg')
    matplotlib.rcParams['svg.fonttype']='none'
    from matplotlib.figure import Figure
    from matplotlib.lines import Line2D
    from matplotlib.font_manager import FontProperties
    box=block['containerPt'];x0,y0,x1,y1=box;w=x1-x0;h=y1-y0
    fig=Figure(figsize=(w/72,h/72),dpi=72,facecolor='none')
    # The first two non-tick paths in the frozen scene are x/y axes.
    paths=real['paths'];px0,py0,px1,py1=paths[13][0],paths[13][1],paths[14][2],paths[13][3]
    ax=fig.add_axes([(px0-x0)/w,(y1-py1)/h,(px1-px0)/w,(py1-py0)/h])
    all_y=[float(v) for s in block['chart']['data'] for v in s['yDecimals']]
    ax.set_xlim(1,8);ax.set_ylim(math.floor(min(all_y))-1,math.ceil(max(all_y))+1);ax.set_axis_off()
    for i,s in enumerate(block['chart']['data']):
        ax.plot([float(x) for x in s['xDecimals']],[float(y) for y in s['yDecimals']],color=SERIES[i],linewidth=.65)
    for i,p in enumerate(paths[:16]+[paths[23]]):
        # Tick/axis paths plus the two proper series-associated legend swatches.
        color=SERIES[0] if i==15 else SERIES[1] if i==16 else INK
        fig.add_artist(Line2D([(p[0]-x0)/w,(p[2]-x0)/w],[(y1-p[1])/h,(y1-p[3])/h],transform=fig.transFigure,color=color,linewidth=.5))
    for text,x,y,kind,size,rot in real['runs']:
        fig.text((x-x0)/w,(y1-y)/h,text,ha='left',va='baseline',rotation=(-rot)%360,rotation_mode='anchor',
            fontproperties=FontProperties(fname=str(FONTS[kind].path),size=size),color=INK)
    return fig


def draw_plot(canvas,block,real):
    """Minimal Matplotlib backend into the owning ReportLab canvas."""
    from matplotlib.backend_bases import RendererBase
    from matplotlib.path import Path as MplPath
    class Renderer(RendererBase):
        def flipy(self):return False
        def points_to_pixels(self,points):return points
        def get_canvas_width_height(self):return (block['containerPt'][2]-block['containerPt'][0],block['containerPt'][3]-block['containerPt'][1])
        def get_text_width_height_descent(self,s,prop,ismath):
            size=prop.get_size_in_points();font=FONTS['sans']
            return font.width(s,size),(font.asc-font.desc)*size,-font.desc*size
        def draw_path(self,gc,path,transform,rgbFace=None):
            p=canvas.beginPath();last=(0,0)
            for vertices,code in path.iter_segments(transform,curves=True):
                if code==MplPath.MOVETO:p.moveTo(*vertices);last=tuple(vertices)
                elif code==MplPath.LINETO:p.lineTo(*vertices);last=tuple(vertices)
                elif code==MplPath.CURVE4:p.curveTo(*vertices);last=tuple(vertices[-2:])
                elif code==MplPath.CURVE3:
                    a,b,x,y=vertices;u,v=last
                    p.curveTo(u+2*(a-u)/3,v+2*(b-v)/3,x+2*(a-x)/3,y+2*(b-y)/3,x,y);last=(x,y)
                elif code==MplPath.CLOSEPOLY:p.close()
            canvas.saveState();canvas.setLineWidth(gc.get_linewidth());canvas.setStrokeColorRGB(*gc.get_rgb()[:3])
            if rgbFace:canvas.setFillColorRGB(*rgbFace[:3])
            canvas.drawPath(p,stroke=gc.get_linewidth()>0,fill=rgbFace is not None and (len(rgbFace)<4 or rgbFace[3]>0));canvas.restoreState()
        def draw_text(self,gc,x,y,s,prop,angle,ismath=False,mtext=None):
            canvas.saveState();canvas.setFillColorRGB(*gc.get_rgb()[:3]);canvas.setFont('A6-sans',prop.get_size_in_points())
            canvas.translate(x,y);canvas.rotate(angle);canvas.drawString(0,0,s);canvas.restoreState()
    box=block['containerPt'];canvas.saveState();canvas.translate(box[0],792-box[3])
    fig=plot_figure(block,real);fig.draw(Renderer());fig.clear();canvas.restoreState()


def side_pixels(fid,pnum):
    rng=np.random.default_rng(fid*1000+pnum)
    y,x=np.indices((120,160));noise=rng.integers(0,48,(120,160,3))
    pixels=np.stack([(x*3+y*2)%160+25,(x+y*3)%150+35,(x*2-y)%170+20],axis=-1)
    return np.uint8(np.clip(pixels+noise,0,255))


def build(authoring,scenes,target,permuted=False):
    from contract import paint_order
    out=BytesIO();c=Canvas(out,pagesize=(612,792),invariant=1,pdfVersion=(1,7),pageCompression=1)
    c.setTitle(authoring['pages'][0]['blocks'][0]['displayText']);c.setAuthor('Operations records')
    for ap,scene in zip(authoring['pages'],scenes):
        lookup={b['id']:b for b in ap['blocks']};_,order=paint_order(ap['blocks'],authoring['familyId'],ap['number'],permuted)
        for bid in order:
            b=lookup[bid];real=scene['resolved'][bid];tid=b['templateId'];box=b['containerPt']
            c._code.append('/A6 << /ID ('+bid+') >> BDC')
            c.saveState()
            if tid in ['discussion.frame','overlay.card','overlay.cover']:
                c.setFillColorRGB(*([.88,.89,.9] if tid=='overlay.cover' else [.96,.97,.98]))
                c.setStrokeColorRGB(.35,.4,.45);c.setLineWidth(.5)
                c.rect(box[0],792-box[3],box[2]-box[0],box[3]-box[1],stroke=int(tid=='discussion.frame'),fill=1)
            elif tid=='footer.ornament':
                c.setStrokeColorRGB(.2,.4,.5);c.setLineWidth(.8)
                for i in range(9):
                    y=[770,768,766][i%3];x=60+i*45;c.line(x,792-y,x+30,792-y-5)
            elif tid=='side.image':
                c.drawImage(ImageReader(Image.fromarray(side_pixels(authoring['familyId'],ap['number']))),box[0],792-box[3],width=box[2]-box[0],height=box[3]-box[1])
            elif real['table']:draw_table(c,b,real)
            elif b['chart']:draw_plot(c,b,real)
            else:
                c.setFillColorRGB(*INK)
                for text,x,y,font,size,rot in real['runs']:
                    c.saveState();c.setFont('A6-'+font,size);c.translate(x,792-y);c.rotate(-rot);c.drawString(0,0,text);c.restoreState()
                c.setStrokeColorRGB(*INK);c.setLineWidth(.5)
                for x,y,xx,yy in real['paths']:c.line(x,792-y,xx,792-yy)
            c.restoreState();c._code.append('EMC')
        c.showPage()
    c.save();save(target,out.getvalue())
    return dict(owner='ReportLab complete document',sha256=digest(out.getvalue()),permuted=permuted)
