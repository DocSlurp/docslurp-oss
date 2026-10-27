"""Constructed-character table calibration, independent of any E content."""
import argparse
import fitz
from support import *
from producer import export


def main():
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args();root=args.output;root.mkdir()
    cases=[('mono',10,11.6407,0,False),('mono',10,12.25,1,True),('mono',9,10.4766,0,False),('mono',9,12.25,1,True),('sans',8,12,1,True)]
    blocks=[];tables={}
    for i,(kind,size,rh,padding,ruled) in enumerate(cases):
        bid=f'f0997.p01.table{i}';top=40+i*120
        blocks.append(dict(id=bid,templateId=f'table{i}',role='table',containerPt=[39,top,299,top+60],bboxPt=[39,top,299,top+60],zOrder=20))
        tables[bid]=dict(data=[['Hgj012','Hgj012','Hgj012','Hgj012'] for _ in range(3)],columnWidths=[50,60,70,80],rowHeight=rh,top=top,left=39,size=size,kind=kind,spans=[],ruled=ruled,padding=padding)
    a=dict(producerPath='libreoffice-full',pages=[dict(id='f0997.p01',number=1,blocks=blocks)])
    r=dict(pages=[dict(id='f0997.p01',placements={},tables=tables,figures={},draw={},paintOrder=[b['id'] for b in blocks])]);w=dict(title='Constructed table character calibration',role='Font calibration',date='2026-04-01',seed=123)
    save(root/'constructed-input.json',dict(authoring=a,resolved=r));save(root/'calibration-source.py',Path(__file__).read_bytes());proof=export(a,r,w,root);save(root/'producer-proof.json',proof)
    with fitz.open(proof['path']) as d:
        rows=[]
        for bid,t in tables.items():
            candidates=[span for span in d[0].get_texttrace() if abs(span['chars'][0][2][1]-(t['top']+FONTS[t['kind']].asc*t['size']))<5]
            origins=sorted(span['chars'][0][2] for span in candidates if chr(span['chars'][0][0])=='H')
            assert len(origins)==4
            expecty=t['top']+FONTS[t['kind']].asc*t['size'];xs=[39+t['padding']+sum(t['columnWidths'][:i]) for i in range(4)]
            rows.append(dict(key=f'{t["kind"]}|{t["size"]}|{t["rowHeight"]}|{t["padding"]}',baselineCorrection=sum(p[1]-expecty for p in origins)/len(origins),leftDeltas=[p[0]-x for p,x in zip(origins,xs)],source='constructed characters, fixed export style; no E content'))
        save(root/'table-calibration.json',rows);print(rows)
        d[0].get_pixmap(dpi=150).save(root/'actual-constructed-tables.png')


if __name__=='__main__':main()
