#!/usr/bin/env python3
"""Build source-free mixed-document training prototypes or an approved corpus."""
import argparse
import hashlib
import html
import io
import json
import os
import random
import shutil
import subprocess
import tempfile
from pathlib import Path

import fitz
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.font_manager import FontProperties
from matplotlib.path import Path as MplPath
from matplotlib.textpath import TextPath
from PIL import Image, ImageEnhance, ImageFilter
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / 'docs/evals/mixed-pdf-yield-v1/fools-gold-spec.md'
W, H = 612, 792
FONT_DIR = Path('/usr/share/fonts/noto')
for name, filename in [('NotoSans', 'NotoSans-Regular.ttf'), ('NotoSerif', 'NotoSerif-Regular.ttf'), ('NotoMono', 'NotoSansMono-Regular.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / filename)))


def enc(x):
    return (json.dumps(x, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def sha(x):
    return hashlib.sha256(x).hexdigest()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f:
        f.write(data)


def split_for(f):
    return 'train' if f < 54 else 'tune' if f < 72 else 'heldout'


def model(f, p):
    layouts = ['single-column', 'two-column', 'side-panel-chart']
    topics = ['Valve inspection', 'Thermal control', 'Signal verification', 'Pump maintenance', 'Filter replacement', 'Storage assessment', 'Cable inspection', 'Pressure review', 'Flow assessment', 'Bearing inspection', 'Energy review', 'Instrument verification', 'Air handling', 'Material inspection', 'Control testing', 'Drainage review', 'Seal assessment', 'Equipment scheduling']
    slot = {6: 7, 7: 6, 12: 14, 14: 12}.get(f % 18, f % 18)
    layout = layouts[slot % 3]
    topic = topics[f % len(topics)]
    station = 11 + (f * 7 + p * 3) % 79
    low = 32 + (f + p) % 12
    readings = [low + 3, low + 5, low + 6, low + 8]
    title = f'{topic} at station {station}'
    subtitle = f'Operations engineering | Review cycle {2021 + (f + p) % 5}'
    bodies = [
        f'The operating team reviewed station {station} during the scheduled inspection interval. '
        f'The first reading was {readings[0]} units and the final reading was {readings[-1]} units. '
        'Both values remained within the control range recorded for this review. The team kept '
        'the existing setting because the observed movement was gradual and the indicator returned '
        'to its baseline after the check. The shift log records the measurement position and the '
        'time of the observation so that the next inspection can use the same procedure.',
        'The decision depends on repeating the measurement under comparable conditions. '
        'Changes in ambient temperature, loading or instrument position can alter a local reading, '
        'so the next operator should record those conditions beside the result. If a later value '
        'exceeds the stated range, the affected section should be isolated and the instrument '
        'checked before an adjustment is made. The engineer will compare the paired records '
        'at the next planned stop and document any change to the operating setting.'
    ]
    if f % 18 in (6, 7):
        bodies = [
            f'The control review for station {station} compares four measurements taken during a single operating interval. '
            f'The reading increased from {readings[0]} to {readings[-1]} units while the equipment remained in its usual configuration. '
            'The gradual change did not cross the upper control bound, and the indicator returned to its baseline when the interval ended. '
            'The team therefore retained the present setting and recorded the measurement position, instrument and operating conditions for the next inspection.',
            'A repeat observation is needed before the trend is treated as evidence of a persistent change. '
            'The next shift should use the same measurement point and record both the surrounding temperature and the equipment load. '
            'If the result is outside the stated range, the operator should isolate the affected section and verify the instrument before changing the control setting. '
            'The engineer will compare the two records at the planned stop and document the decision in the shift log.'
        ]
    elif f % 18 in (12, 14):
        bodies = [
            f'The inspection at station {station} examined whether the current operating arrangement could remain in service until the next planned stop. '
            f'Four readings ranged from {readings[0]} to {readings[-1]} units, all inside the recorded control limits. '
            'The local indicator returned to its baseline after the sequence, and no immediate adjustment was needed. '
            'The inspection notes retain the position of the instrument and the conditions during the check so the observation can be repeated.',
            'The assessment is conditional on a follow-up under comparable loading. A later reading should be reviewed with the original interval, '
            'rather than compared with a single value taken at an unknown position. If the control range is exceeded, the operator should isolate '
            'the affected section and check the instrument before making any change. The responsible engineer will examine both records together '
            'and either close the action or document a revised operating setting.'
        ]
    inset = (f'The log for station {station} records a completed local check and a return to baseline. '
             'The operator used the marked measurement position and retained the initial and final '
             'values with the shift notes. The next inspection will repeat the same sequence before '
             'the engineer reviews the trend and closes the action.')
    comment = ('The record connects the decision with a repeatable observation. The next reading '
               'should be compared with the interval shown above, rather than interpreted without '
               'the accompanying operating conditions.')
    rows = [['Interval', 'Reading', 'Lower', 'Upper']] + [[str(i+1), str(v), str(low), str(low+12)] for i,v in enumerate(readings)]
    formula = f'r_1 = (a + b) / 2;  {low} <= r_1 <= {low+12}\n   a   b   r\n  {low+2:02d}  {low+4:02d}  {low+3:02d}\n  {low+6:02d}  {low+8:02d}  {low+7:02d}'
    chart = {'title': 'Inspection trend', 'xLabel': 'Interval', 'yLabel': 'Reading (units)',
             'xTicks': ['1', '2', '3', '4'], 'yTicks': [str(low),str(low+4),str(low+8),str(low+12)],
             'legend': ['Measured', 'Control'], 'series': {'Measured': readings, 'Control': [low+10]*4}}
    # Top-left points; each block is authored before rendering.
    blocks = [
        {'id':'heading','kind':'heading','bbox':[44,35,568,61],'text':title},
        {'id':'subtitle','kind':'subtitle','bbox':[44,63,568,80],'text':subtitle},
    ]
    if layout == 'two-column':
        blocks += [{'id':'body-1','kind':'body','bbox':[44,92,296,253],'text':bodies[0]},
                   {'id':'body-2','kind':'body','bbox':[316,92,568,253],'text':bodies[1]}]
    else:
        blocks += [{'id':'body-1','kind':'body','bbox':[44,92,568,176],'text':bodies[0]},
                   {'id':'body-2','kind':'body','bbox':[44,180,568,263],'text':bodies[1]}]
    tech = 'chart' if p % 3 == 1 else 'table'
    blocks += [{'id':'technical','kind':tech,'bbox':[44,275,568,425], 'text': ('Inspection readings' if tech == 'table' else 'Inspection trend')}]
    blocks += [{'id':'formula','kind':'formula','bbox':[44,432,568,493],'text':formula}]
    blocks += [{'id':'inset','kind':'inset','bbox':[44,504,568,604],'text':'Inspection note\n'+inset}]
    blocks += [{'id':'commentary','kind':'commentary','bbox':[44,616,568,667],'text':comment},
               {'id':'caption','kind':'caption','bbox':[44,683,568,701],'text':'Readings are reported in local operating units.'},
               {'id':'footer','kind':'footer','bbox':[44,744,568,762],'text':f'Operations engineering  •  {p+1}'}]
    if layout == 'side-panel-chart':
        blocks[-4]['bbox'] = [378, 504, 568, 670]
        blocks[-3]['bbox'] = [44, 504, 356, 590]
    sections = []
    for b in blocks:
        if b['kind'] == 'table': sections.append('Inspection readings\n'+'\n'.join(' | '.join(r) for r in rows))
        elif b['kind'] == 'chart': sections.append('\n'.join([chart['title'], chart['xLabel'], chart['yLabel'], *chart['xTicks'], *chart['yTicks'], *chart['legend']]))
        else: sections.append(b['text'])
    result = {'pageId': f'family-{f:04d}-page-{p+1:02d}', 'layout':layout, 'genre':topic,
              'blocks':blocks, 'bbox':{b['id']:b['bbox'] for b in blocks}, 'sections':sections,
              'paragraphs':bodies+[inset,comment], 'tables':[{'rows':rows}] if tech=='table' else [],
              'charts':[chart] if tech=='chart' else [],
              'formulas':[{'literal':formula,'semantic':{'expression':'(a + b) / 2','constraint':[low,low+12], 'matrix':[[low+2,low+4,low+3],[low+6,low+8,low+7]]}}],
              'excludedText':[], 'readingOrder':[b['id'] for b in blocks], 'expectedMarkdown':'\n\n'.join(sections)}
    result['canonicalContentHash'] = sha(enc(result))
    return result


def plan(f, hard):
    rng = random.Random(913771 + f*101 + hard)
    hard_pages = sorted(rng.sample(range(10), hard//10))
    slot = {6: 7, 7: 6, 12: 14, 14: 12}.get(f % 18, f % 18)
    share = (slot//3)/5
    steps=[]
    for p in range(10):
        dpi=85+(f*7+p*11+hard)%41
        skew=round(((f+p)%5-2)*0.18,2)
        rotation=90 if (p+f)%10==3 else 0
        steps.append({'page':p+1, 'hardScan':p in hard_pages, 'dpi':dpi, 'skewDegrees':skew,
                      'blurRadius':0.25, 'contrast':0.97, 'jpegQuality':83,
                      'sectionRasterIds':(['technical','inset','formula','body-2','body-1'][:round(share*5)]),
                      'insetScreenshot':(p+f)%3==0, 'outlinedBlock':'subtitle' if (p+f)%4==0 else None,
                      'rotation':rotation, 'decoy':f'VOID RECORD {station_code(f,p)}' if (p+f)%4==1 else None,
                      'coordinateTransform':{'source':'top-left PDF points, 612 x 792',
                          'sectionRaster':'crop at authored bbox and place into the same bbox',
                          'scan':({'scalePixelsPerPoint':dpi/72, 'pixelRotationDegreesCCW':skew,
                                   'rotationCenterPoints':[306,396], 'expand':False,
                                   'placement':'scan pixels mapped back to 612 x 792 points'} if p in hard_pages else None),
                          'pageRotationClockwise':rotation}})
    return {'hardPercent':hard, 'hardPages':[p+1 for p in hard_pages], 'baseRegionRasterShare':share,'pages':steps}


def station_code(f,p): return f'{f*10+p+1000}'


def blank_pdf():
    d=fitz.open(); d.new_page(width=W,height=H); return d


def paragraph(c, text, box, font='NotoSerif', size=10.2, leading=13.1, color=colors.HexColor('#20292b')):
    x0,y0,x1,y1=box
    style=ParagraphStyle('body',fontName=font,fontSize=size,leading=leading,textColor=color,spaceAfter=0)
    item=Paragraph(html.escape(text).replace('\n','<br/>'),style)
    _, height=item.wrap(x1-x0,y1-y0)
    if height > y1-y0+0.01: raise ValueError(f'text overflow {height:.1f} > {y1-y0}: {text[:48]}')
    item.drawOn(c,x0,H-y0-height)


def chart_pdf(chart):
    font_manager.fontManager.addfont(str(FONT_DIR/'NotoSans-Regular.ttf'))
    plt.rcParams.update({'pdf.fonttype':42, 'font.family':'Noto Sans'})
    fig, ax=plt.subplots(figsize=(7.28,2.08))
    x=[1,2,3,4]
    ax.plot(x,chart['series']['Measured'],color='#246c70',marker='o',lw=1.5,label='Measured')
    ax.plot(x,chart['series']['Control'],color='#a65b2f',ls='--',lw=1.2,label='Control')
    ax.set(title=chart['title'],xlabel=chart['xLabel'],ylabel=chart['yLabel'])
    ax.set_xticks(x); ax.set_yticks([int(v) for v in chart['yTicks']]); ax.set_ylim(int(chart['yTicks'][0]),int(chart['yTicks'][-1]))
    ax.tick_params(labelsize=7); ax.title.set_fontsize(9); ax.xaxis.label.set_size(8); ax.yaxis.label.set_size(8)
    ax.legend(loc='upper left', fontsize=6, frameon=True, facecolor='white', framealpha=1, edgecolor='white'); ax.grid(alpha=.2)
    fig.tight_layout(pad=.4)
    out=io.BytesIO(); fig.savefig(out,format='pdf',metadata={'CreationDate':None,'ModDate':None}); plt.close(fig)
    return out.getvalue()


def block_pdf(page, block, outlined=False):
    out=io.BytesIO(); c=canvas.Canvas(out,pagesize=(W,H),invariant=1,pageCompression=1)
    box=block['bbox']; kind=block['kind']; x0,y0,x1,y1=box
    if kind == 'heading': paragraph(c,block['text'],box,'NotoSans',16,20)
    elif kind in ('subtitle','footer','caption'):
        if outlined:
            glyphs = TextPath((x0, H-y0-9), block['text'], size=8.5,
                              prop=FontProperties(fname=str(FONT_DIR/'NotoSans-Regular.ttf')))
            path = c.beginPath()
            for points, code in glyphs.iter_segments(curves=False):
                if code == MplPath.MOVETO: path.moveTo(*points)
                elif code == MplPath.LINETO: path.lineTo(*points)
                elif code == MplPath.CLOSEPOLY: path.close()
            c.drawPath(path, stroke=0, fill=1)
        else: paragraph(c,block['text'],box,'NotoSans',8.5,11)
    elif kind in ('body','commentary'): paragraph(c,block['text'],box,'NotoSerif',10.2,13.1)
    elif kind == 'formula':
        c.setFont('NotoMono',9.2)
        for line_number,line in enumerate(block['text'].split('\n')):
            if pdfmetrics.stringWidth(line,'NotoMono',9.2)>x1-x0:
                raise ValueError('formula line exceeds its authored box')
            c.drawString(x0,H-y0-10-line_number*12,line)
    elif kind == 'inset':
        c.setStrokeColor(colors.HexColor('#9aa6a4')); c.setFillColor(colors.HexColor('#f5f7f5'))
        c.roundRect(x0,H-y1,x1-x0,y1-y0,3,stroke=1,fill=1)
        title, content=block['text'].split('\n',1)
        paragraph(c,title,[x0+10,y0+7,x1-10,y0+23],'NotoSans',9.4,11)
        paragraph(c,content,[x0+10,y0+26,x1-10,y1-7],'NotoSerif',9.3,12)
    elif kind == 'table':
        paragraph(c,'Inspection readings',[x0,y0,x1,y0+16],'NotoSans',10,12)
        rows=page['tables'][0]['rows']; t=Table(rows,colWidths=[130]*4,rowHeights=[22]*5)
        t.setStyle(TableStyle([('FONTNAME',(0,0),(-1,-1),'NotoSans'),('FONTSIZE',(0,0),(-1,-1),9),
          ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e5eeec')),('GRID',(0,0),(-1,-1),.35,colors.HexColor('#aab8b5')),
          ('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
        t.wrapOn(c,520,110); t.drawOn(c,x0,H-y0-130)
    elif kind == 'chart':
        c.showPage(); c.save()
        doc=fitz.open(stream=out.getvalue(),filetype='pdf'); other=fitz.open(stream=chart_pdf(page['charts'][0]),filetype='pdf')
        doc[0].show_pdf_page(fitz.Rect(box),other,0,keep_proportion=False)
        return doc.tobytes(no_new_id=True)
    c.showPage(); c.save(); return out.getvalue()


def overlay(target, data, box, raster=False, dpi=144):
    src=fitz.open(stream=data,filetype='pdf'); rect=fitz.Rect(box)
    if raster:
        pix=src[0].get_pixmap(matrix=fitz.Matrix(dpi/72,dpi/72),clip=rect,alpha=False)
        target.insert_image(rect,stream=pix.tobytes('png'))
    else: target.show_pdf_page(rect,src,0,clip=rect,keep_proportion=False)
    src.close()


def soffice_source(page, folder):
    # The HTML export itself supplies a text-bearing section of the assembled PDF.
    source=folder/'office.html'
    text=page['blocks'][1]['text']
    source.write_text('<html><head><meta charset="utf-8"><style>@page { size: letter; margin: 0.6in; } body {font-family: Noto Sans; font-size: 8.5pt;}</style></head><body>'+html.escape(text)+'</body></html>')
    profile=folder/'lo-profile'
    cmd=['soffice','-env:UserInstallation='+profile.as_uri(),'--headless','--convert-to','pdf','--outdir',str(folder),str(source)]
    proc=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,check=True)
    path=folder/'office.pdf'
    if not path.exists(): raise RuntimeError('LibreOffice did not produce PDF: '+proc.stdout.decode(errors='replace')+proc.stderr.decode(errors='replace'))
    return path.read_bytes(), source.read_bytes()


def office_block(page, folder):
    raw, source = soffice_source(page, folder)
    office = fitz.open(stream=raw, filetype='pdf')
    if len(office) != 1:
        raise ValueError('LibreOffice text section did not fit on one page')
    out = blank_pdf()
    out[0].show_pdf_page(fitz.Rect(page['blocks'][1]['bbox']), office, 0,
                         clip=fitz.Rect(43, 43, 568, 60), keep_proportion=False)
    if page['blocks'][1]['text'] not in out[0].get_text():
        raise ValueError('LibreOffice section text does not match authored subtitle')
    return out.tobytes(no_new_id=True), raw, source


def scan(data, page_plan):
    doc=fitz.open(stream=data,filetype='pdf'); pix=doc[0].get_pixmap(matrix=fitz.Matrix(page_plan['dpi']/72,page_plan['dpi']/72),alpha=False)
    image=Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
    image=image.rotate(page_plan['skewDegrees'],resample=Image.Resampling.BICUBIC,expand=False,fillcolor='white')
    image=ImageEnhance.Contrast(image).enhance(page_plan['contrast']).filter(ImageFilter.GaussianBlur(page_plan['blurRadius']))
    jpg=io.BytesIO(); image.save(jpg,format='JPEG',quality=page_plan['jpegQuality'],subsampling=2,optimize=False)
    output=blank_pdf(); output[0].insert_image(fitz.Rect(0,0,W,H),stream=jpg.getvalue()); return output


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output',type=Path,required=True); ap.add_argument('--full',action='store_true')
    ap.add_argument('--audited-spec-sha256'); ap.add_argument('--approval',action='store_true'); ap.add_argument('--workers',type=int,default=1)
    args=ap.parse_args()
    if not 1<=args.workers<=3: ap.error('workers must be between 1 and 3')
    spec_sha=sha(SPEC.read_bytes())
    if args.full and (not args.approval or args.audited_spec_sha256!=spec_sha): ap.error('full generation requires --approval and exact audited spec SHA-256')
    if args.output.exists(): ap.error('output already exists; refusing to overwrite')
    families=range(90) if args.full else (0,6,12)
    args.output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='fools-gold-a3-',dir=os.environ['TMPDIR']) as tmp:
        build(args.output,list(families),spec_sha,Path(tmp))


def build(out,families,spec_sha,tmp):
    manifest={'schema':'mixed-pdf-authored@v2','specSha256':spec_sha,'cases':[],'status':'awaiting independent audit and judge'}
    office_version=subprocess.run(['soffice','--version'],check=True,capture_output=True,text=True).stdout.strip()
    for f in families:
        pages=[model(f,p) for p in range(10)]; split=split_for(f)
        world={'family':f,'split':split,'seed':913771+f,'genre':pages[0]['genre']}
        source={'world':world,'pages':pages}
        source_bytes=enc(source); source_hash=sha(source_bytes)
        save(out/f'sources/family-{f:04d}/world.json',enc(world))
        save(out/f'sources/family-{f:04d}/authored.json',source_bytes)
        plans={hard:plan(f,hard) for hard in (0,20,40,60,80,100)}
        save(out/f'sources/family-{f:04d}/difficulty-plans.json',enc(plans))
        # Store native individual authored elements before any raster conversion.
        cache={}
        for p,page in enumerate(pages):
            for b in page['blocks']:
                if f % 18 in (6, 7) and b['id'] == 'subtitle':
                    office_dir = tmp / f'office-{f}-{p}'; office_dir.mkdir()
                    data, office_pdf, office_html = office_block(page, office_dir)
                    save(out/f'sources/family-{f:04d}/native/office-{p+1:02d}.html',office_html)
                    save(out/f'sources/family-{f:04d}/native/office-{p+1:02d}.pdf',office_pdf)
                else:
                    data=block_pdf(page,b)
                cache[(p,b['id'])]=data
                if b['id']=='subtitle': cache[(p,'outlined-subtitle')]=block_pdf(page,b,outlined=True)
                save(out/f'sources/family-{f:04d}/native/page-{p+1:02d}-{b["id"]}.pdf',data)
        for hard in (0,20,40,60,80,100):
            case=f'mixed-source-{f:04d}-hard-{hard:03d}'; pp=plans[hard]
            doc=fitz.open(); label_pages=[]
            for p,page in enumerate(pages):
                step=pp['pages'][p]; d=blank_pdf(); target=d[0]
                for b in page['blocks']:
                    raster=b['id'] in step['sectionRasterIds'] or (b['id']=='inset' and step['insetScreenshot'])
                    key = 'outlined-subtitle' if step['outlinedBlock']==b['id'] else b['id']
                    overlay(target,cache[(p,key)],b['bbox'],raster)
                if step['decoy']:
                    target.insert_text((48,720),step['decoy'],fontsize=7,color=(0,0,0))
                    target.draw_rect(fitz.Rect(44,706,300,727),color=(1,1,1),fill=(1,1,1),overlay=True)
                if step['hardScan']:
                    converted=scan(d.tobytes(no_new_id=True),step); d.close(); d=converted; target=d[0]
                if step['rotation']: target.set_rotation(step['rotation'])
                doc.insert_pdf(d); d.close()
                ref=json.loads(json.dumps(page)); ref['excludedText']=[step['decoy']] if step['decoy'] and not step['hardScan'] else []
                ref['transformation']=step; label_pages.append(ref)
            origin = 'ReportLab '+__import__('reportlab').Version + ('; '+office_version+' HTML export' if f % 18 in (6,7) else '')
            doc.set_metadata({'title':pages[0]['genre']+' operational review', 'author':'Operations engineering',
                              'producer':origin+'; PyMuPDF '+fitz.VersionBind,
                              'creator':'ReportLab '+__import__('reportlab').Version})
            intermediate=tmp/(case+'-base.pdf'); intermediate.write_bytes(doc.tobytes(garbage=4,deflate=True,no_new_id=True)); doc.close()
            base_path=f'sources/family-{f:04d}/storage-bases/{case}.pdf'
            base_bytes=intermediate.read_bytes(); save(out/base_path,base_bytes)
            output=tmp/(case+'.pdf'); version='1.4' if (f+hard//20)%2==0 else '1.7'
            opts=['--force-version='+version,'--object-streams='+('disable' if version=='1.4' else 'generate'),'--deterministic-id']
            if (f+hard//20)%3==0: opts.append('--linearize')
            subprocess.run(['qpdf',*opts,str(intermediate),str(output)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            pdf_bytes=output.read_bytes(); pdf_path=f'inputs/{split}/{case}.pdf'; labels_path=f'labels/{split}/{case}.json'
            labels={'schema':'mixed-pdf-authored@v2','caseId':case,'pages':label_pages}
            label_bytes=enc(labels); save(out/pdf_path,pdf_bytes); save(out/labels_path,label_bytes)
            manifest['cases'].append({'id':case,'family':f,'split':split,'pdf':pdf_path,'labels':labels_path,'sha256':sha(pdf_bytes),
               'labelHash':sha(label_bytes),'sourceLayoutHash':source_hash,'hardPercent':hard,'baseRegionRasterShare':pp['baseRegionRasterShare'],
               'storageBase':base_path,'storageBaseHash':sha(base_bytes),
               'pages':pp['pages'],'layout':pages[0]['layout'],'genre':pages[0]['genre'],
               'producer':origin,'rewriteHistory':['PyMuPDF '+fitz.VersionBind,'qpdf'], 'pdfVersion':version})
            print('built',case,flush=True)
    manifest['artifacts'] = [
        {'path': str(path.relative_to(out)), 'sha256': sha(path.read_bytes())}
        for path in sorted(out.rglob('*')) if path.is_file()
    ]
    save(out/'manifest.json',enc(manifest))


if __name__=='__main__': main()
