"""E complete Writer path derived only from the allowlisted generic runtime.

The clean P runtime and its authoring/content factory remain byte-identical.
"""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'clean-inputs/runtime'))
from fools_gold_v4_native import (NS,text_xml,METRICS,width,illustration)
from fools_gold_v4_common import TEMP_ROOT,run,save,sha,canonical
import base64,copy,subprocess,tempfile
from xml.sax.saxutils import escape
def native_writer(authoring,resolved,world,fodt,pdf,only=None,omit=None):
    styles=[];body=[];included_tables=set()
    for page,r in zip(authoring['pages'],resolved['pages']):
        frames=[]
        for b in sorted(page['blocks'],key=lambda b:r['paintOrder'].index(b['id'])):
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
                y0-=r.get('baselineCalibration',{}).get(f'{kind}|{size}|{lead}',0)
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
            elif b['role'] in ['panel-background','occluder','decoration','auxiliary-background','auxiliary-panel']:
                fill='solid';color='#edf2f6' if b['role']=='panel-background' else '#e0e3e6' if b['templateId']=='overlay.cover' else '#ffffff' if b['role']=='occluder' else '#d6dfe5' if b['role']=='auxiliary-panel' else '#7a96a8'
                content='<text:p text:style-name="empty"/>'
            else:continue
            styles.append(f'<style:style style:name="fr_{name}" style:family="graphic"><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="page" style:vertical-pos="from-top" style:vertical-rel="page" fo:padding="0pt" fo:border="none" draw:fill="{fill}" draw:fill-color="{color}" draw:stroke="none" fo:background-color="{color if fill=="solid" else "transparent"}"/></style:style>')
            attrs=f'draw:style-name="fr_{name}" draw:name="{name}" text:anchor-type="page" text:anchor-page-number="{page["number"]}" svg:x="{x0}pt" svg:y="{y0}pt" svg:width="{x1-x0}pt" svg:height="{y1-y0}pt" draw:z-index="{r['paintOrder'].index(bid)}"'
            if b['role'] in ['panel-background','occluder','decoration','auxiliary-background','auxiliary-panel']:frames.append('<draw:rect '+attrs+'/>')
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
        result=subprocess.run(['/usr/bin/python',str(Path(__file__).with_name('writer_bridge.py'))],input=canonical(payload),capture_output=True,timeout=120)
        if result.returncode:raise RuntimeError(result.stdout.decode()+result.stderr.decode())
        if not pdf.exists():raise RuntimeError('Writer export produced no PDF')
    finally:
        if process.poll() is None:process.terminate()
        process.communicate(timeout=15)
    # Disposable profile only; editable/native artifacts remain durable.
    import shutil
    shutil.rmtree(profile)
    return dict(command=[str(x) for x in command],stdout=result.stdout.decode(),editableOdt=str(odt),exportProfile=dict(SelectPdfVersion=0,UseTaggedPDF=False,ExportBookmarks=False,ExportNotes=False))

