"""Noncandidate validation of ReportLab native Table/Flowable geometry."""
import json
from pathlib import Path
import pymupdf
from reportlab_native import export

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round1/mechanism-setup')

def main():
    p=OUT/'reportlab-control.pdf'
    table=dict(id='control.table',kind='table',data=[['Abcd','Efgh','','Ijkl'],['A0001','120','36000','300.0 K']],
               columnWidthsPt=[81]*4,paddingPt=1,rowHeightPt=12.25,sizePt=10,leadingPt=11.6407,rules=True,span=True,color=[.08,.1,.12],z=20)
    plan=dict(title='Constructed native table geometry',author='Mechanism validation',objects=[table])
    support={'leaves':[{'id':'control.table','containerPt':[39,308.641,363,333.141]}]}
    export(plan,support,p)
    with pymupdf.open(p) as d:
        traces=d[0].get_texttrace();first=traces[0]['chars'][0]
        assert abs(first[2][0]-40)<.001 and abs(first[2][1]-(308.641+8.3251953125))<.001
        assert all(t['font']=='LiberationMono' and t['size']==10 for t in traces)
        assert ''.join(chr(c[0]) for t in traces for c in t['chars'])=='AbcdEfghIjklA000112036000300.0 K'
        d[0].get_pixmap(dpi=150).save(OUT/'reportlab-control.png')
    (OUT/'reportlab-control.validation.json').write_text(json.dumps({'candidate':False,'nativeTableAndSpan':True,
        'fixedFontAndBaselineVerified':True,'glyphPopulationExact':True,'claim':'mechanism validation only'},indent=2))
    print('ReportLab constructed Table geometry verified')

if __name__=='__main__':main()
