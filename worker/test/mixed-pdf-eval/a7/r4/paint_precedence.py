"""Read-only proof for the retained E3 rotated-axis persistence reindexing.

Raw ZOrder changes stay in the readbacks. This checks actual final native ink,
not an assumed meaning for global requested ZOrder integers.
"""
from datetime import datetime, timezone
from pathlib import Path
import json
import sys
import pymupdf

HANDOFF=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a7-clean-r2')
OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4')
sys.path.insert(0,str(HANDOFF/'generic'))
from support import union,area,intersect

def main():
    stem='f0002-E3-A-p01-writer-original'
    before=json.loads((OUT/(stem+'.readback-before.json')).read_text())
    after=json.loads((OUT/(stem+'.readback-reloaded.json')).read_text())
    a={o['identity']:o for o in before['objects']};b={o['identity']:o for o in after['objects']}
    axis='f0002.p01.chart.yaxis'
    native=json.loads((OUT/'evidence'/(stem+'.native-glyphs.json')).read_text())['glyphs']
    matching=json.loads((OUT/'evidence'/(stem+'.glyph-match-details.json')).read_text())
    axis_indices={m['actualIndex'] for m in matching if m['id'].startswith(axis+'.g')}
    assert axis_indices,'Actual axis glyph identity was not resolved'
    axis_ink=union([native[i]['ink'] for i in axis_indices]);hits=[]
    for i,g in enumerate(native):
        if i not in axis_indices and area(intersect(axis_ink,g['ink']))>0:
            hits.append({'kind':'other actual text ink','nativeGlyphIndex':i,'glyph':g})
    with pymupdf.open(OUT/(stem+'.pdf')) as doc:
        for i,d in enumerate(doc[0].get_drawings()):
            x,y,r,z=d['rect'];half=(d.get('width') or 0)/2
            ink=[x-half,y-half,r+half,z+half]
            if area(intersect(axis_ink,ink))>0:
                hits.append({'kind':'actual vector paint bbox','drawingIndex':i,'inkPt':ink,'nativeSequenceNumber':d['seqno']})
    changes=[{'id':id,'beforeZOrder':a[id]['properties']['ZOrder'],'afterZOrder':b[id]['properties']['ZOrder'],
              'beforeLayer':a[id]['properties'].get('LayerID'),'afterLayer':b[id]['properties'].get('LayerID')}
             for id in a if a[id]['properties']['ZOrder']!=b[id]['properties']['ZOrder']]
    order_before=sorted((id for id in a if id!=axis),key=lambda id:a[id]['properties']['ZOrder'])
    order_after=sorted((id for id in b if id!=axis),key=lambda id:b[id]['properties']['ZOrder'])
    report={'observedAtUtc':datetime.now(timezone.utc).isoformat(),'axisId':axis,'actualAxisInkPt':axis_ink,
            'rawRealizedZOrderChanges':changes,'allOtherObjectRelativeOrdersUnchanged':order_before==order_after,
            'axisLayerUnchanged':a[axis]['properties'].get('LayerID')==b[axis]['properties'].get('LayerID'),
            'actualInkIntersections':hits,'nonIntersectionProved':not hits,
            'method':'Actual embedded-font glyph ink from native PDF, plus actual painted vector bounds including stroke width; raw persistence snapshots retained.',
            'limits':'This disjoint-ink proof addresses only rotated-axis reindexing. It is not a table-Width proof, full glyph-mask certificate, ten-page stream-order control or acceptance decision.'}
    target=OUT/'e3-zorder-nonintersection.json';assert not target.exists();target.write_text(json.dumps(report,indent=2)+'\n')
    print('E3 actual-axis ink intersections:',len(hits),'other relative orders unchanged:',order_before==order_after)

if __name__=='__main__':main()
