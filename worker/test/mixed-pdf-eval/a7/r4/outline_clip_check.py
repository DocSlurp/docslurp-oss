"""Independent embedded-outline versus active-PDF-clip inspection.

Reads original PDF bytes only; no expected authoring coordinates or glyph counts.
Unsupported clip/font/paint mechanisms fail closed. No occlusions are declared.
"""
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import hashlib
import json
import re
import sys

import pikepdf
import pymupdf
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def cmap_unicode(stream):
    text=stream.read_bytes().decode('ascii')
    result={}
    for block in re.findall(r'beginbfchar(.*?)endbfchar',text,re.S):
        for a,b in re.findall(r'<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>',block):
            assert len(a)==2, 'Unsupported multibyte font encoding'
            result[int(a,16)]=bytes.fromhex(b).decode('utf-16-be')
    assert 'beginbfrange' not in text, 'Unsupported range CMap; no guessed decoding'
    assert result and all(len(x)==1 for x in result.values())
    return result

def actual_outlines(document,page,pdfpage):
    fonts=[]
    for resource,ob in pdfpage.Resources.Font.items():
        # ReportLab declares an unused base-14 default resource. Any actual
        # text-show using it still fails below because it has no outline map.
        if str(ob.Subtype)!='/TrueType':continue
        raw=document.extract_font(ob.objgen[0])[3]
        assert raw, ('Font not embedded',resource)
        font=TTFont(BytesIO(raw));gs=font.getGlyphSet();order=font.getGlyphOrder()
        unicode=cmap_unicode(ob.ToUnicode)
        cm={}
        for sub in font['cmap'].tables:cm.update(sub.cmap)
        by_gid={order.index(cm[c]):u for c,u in unicode.items() if c in cm}
        bounds={}
        for gid,name in enumerate(order):
            pen=BoundsPen(gs);gs[name].draw(pen);bounds[gid]=pen.bounds
        fonts.append({'resource':str(resource),'family':str(ob.BaseFont).split('+')[-1].lstrip('/'),
                      'unicode':unicode,'byGid':by_gid,'bounds':bounds,'upem':font['head'].unitsPerEm,
                      'embeddedSha256':hashlib.sha256(raw).hexdigest()})
    glyphs=[];ambiguities=[]
    for span in page.get_texttrace():
        assert span['type']==0 and span['opacity']==1, 'Nonopaque/nonfill text is unsupported'
        candidates=[f for f in fonts if f['family'].replace('-','')==span['font'].replace('-','') and
                    all(f['byGid'].get(c[1])==chr(c[0]) for c in span['chars'])]
        assert candidates, ('Cannot bind actual embedded font/GIDs',span['font'])
        if len(candidates)>1:
            assert all(f['upem']==candidates[0]['upem'] and all(f['bounds'][c[1]]==candidates[0]['bounds'][c[1]] for c in span['chars']) for f in candidates)
            ambiguities.append({'seqno':span['seqno'],'equivalentOutlineResources':[f['resource'] for f in candidates]})
        font=candidates[0];dx,dy=span['dir'];scale=span['size']/font['upem']
        for cp,gid,origin,_ in span['chars']:
            bounds=font['bounds'][gid];ink=None
            if bounds:
                pts=[(origin[0]+scale*(dx*x+dy*y),origin[1]+scale*(dy*x-dx*y)) for x in [bounds[0],bounds[2]] for y in [bounds[1],bounds[3]]]
                ink=[min(p[0] for p in pts),min(p[1] for p in pts),max(p[0] for p in pts),max(p[1] for p in pts)]
            glyphs.append({'text':chr(cp),'gid':gid,'originPt':list(origin),'inkPt':ink,
                           'fontSha256':font['embeddedSha256'],'sizePt':span['size'],'seqno':span['seqno']})
    return glyphs,fonts,ambiguities

def mult(m,n):
    a,b,c,d,e,f=m;g,h,i,j,k,l=n
    return (a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f)

def point(m,x,y):
    return (m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5])

