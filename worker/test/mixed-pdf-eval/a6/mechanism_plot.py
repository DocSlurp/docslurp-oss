"""One independent backend control, not an E candidate or acceptance witness."""
from pathlib import Path
import sys
from io import BytesIO
import pymupdf as fitz
from reportlab.pdfgen.canvas import Canvas
from reportlab_native import draw_plot,plot_figure
from contract import save,FONTS


def main(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    data=[dict(name='Left',xDecimals=[str(i) for i in range(1,9)],yDecimals=[str(y) for y in [11,12,14,13,16,15,17,18]],unitX='s',unitY='mg'),
          dict(name='Right',xDecimals=[str(i) for i in range(1,9)],yDecimals=[str(y) for y in [13,15,13,16,14,18,17,19]],unitX='s',unitY='mg')]
    # The producer's numeric transforms select y=10..20 from these independent data.
    paths=[[100+i*400/7,500,100+i*400/7,503] for i in range(8)]
    paths += [[97,500-i*50,100,500-i*50] for i in range(5)]
    paths += [[100,300,100,500],[100,500,500,500]]
    for series in range(2):
        paths += [[110+series*150,280,120+series*150,280]]
        points=[(100+i*400/7,500-(float(y)-10)*20) for i,y in enumerate(data[series]['yDecimals'])]
        paths += [[*a,*b] for a,b in zip(points,points[1:])]
    runs=[('Hgj +-= 123.45',110,270,'sans',8,0),('Mass (mg)',80,440,'sans',8,270)]
    block=dict(containerPt=[60,250,520,540],chart=dict(data=data))
    real=dict(paths=paths,runs=runs)
    fig=plot_figure(block,real);fig.savefig(out/'plot.svg',format='svg',metadata={'Date':None});fig.clear()
    buffer=BytesIO();canvas=Canvas(buffer,pagesize=(612,792),invariant=1,pdfVersion=(1,7));draw_plot(canvas,block,real);canvas.showPage();canvas.save()
    save(out/'reportlab.pdf',buffer.getvalue())
    with fitz.open(out/'reportlab.pdf') as doc:
        page=doc[0];print('actual text traces',[(t['font'],t['size'],t['chars'][0][2]) for t in page.get_texttrace()])
        print('native segments',sum(i[0]=='l' for d in page.get_drawings() for i in d['items']))
        page.get_pixmap(dpi=150).save(out/'page.png')
    save(out/'expected.json',dict(kind='independent-backend-control-only',textRuns=runs,paths=paths))


if __name__=='__main__':main(sys.argv[1])
