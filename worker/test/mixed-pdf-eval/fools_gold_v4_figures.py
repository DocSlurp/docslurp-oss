"""New vector figures from plotted data/mathtext, with pre-export glyph maps.

No external SVG is accepted: the restricted renderer consumes only the SVG
bytes generated here by matplotlib, and rejects unknown graphics operations.
"""
from io import BytesIO
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import numpy as np

from fools_gold_v4_common import *


def mpl():
    import matplotlib
    matplotlib.use('Agg')
    matplotlib.rcParams.update({'font.family':'Liberation Sans','svg.fonttype':'path','pdf.fonttype':42,
        'mathtext.fontset':'custom','mathtext.rm':'Liberation Sans','mathtext.it':'Liberation Sans','mathtext.bf':'Liberation Sans','mathtext.cal':'Liberation Sans','mathtext.fallback':None,'svg.hashsalt':'fools-gold-v4'})
    from matplotlib.figure import Figure
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    return Figure,FigureCanvasAgg


def chart_asset(chart,bbox,block_id,fonts):
    Figure,Canvas=mpl();w=bbox[2]-bbox[0];h=bbox[3]-bbox[1]
    fig=Figure(figsize=(w/72,h/72),dpi=72);Canvas(fig);ax=fig.add_axes([.16,.23,.79,.57])
    colors=['#284b63','#8d6548']
    for i,series in enumerate(chart['data']):ax.plot([float(v) for v in series['xDecimals']],[float(v) for v in series['yDecimals']],label=series['name'],color=colors[i],linewidth=.85,marker='o',markersize=1.5)
    ax.set_title(chart['title'],fontsize=8,pad=3);ax.set_xlabel(chart['axisTitles'][0],fontsize=8,labelpad=1);ax.set_ylabel(chart['axisTitles'][1],fontsize=8,labelpad=1)
    ax.set_xticks(range(1,9));ax.set_yticks([0,25,50,75,100]);ax.set_ylim(0,100);ax.tick_params(labelsize=7.5,pad=1,length=2)
    legend=ax.legend(fontsize=7.5,loc='upper left',ncol=2,frameon=False)
    fig.canvas.draw();renderer=fig.canvas.get_renderer();labels=[]
    elements=[('title',ax.title),('axis-x',ax.xaxis.label),('axis-y',ax.yaxis.label)]
    elements +=[(f'tick-x-{i}',t) for i,t in enumerate(ax.get_xticklabels())]
    elements +=[(f'tick-y-{i}',t) for i,t in enumerate(ax.get_yticklabels())]
    elements +=[(f'legend-{i}',t) for i,t in enumerate(legend.get_texts())]
    for name,text in elements:
        bb=text.get_window_extent(renderer);box=[bbox[0]+bb.x0,bbox[1]+h-bb.y1,bbox[0]+bb.x1,bbox[1]+h-bb.y0]
        labels.append(dict(id=name,text=text.get_text(),bbox=box,size=text.get_fontsize(),rotation=text.get_rotation()))
    out=BytesIO();fig.savefig(out,format='svg',metadata={'Date':None,'Creator':'matplotlib'})
    return out.getvalue(),labels