def active_clips(page,fonts,height):
    maps={f['resource']:f['unicode'] for f in fonts}
    raw=[];stack=[];matrix=(1,0,0,1,0,0);clips=[list(map(float,page.obj.CropBox if '/CropBox' in page.obj else page.obj.MediaBox))]
    # All current one-page previews use an unrotated origin-zero letter page.
    assert clips[0]==[0,0,612,792] and height==792
    path=[];pending=None;font=None;render_mode=0;unsupported=[]
    for index,ins in enumerate(pikepdf.parse_content_stream(page)):
        op=str(ins.operator);args=ins.operands
        if op=='q':stack.append((matrix,list(clips),font,render_mode))
        elif op=='Q':matrix,clips,font,render_mode=stack.pop()
        elif op=='cm':matrix=mult(matrix,tuple(map(float,args)))
        elif op=='Tf':font=str(args[0])
        elif op=='Tr':
            render_mode=int(args[0]);assert render_mode==0, 'Text render/clip mode unsupported'
        elif op=='re':
            x,y,w,h=map(float,args)
            pts=[point(matrix,a,b) for a in [x,x+w] for b in [y,y+h]]
            b=[min(p[0] for p in pts),min(p[1] for p in pts),max(p[0] for p in pts),max(p[1] for p in pts)]
            path.append({'rectPt':[b[0],height-b[3],b[2],height-b[1]],'axisAligned':matrix[1]==matrix[2]==0})
        elif op in ['m','l','c','v','y','h']:path.append({'unsupportedPathOp':op})
        elif op in ['W','W*']:
            assert pending is None
            if len(path)==1 and path[0].get('axisAligned'):pending=path[0]['rectPt']
            else:unsupported.append({'instruction':index,'operator':op,'path':list(path)})
        elif op in ['Tj','TJ',"'",'"']:
            assert pending is None, 'Text before clip path termination'
            assert render_mode==0
            parts=args[0] if op=='TJ' else [args[-1]]
            assert font in maps, ('Text paints using unsupported/unembedded font',font)
            for part in parts:
                if isinstance(part,pikepdf.String):
                    for code in bytes(part):
                        raw.append({'text':maps[font][code],'clipsPt':[list(c) for c in clips],
                                    'instruction':index,'fontResource':font})
        elif op=='Do':unsupported.append({'instruction':index,'operator':'Do','reason':'Nested XObject not silently ignored'})
        if op in ['n','S','s','f','F','f*','B','B*','b','b*']:
            if pending is not None:clips.append(pending);pending=None
            path=[]
    assert not stack and pending is None
    return raw,unsupported

def inspect(path):
    path=Path(path)
    report={'pdf':str(path),'sha256':sha(path),'observedAtUtc':datetime.now(timezone.utc).isoformat(),
            'occlusionExclusions':[], 'comparisonThresholdPt':0,
            'method':'Actual embedded TrueType BoundsPen outlines, GID+ToUnicode binding, actual text origins, complete q/Q/cm/W rectangular active-clip stack. No extraction bboxes or expected authoring geometry.'}
    with pymupdf.open(path) as doc,pikepdf.open(path) as pdf:
        assert len(doc)==len(pdf.pages)==1
        assert int(pdf.pages[0].obj.get('/Rotate',0))==0
        glyphs,fonts,ambiguities=actual_outlines(doc,doc[0],pdf.pages[0])
        raw,unsupported=active_clips(pdf.pages[0],fonts,doc[0].rect.height)
        assert ''.join(g['text'] for g in glyphs)==''.join(g['text'] for g in raw),'Raw PDF text-show and GID trace sequence mismatch'
        outside=[];minimum=None;checked=0
        for index,(glyph,paint) in enumerate(zip(glyphs,raw)):
            if glyph['inkPt'] is None:continue
            checked+=1;b=glyph['inkPt']
            for c in paint['clipsPt']:
                slack=[b[0]-c[0],b[1]-c[1],c[2]-b[2],c[3]-b[3]]
                minimum=min(slack+[minimum]) if minimum is not None else min(slack)
                if min(slack)<0:outside.append({'glyphIndex':index,**glyph,'clipPt':c,'outsidePt':-min(slack),'instruction':paint['instruction']})
        report.update({'glyphCountIncludingSpaces':len(glyphs),'outlinedGlyphsChecked':checked,
                       'embeddedFonts':[{'resource':f['resource'],'sha256':f['embeddedSha256']} for f in fonts],
                       'equivalentSubsetAmbiguities':ambiguities,'rawSequenceExactlyMatches':True,
                       'unsupportedMechanisms':unsupported,'glyphsOutsideActiveClips':outside,'minimumClipSlackPt':minimum,
                       'completeForObservedMechanisms':not unsupported,'noOutlineClipMisses':not unsupported and not outside})
    return report

def main():
    directory=Path(sys.argv[1]);reports=[]
    for pdf in sorted(directory.glob('*-original.pdf')):
        reports.append(inspect(pdf))
    assert len(reports)==6
    result={'observedAtUtc':datetime.now(timezone.utc).isoformat(),'reports':reports,
            'misses':[{'pdf':r['pdf'],'outsideGlyphCount':len(r['glyphsOutsideActiveClips']),'unsupported':r['unsupportedMechanisms']} for r in reports if not r['noOutlineClipMisses']],
            'noExclusions':True,'noPdfRewrites':True,'independentReviewRequired':True}
    target=directory/'actual-full-outline-versus-clip.json';assert not target.exists()
    target.write_text(json.dumps(result,indent=2)+'\n')
    print('OUTLINE/CLIP',len(result['misses']),'PDF findings;',sum(r['outlinedGlyphsChecked'] for r in reports),'actual outlines checked')
    if result['misses']:sys.exit(1)

if __name__=='__main__':main()
