"""E-only structural ordering of a complete Writer native PDF.

Writer paints some frame backgrounds before drawing shapes irrespective of their
collection/ZOrder. Preserve its actual native paint operators and resources,
partition those operators by the frozen envelope graph, and order independent
components exactly as already frozen. This module never reads text, chooses a
permutation from extraction, changes layout, or creates gold.

State replay contains no text-show, image-show, shading or path-paint operation.
Each original paint unit occurs exactly once. Prefixes preserve native graphics
state and clipping, including arbitrary q/Q nesting, before their own unit.
Only producer-owned files created in this process are inputs.
"""
from io import BytesIO
import copy
import fitz
import pikepdf
from support import *

PAINT={'S','s','f','F','f*','B','B*','b','b*','Do','sh','Tj','TJ',"'",'"'}
PATH_PAINT={'S','s','f','F','f*','B','B*','b','b*'}
TEXT_SHOW={'Tj','TJ',"'",'"'}
MARK={'BMC','BDC','EMC','MP','DP'}


def state_only(instructions):
    out=[]
    for ins in instructions:
        op=str(ins.operator)
        if op in MARK:continue
        if op in PATH_PAINT:out.append(([],pikepdf.Operator('n')))
        elif op in {'Do','sh','Tj','TJ'}:continue
        elif op=="'":out.append(([],pikepdf.Operator('T*')))
        elif op=='"':
            out.extend([(ins.operands[:1],pikepdf.Operator('Tw')),(ins.operands[1:2],pikepdf.Operator('Tc')),([],pikepdf.Operator('T*'))])
        else:out.append(ins)
    return out


def units(instructions):
    spans=[];depth=0;start=None
    for i,ins in enumerate(instructions):
        op=str(ins.operator)
        if op in ['BMC','BDC']:
            if depth==0:start=i
            depth+=1
        elif op=='EMC':
            depth-=1
            assert depth>=0,'Unbalanced native marked content'
            if depth==0:
                if any(str(x.operator) in PAINT for x in instructions[start:i+1]):spans.append((start,i+1))
                start=None
        elif depth==0 and op in PAINT:spans.append((i,i+1))
        elif op=='INLINE IMAGE':raise ValueError('Inline images need a declared native unit adapter')
        if op=='Tr':assert int(ins.operands[0])==0,'Text clipping/render modes are not supported by this clean native stream adapter'
    assert depth==0,'Unclosed native marked content'
    return spans


def balanced_unit(prefix,raw):
    # Writer text-show units must start/end outside BT/ET. Skipped earlier show
    # operators then cannot alter a surviving unit's initial text matrix.
    text_depth=0
    for ins in prefix:
        op=str(ins[1] if isinstance(ins,tuple) else ins.operator)
        if op=='BT':text_depth+=1
        if op=='ET':text_depth-=1
    assert text_depth==0,'Native paint unit starts inside an inherited text object'
    body=prefix+[ins for ins in raw if str(ins.operator) not in MARK]
    depth=0
    for ins in body:
        op=str(ins[1] if isinstance(ins,tuple) else ins.operator)
        if op=='q':depth+=1
        if op=='Q':depth-=1
        assert depth>=0,'Native state replay underflow'
        if op=='BT':text_depth+=1
        if op=='ET':text_depth-=1
    assert text_depth==0,'Native paint unit ends inside text'
    return pikepdf.unparse_content_stream(body+[([],pikepdf.Operator('Q')) for _ in range(depth)])


def form(pdf,resources,raw):
    obj=pdf.make_stream(raw)
    obj.Type=pikepdf.Name('/XObject');obj.Subtype=pikepdf.Name('/Form');obj.FormType=1
    obj.BBox=pikepdf.Array([0,0,612,792]);obj.Resources=resources
    return obj


