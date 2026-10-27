"""Bounded offline XML/row-separator evidence; never repairs native readbacks."""
from pathlib import Path
from decimal import Decimal
from datetime import datetime,timezone
import hashlib
import json
import zipfile
import xml.etree.ElementTree as ET

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4')
NS={n:'urn:oasis:names:tc:opendocument:xmlns:'+uri+':1.0' for n,uri in
    [('style','style'),('table','table'),('office','office'),('fo','xsl-fo-compatible')]}

def attr(element,prefix,name):return element.get('{'+NS[prefix]+'}'+name)

def points(text):
    assert text is not None,'Missing explicit XML dimension'
    for suffix,factor in [('in',Decimal(72)),('cm',Decimal(7200)/254),('mm',Decimal(720)/254),('pt',Decimal(1))]:
        if text.endswith(suffix):return Decimal(text[:-len(suffix)])*factor
    raise ValueError('Unsupported XML dimension: '+text)

def main():
    reports=[]
    for pp in sorted(OUT.glob('*.drawing-plan.json')):
        plan=json.loads(pp.read_text());stem=plan['stem'];table=next(o for o in plan['objects'] if o['kind']=='table')
        odt=OUT/(stem+'.odt');pdf=OUT/(stem+'.pdf')
        with zipfile.ZipFile(odt) as z:content=z.read('content.xml');styles=z.read('styles.xml')
        roots=[ET.fromstring(content),ET.fromstring(styles)];r=roots[0]
        definitions={attr(s,'style','name'):s for root in roots for s in root.findall('.//style:style',NS)}
        native=r.find('.//table:table',NS);assert native is not None
        parent={child:node for node in r.iter() for child in node}
        assert parent[native].tag=='{'+NS['office']+'}text','Native table is not a direct body child'
        properties=definitions[attr(native,'table','style-name')].find('style:table-properties',NS)
        assert attr(properties,'table','align')=='margins','Unsupported XML table alignment'
        width=points(attr(properties,'style','width'));left=points(attr(properties,'fo','margin-left'));right=points(attr(properties,'fo','margin-right'))
        masters=[m for root in roots for m in root.findall('.//style:master-page',NS)]
        master=next(m for m in masters if attr(m,'style','name')=='Standard')
        layouts={attr(l,'style','name'):l for root in roots for l in root.findall('.//style:page-layout',NS)}
        page=layouts[attr(master,'style','page-layout-name')].find('style:page-layout-properties',NS)
        page_width=points(attr(page,'fo','page-width'));page_height=points(attr(page,'fo','page-height'))
        page_left=points(attr(page,'fo','margin-left'));page_right=points(attr(page,'fo','margin-right'))
        assert page_width==612 and page_height==792 and page_left==page_right==0
        columns=[]
        for col in native.findall('table:table-column',NS):
            st=definitions[attr(col,'table','style-name')].find('style:table-column-properties',NS)
            value=points(attr(st,'style','column-width'))
            columns.extend([value]*int(attr(col,'table','number-columns-repeated') or 1))
        assert len(columns)==4
        boundaries=[left]
        for value in columns:boundaries.append(boundaries[-1]+value)
        row_cells=[]
        for ri,row in enumerate(native.findall('table:table-row',NS)):
            for repeat in range(int(attr(row,'table','number-rows-repeated') or 1)):
                cells=[];ci=0
                for cell in row:
                    if cell.tag not in ['{'+NS['table']+'}table-cell','{'+NS['table']+'}covered-table-cell']:continue
                    for _ in range(int(attr(cell,'table','number-columns-repeated') or 1)):
                        cells.append({'physicalColumn':ci,'covered':cell.tag.endswith('}covered-table-cell'),
                                      'columnSpan':int(attr(cell,'table','number-columns-spanned') or 1),
                                      'rowSpan':int(attr(cell,'table','number-rows-spanned') or 1)})
                        ci+=1
                assert ci==4
                row_cells.append({'row':ri+repeat,'cells':cells})
        before=json.loads((OUT/(stem+'.readback-before.json')).read_text())['tables'][0]
        after=json.loads((OUT/(stem+'.readback-reloaded.json')).read_text())['tables'][0]
        diag=after['widthDiagnosticAfterPagination'];den=Decimal(diag['direct']['TableColumnRelativeSum']['value'])
        assert den==10000 and diag['direct']['HoriOrient']['value']==0 and diag['direct']['IsWidthRelative']['value'] is False
        row_positions=[]
        for row in diag['rows']:
            values=row['TableColumnSeparators']
            if 'value' in values:
                measured=[left+Decimal(s['Position'])/den*width for s in values['value']]
                row_positions.append({'row':row['index'],'raw':values['value'],'positionsFromXmlMarginsAndRawSeparatorsPt':list(map(str,measured)),
                                     'distanceToNearestExplicitXmlBoundaryPt':[str(min(abs(x-y) for y in boundaries[1:-1])) for x in measured]})
            else:row_positions.append({'row':row['index'],'queryError':values})
        strict_deltas=[abs(value-Decimal(str(expected))) for value,expected in zip(columns,table['columnWidthsPt'])]
        reports.append({'familyId':plan['familyId'],'odtSha256':hashlib.sha256(odt.read_bytes()).hexdigest(),
            'pdfSha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'planSha256':hashlib.sha256(pp.read_bytes()).hexdigest(),
            'contentXmlSha256':hashlib.sha256(content).hexdigest(),'stylesXmlSha256':hashlib.sha256(styles).hexdigest(),
            'bodyOwnershipFromXml':True,'alignment':'margins','pageSizePt':[str(page_width),str(page_height)],
            'explicitWidthPt':str(width),'leftMarginPt':str(left),'rightMarginPt':str(right),
            'pageMarginWidthClosureErrorPt':str(left+width+right-page_width),
            'expandedColumnWidthsPt':list(map(str,columns)),'expandedBoundariesPt':list(map(str,boundaries)),
            'columnSumVsExplicitWidthDeltaPt':str(sum(columns)-width),'rowsAndSpans':row_cells,'rawPerRowSeparatorEvidence':row_positions,
            'rawWidthBefore':before['properties']['Width'],'rawWidthAfter':after['properties']['Width'],
            'rawWidthPersistenceEqual':before['properties']['Width']==after['properties']['Width'],
            'strictPoint03ColumnDiagnostic':{'thresholdPt':'0.03','individualDeltasPt':list(map(str,strict_deltas)),
                'flags':[i for i,v in enumerate(strict_deltas) if v>Decimal('.03')],
                'role':'Retained strict diagnostic, not a newly imposed source-fidelity tolerance or acceptance decision.'}})
    target=OUT/'xml-width-and-row-evidence.json';assert not target.exists();target.write_text(json.dumps({
        'observedAtUtc':datetime.now(timezone.utc).isoformat(),'reports':reports,
        'widthGetterForced':False,'rawPersistenceClaim':False,'acceptanceClaim':False,
        'limits':'This supplies saved XML and raw-separator evidence. Native-PDF cell geometry, original ink checks and independent adjudication remain separate.'},indent=2)+'\n')
    print('XML geometry evidence saved for',len(reports),'actual ODTs; strict diagnostics retained.')

if __name__=='__main__':main()