def math_asset(latex,bbox):
    """MathTextParser gives actual glyph positions, subscripts and fraction bars."""
    Figure,Canvas=mpl()
    from matplotlib.mathtext import MathTextParser
    from matplotlib.font_manager import FontProperties
    result=MathTextParser('path').parse('$'+latex+'$',dpi=72,prop=FontProperties(family='Liberation Sans',size=9))
    width,height,depth,glyphs,rects=result
    framew=bbox[2]-bbox[0];frameh=bbox[3]-bbox[1]
    if width>framew or height>frameh:raise ValueError('Rich formula exceeds its frozen 24 pt frame')
    fig=Figure(figsize=(framew/72,frameh/72),dpi=72);Canvas(fig)
    # A complete equation asset; all positions come from the math layout engine.
    baseline=frameh-height+depth
    labels=[]
    for i,(font,size,cp,x,y) in enumerate(glyphs):
        # Preserve real size/position, including subscript reductions. Logical
        # labels use the printed digit; AST variable bindings live in constraints.
        fontpath=Path(font.fname);up=font.units_per_EM;asc=font.ascender/up;desc=font.descender/up
        adv=font.get_char_index(cp)
        font.set_size(size,72);gl=font.load_char(cp)
        advance=gl.linearHoriAdvance/65536
        top=bbox[1]+height-depth-y-asc*size
        labels.append(dict(text=chr(cp),bbox=[bbox[0]+x,top,bbox[0]+x+max(.01,advance),top+(asc-desc)*size],size=size,fontHash=file_hash(fontpath),fontFamily='Liberation Sans',rotation=0))
    for x,y,w,h in rects:
        top=bbox[1]+height-depth-y-h
        labels.append(dict(text='―',bbox=[bbox[0]+x,top,bbox[0]+x+w,top+h],size=9,fontHash=file_hash(font_paths()['sans']),fontFamily='Liberation Sans',rotation=0))
    offset=max(0,bbox[1]-min(label['bbox'][1] for label in labels))
    for label in labels:label['bbox'][1]+=offset;label['bbox'][3]+=offset
    if max(label['bbox'][3] for label in labels)>bbox[3]:raise ValueError('Math glyph support exceeds reserved frame')
    fig.text(0,(baseline-offset)/frameh,'$'+latex+'$',fontfamily='Liberation Sans',fontsize=9)
    out=BytesIO();fig.savefig(out,format='svg',metadata={'Date':None,'Creator':'matplotlib'})
    return out.getvalue(),labels


def reportlab_svg(canvas,raw,box):
    from fontTools.pens.basePen import BasePen
    from fontTools.svgLib.path import parse_path
    from reportlab.lib.colors import toColor
    root=ET.fromstring(raw);defs={e.get('id'):e for e in root.iter() if e.get('id')};vb=[float(x) for x in root.get('viewBox').split()]
    class Pen(BasePen):
        def __init__(self):super().__init__(None);self.path=canvas.beginPath()
        def _moveTo(self,p):self.path.moveTo(*p)
        def _lineTo(self,p):self.path.lineTo(*p)
        def _curveToOne(self,a,b,c):self.path.curveTo(*a,*b,*c)
        def _closePath(self):self.path.close()
        def _endPath(self):pass
    def transform(value):
        for kind,args in re.findall(r'([A-Za-z]+)\(([^)]*)\)',value):
            v=[float(x) for x in re.split('[ ,]+',args.strip()) if x]
            if kind=='translate':canvas.translate(v[0],v[1] if len(v)>1 else 0)
            elif kind=='scale':canvas.scale(v[0],v[1] if len(v)>1 else v[0])
            elif kind=='rotate':canvas.rotate(v[0])
            elif kind=='matrix':canvas.transform(*v)
            else:raise ValueError('Unknown generated SVG transform '+kind)
    def draw(e,inherited):
        tag=e.tag.split('}')[-1]
        if tag in ['defs','metadata','title','desc','clipPath']:return
        style=dict(inherited)
        for item in e.get('style','').split(';'):
            if ':' in item:
                k,v=item.split(':',1);style[k.strip()]=v.strip()
        canvas.saveState();transform(e.get('transform',''))
        if tag=='use':
            canvas.translate(float(e.get('x',0)),float(e.get('y',0)))
            ref=e.get('{http://www.w3.org/1999/xlink}href',e.get('href',''))
            if not ref.startswith('#') or ref[1:] not in defs:raise ValueError('External/missing generated SVG reference')
            draw(defs[ref[1:]],style)
        elif tag=='path':
            p=Pen();parse_path(e.get('d',''),p)
            fill=style.get('fill','#000000');stroke=style.get('stroke','none')
            if fill!='none':canvas.setFillColor(toColor(fill))
            if stroke!='none':canvas.setStrokeColor(toColor(stroke));canvas.setLineWidth(float(style.get('stroke-width','1')))
            canvas.drawPath(p.path,fill=int(fill!='none'),stroke=int(stroke!='none'))
        elif tag in ['svg','g']:
            for child in e:draw(child,style)
        else:raise ValueError('Unsupported generated SVG element '+tag)
        canvas.restoreState()
    canvas.saveState();canvas.translate(box[0],792-box[1]);canvas.scale((box[2]-box[0])/vb[2],-(box[3]-box[1])/vb[3]);draw(root,{});canvas.restoreState()
