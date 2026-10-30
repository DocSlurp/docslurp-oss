"""Exact editable-table and native primitive references, independently read."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile
import fitz
from support import *

TABLE_NS='urn:oasis:names:tc:opendocument:xmlns:table:1.0'
TEXT_NS='urn:oasis:names:tc:opendocument:xmlns:text:1.0'
T='{'+TABLE_NS+'}'


def writer_tables(a,resolved,odt):
    with zipfile.ZipFile(odt) as z:xml=z.read('content.xml')
    root=ET.fromstring(xml);actual={t.get(T+'name'):t for t in root.iter(T+'table')};misses=[];checked=0
    for page,r in zip(a['pages'],resolved['pages']):
        lookup={b['id']:b for b in page['blocks']}
        for bid,t in r['tables'].items():
            name=bid.replace('.','_')+'_native'
            if name not in actual:misses.append(dict(block=bid,kind='missing editable native table'));continue
            table=actual[name];rows=table.findall(T+'table-row')
            if len(rows)!=len(t['data']):misses.append(dict(block=bid,kind='editable row count',actual=len(rows)))
            cells={}
            for rowno,row in enumerate(rows):
                col=0
                for cell in row:
                    if cell.tag==T+'covered-table-cell':col+=1;continue
                    if cell.tag!=T+'table-cell':continue
                    def text(e):
                        result=e.text or ''
                        for ch in e:
                            if ch.tag=='{'+TEXT_NS+'}s':result+=' '*int(ch.get('{'+TEXT_NS+'}c','1'))
                            elif ch.tag=='{'+TEXT_NS+'}line-break':result+='\n'
                            else:result+=text(ch)
                            result+=ch.tail or ''
                        return result
                    literal='\n'.join(text(p) for p in cell.findall('{'+TEXT_NS+'}p'))
                    cells[rowno,col]=dict(text=literal,rowSpan=int(cell.get(T+'number-rows-spanned','1')),columnSpan=int(cell.get(T+'number-columns-spanned','1')))
                    col+=1
            for cell in lookup[bid]['cells']:
                key=cell['row'],cell['column'];value=cells.pop(key,None)
                expected=t['data'][key[0]][key[1]]
                if value is None or normalized(value['text'])!=normalized(expected) or (value['rowSpan'],value['columnSpan'])!=(cell['rowSpan'],cell['columnSpan']):
                    misses.append(dict(block=bid,cell=key,kind='exact editable cell/span mismatch',actual=value,expected=expected))
                checked+=1
            if cells:misses.append(dict(block=bid,kind='orphan editable semantic cells',actual=list(cells)))
    return dict(passed=not misses,semanticCellsChecked=checked,misses=misses,source='actual complete editable ODT content.xml, not exporter plan')


def primitives(authoring,plans,native):
    misses=[];checked=0;parents=[]
    with fitz.open(native) as doc:
        for page,ap,plan in zip(doc,authoring['pages'],plans):
            actual=[]
            for drawing in page.get_drawings():
                for item in drawing['items']:
                    if item[0]=='l':
                        p,q=item[1:];actual.append([p.x,p.y,q.x,q.y])
            for leaf in plan['leaves']:
                for path in leaf['primitivePaths']:
                    if not path.startswith('M'):continue
                    numbers=[float(x) for x in re.findall(r'-?\d+(?:\.\d+)?',path)];expected=numbers[:4]
                    distance=min((min(max(abs(x-y) for x,y in zip(line,expected)),max(abs(x-y) for x,y in zip(line[2:]+line[:2],expected))) for line in actual),default=1e9)
                    if distance>.5:misses.append(dict(id=leaf['id'],kind='missing/displaced mathematical primitive',expected=expected,nearestEndpointErrorPt=distance))
                    checked+=1
            # Occupied text unions for independently meaningful parent groups.
            for name in ['main-technical','discussion']:
                ids=[b['id'] for b in ap['blocks'] if b['glyphs'] and ((b['templateId'].startswith(('matrix.','math.'))) if name=='main-technical' else b['templateId'].startswith('discussion.'))]
                parents.append(dict(pageId=ap['id'],semanticParent=name,blockIds=ids,expectedOccupiedSupportPt=union(b['bboxPt'] for b in ap['blocks'] if b['id'] in ids)))
    return dict(passed=not misses,mathPrimitivesChecked=checked,semanticParents=parents,misses=misses,source='actual native PDF vector line objects')


def charts(spec,family,world,native):
    if family['classId']!='E3':return dict(passed=True,pagesChecked=0,misses=[])
    t=next(b for b in spec['enriched_derivatives']['E3']['layouts'][family['layoutId']]['blocks'] if b['id']=='chart')
    recipe=t['chart_shape']['placement_recipe'];plot=recipe['plot_rect_pt'];misses=[];checked=0
    colors=[(40/255,75/255,99/255),(141/255,101/255,72/255)]
    with fitz.open(native) as doc:
        for page,facts in zip(doc,world['pages']):
            drawings=page.get_drawings()
            all_lines=[[item[1].x,item[1].y,item[2].x,item[2].y] for d in drawings for item in d['items'] if item[0]=='l']
            x,y,z,w=plot
            for expected in [[x,y,z,y],[z,y,z,w],[z,w,x,w],[x,w,x,y]]:
                error=min((min(max(abs(a-b) for a,b in zip(line,expected)),max(abs(a-b) for a,b in zip(line[2:]+line[:2],expected))) for line in all_lines),default=1e9)
                if error>.5:misses.append(dict(page=facts['number'],kind='plot boundary missing/displaced',expected=expected))
            for series,values in enumerate(facts['chartSeries']):
                actual=[]
                for d in drawings:
                    color=d.get('color')
                    if color and max(abs(x-y) for x,y in zip(color,colors[series]))<.005:
                        for item in d['items']:
                            if item[0]=='l':p,q=item[1:];actual.append([p.x,p.y,q.x,q.y])
                points=[[plot[0]+(plot[2]-plot[0])*i/7,plot[3]-(plot[3]-plot[1])*float(v)/100] for i,v in enumerate(values)]
                expected=[p+q for p,q in zip(points,points[1:])]+[recipe['legend_swatches_pt'][series]]
                available=set(range(len(actual)))
                for segment,line in enumerate(expected):
                    def distance(i):return min(max(abs(x-y) for x,y in zip(actual[i],line)),max(abs(x-y) for x,y in zip(actual[i][2:]+actual[i][:2],line)))
                    nearest=min(available,key=distance) if available else None
                    if nearest is None or distance(nearest)>.5:misses.append(dict(page=facts['number'],series=series,segment=segment,kind='chart data/legend colored segment missing or displaced',expected=line))
                    else:available.remove(nearest)
                    checked+=1
                if available:misses.append(dict(page=facts['number'],series=series,kind='extra colored series/legend segments',actual=len(available)))
    return dict(passed=not misses,pagesChecked=len(world['pages']),coloredDataAndLegendSegmentsChecked=checked,misses=misses,source='independent actual native PDF colored vector segment endpoints against world numeric transform')


def check_round(directory):
    directory=Path(directory);results=[]
    for fid in [i for i in range(1,18) if i not in (6,12)]:
        p=directory/f'f{fid:04d}';a=json.loads((p/'authoring.json').read_text());r=json.loads((p/'source-layout.json').read_text());plans=[json.loads(f.read_text()) for f in sorted((p/'support-plans').glob('*.json'))]
        primitive=primitives(a,plans,p/'native.pdf');save(p/'native-primitive-reference-check.json',primitive)
        tables=None
        if a['producerPath']=='libreoffice-full':
            tables=writer_tables(a,r,p/'native.odt');save(p/'editable-native-table-check.json',tables)
        results.append(dict(familyId=fid,primitives=primitive['passed'],editableTables=tables['passed'] if tables else 'ReportLab Table path; no ODT applicable'))
    receipt=dict(passed=all(x['primitives'] and x['editableTables'] is not False for x in results),results=results);save(directory/'exact-native-reference-receipt.json',receipt);print(receipt)


if __name__=='__main__':
    import sys
    check_round(sys.argv[1])