def reorder_writer(source,target,authoring,resolved):
    assert authoring.get('classId')!='P','Accepted P factory/output is outside this E-only mechanism'
    receipts=[]
    with pikepdf.open(source) as pdf:
        assert len(pdf.pages)==len(authoring['pages'])
        for number,(page,ap,r) in enumerate(zip(pdf.pages,authoring['pages'],resolved['pages'])):
            instructions=list(pikepdf.parse_content_stream(page));spans=units(instructions)
            resources=pdf.make_indirect(pikepdf.Dictionary(page.Resources))
            pieces=[]
            for start,end in spans:
                pieces.append(balanced_unit(state_only(instructions[:start]),instructions[start:end]))
            assert pieces,'No native paint units'
            # A structural graphics probe only: classify native paint bounds.
            # No Unicode/extracted strings or scoring information are read.
            probe=pikepdf.Pdf.new();probe_resources=probe.copy_foreign(resources)
            for raw in pieces:
                pp=probe.add_blank_page(page_size=(612,792));fo=form(probe,probe_resources,raw)
                pp.Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Piece=fo));pp.Contents=probe.make_stream(b'/Piece Do\n')
            buffer=BytesIO();probe.save(buffer);probe.close()
            lookup={b['id']:b for b in ap['blocks']}
            # Recover components from the same fixed envelope graph; order was
            # frozen in r.paintOrder before either producer ran.
            components=paint_components(ap['blocks']);regions=[[lookup[bid]['containerPt'] for bid in comp] for comp in components]
            grouped={i:[] for i in range(len(components))};unit_membership=[]
            with fitz.open(stream=buffer.getvalue(),filetype='pdf') as graphics:
                for index,p in enumerate(graphics):
                    events=p.get_bboxlog();members=set()
                    for kind,box,*_ in events:
                        if kind=='ignore-text':continue
                        candidates=[i for i,region in enumerate(regions) if any(area(intersect(box,b))>0 for b in region)]
                        assert candidates,('Native paint outside fixed component envelopes',ap['id'],kind,box)
                        component=max(candidates,key=lambda i:max(area(intersect(box,b)) for b in regions[i]));members.add(component)
                    assert len(members)==1,('Native paint unit crosses independent components',ap['id'],index,sorted(members))
                    component=next(iter(members));grouped[component].append(index);unit_membership.append(component)
            assert all(grouped.values()),'Frozen paint component missing in native export'
            chosen=sorted(range(len(components)),key=lambda i:min(r['paintOrder'].index(bid) for bid in components[i]))
            # Preserve every intersecting unit's original relative paint order.
            ordered_units=[u for component in chosen for u in grouped[component]]
            assert sorted(ordered_units)==list(range(len(pieces)))
            new_resources=pikepdf.Dictionary(resources);new_xobjects=pikepdf.Dictionary(new_resources.get('/XObject',pikepdf.Dictionary()))
            calls=[]
            for i in ordered_units:
                name=f'/A5Paint{i:04d}';new_xobjects[name]=form(pdf,resources,pieces[i]);calls.append(f'{name} Do')
            new_resources.XObject=new_xobjects;page.Resources=new_resources
            page.Contents=pdf.make_stream(('\n'.join(calls)+'\n').encode())
            receipts.append(dict(pageId=ap['id'],nativePaintUnits=len(pieces),fixedComponents=components,chosenComponentOrder=chosen,originalUnitComponentMembership=unit_membership,finalUnitOrder=ordered_units,exactPaintUnitConservation=True,method='unchanged original native paint operations plus nonpainting graphics-state replay'))
        original_producer=str(pdf.docinfo.get('/Producer',''))
        pdf.docinfo['/Producer']='pikepdf '+pikepdf.__version__+'; native stream ordering after '+original_producer
        pdf.save(target,force_version='1.7')
    # Strong regression gate before the normalized file can be used. The frozen
    # desired order is not changed in response to this comparison.
    with fitz.open(source) as old,fitz.open(target) as new:
        for before,after,receipt in zip(old,new,receipts):
            a=before.get_pixmap(dpi=150,alpha=False);b=after.get_pixmap(dpi=150,alpha=False)
            assert (a.width,a.height,a.samples)==(b.width,b.height,b.samples),('Native stream normalization changed rendered pixels',receipt['pageId'])
    return dict(writer='pikepdf '+pikepdf.__version__,source=str(source),sourceHash=digest(Path(source).read_bytes()),targetHash=digest(Path(target).read_bytes()),pages=receipts,exactPixelsAt150Dpi=True,layoutOwner='LibreOffice Writer; native paint operations unchanged')
