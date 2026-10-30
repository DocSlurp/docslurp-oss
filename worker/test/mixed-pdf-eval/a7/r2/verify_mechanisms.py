"""Validate the changed native table primitives on constructed controls only."""
from pathlib import Path
from collections import Counter
import json
import pymupdf
from reportlab_native import export

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round2/mechanism-setup')

def main():
    reports=[]
    for style in ['compact','wide','merged']:
        plan=json.loads((OUT/f'control-03-{style}.plan.json').read_text())
        obj=next(o for o in plan['objects'] if o['kind']=='table')
        target=OUT/f'reportlab-table-control-{style}.pdf'
        if not target.exists():
            export({'title':'Native table alignment control','author':'Mechanism validation','objects':[obj]},
                   {'leaves':[{'id':obj['id'],'containerPt':obj['nativeTablePt']}]},target)
        for producer,path in [('reportlab',target),('writer',OUT/f'control-03-{style}.pdf')]:
            with pymupdf.open(path) as d:
                assert len(d)==1
                traces=d[0].get_texttrace()
                expected=Counter(c for row in obj['data'] for value in row for c in value if not c.isspace())
                if producer=='writer':
                    expected.update(c for o in plan['objects'] if o['kind']=='text' for c in o['text'] if not c.isspace())
                actual=Counter(chr(c[0]) for t in traces for c in t['chars'] if not chr(c[0]).isspace())
                assert expected==actual,(style,producer,expected-actual,actual-expected)
                duplicate=Counter((c[0],tuple(c[2])) for t in traces for c in t['chars'] if not chr(c[0]).isspace())
                assert all(count==1 for count in duplicate.values())
                white=[draw for draw in d[0].get_drawings() if draw.get('fill')==(1,1,1)]
                assert not white
                if producer=='reportlab':d[0].get_pixmap(dpi=150).save(OUT/f'reportlab-table-control-{style}.png')
                reports.append({'style':style,'producer':producer,'exactMeaningfulGlyphMultiset':True,'repeatedOperations':0,
                                'whiteRectangleFills':0,'pageCount':1,'actualTableFontSizePt':obj['sizePt']})
        a=json.loads((OUT/f'control-03-{style}.readback-before.json').read_text())
        b=json.loads((OUT/f'control-03-{style}.readback-reloaded.json').read_text())
        assert [(x['identity'],x['properties']) for x in a['objects']]==[(x['identity'],x['properties']) for x in b['objects']]
        assert all(x['container']['membership'] is True for x in b['objects'])
        assert all(x['rawParentApi'].get('equalsActualDrawPage') is True for x in b['objects'] if 'unavailable' not in x['rawParentApi'])
        assert b['tables'][0]['parent']['bodyMembership'] is True
        assert a['tables'][0]['cellProperties']==b['tables'][0]['cellProperties']
        assert all(v['paragraph']['CharHeight']==obj['sizePt'] for v in b['tables'][0]['cellProperties'].values())
    (OUT/'mechanism-validation.json').write_text(json.dumps({'scope':'constructed mechanisms, not candidate acceptance','reports':reports,
        'actualParentAndPersistenceControls':True,'nativeTableCellsWithoutMarkup':True,'noNativeGlyphDeduplication':True,
        'unsupportedRawApi':'TextFrame does not expose XChild.getParent. Named remote-object equality proves actual DrawPage collection membership; saved ODT XML supplies actual structural parent independently. No body parent fallback is invented.'},indent=2)+'\n')
    print('Six constructed producer/table controls verified; parent and persistence checks verified.')

if __name__=='__main__':main()
