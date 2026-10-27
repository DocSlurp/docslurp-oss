"""Independent cell-based checks, separate from the authoring calculations."""
from __future__ import annotations
import copy
from decimal import Decimal, ROUND_HALF_UP
import re
from contract import digest, freeze
from prose import NUMBER_WORDS


def actual_rows(page,expanded):
    table=next(b for b in page['blocks'] if b['templateId']=='matrix.table')
    cells={(c['row'],c['column']):c for c in table['cells']}
    header=2 if expanded else 1
    rows=[]
    for row in sorted({r for r,c in cells if r>=header}):
        assert all((row,c) in cells for c in range(4)),('Incomplete semantic observation',row)
        rows.append((row,[cells[row,c] for c in range(4)]))
    return rows


def validate(authoring,world,relations=None):
    misses=[];checked=0
    for p,wp in zip(authoring['pages'],world['pages']):
        pid=p['id'];lookup={b['templateId']:b for b in p['blocks']};expanded=authoring['classId']=='E2'
        try:
            rows=actual_rows(p,expanded)
            assert len(rows)==(6 if expanded else 4),'Observation population cardinality'
            load=[Decimal(cells[1]['displayText']) for row,cells in rows]
            count_word=NUMBER_WORDS[len(rows)]
            for row,cells in rows:
                mass=Decimal(cells[1]['displayText']);elapsed=Decimal(cells[2]['displayText'])
                assert cells[1]['unit']=='mg' and cells[2]['unit']=='s','Column units'
                derived=(mass/elapsed*10).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
                printed=Decimal(cells[3]['displayText'].removesuffix(' U'))
                assert printed==derived,('Derived cell does not recompute',row)
            body=lookup['body.1']['displayText']
            assert re.search(r'\b'+count_word+r'\b',body),'Visible full-population count'
            bounds=re.search(r'(?:span|from|between|extends from)\s+(\d+(?:\.\d+)?)\s+(?:to|through|and)\s+(\d+(?:\.\d+)?)\s+mg',body)
            assert bounds and tuple(map(Decimal,bounds.groups()))==(min(load),max(load)),'Visible empirical extrema over actual complete population'
            quoted=lookup['discussion.excerpt']['displayText']
            assert re.search(r'\b'+count_word+r'\b',quoted),'Stale quoted count'
            constraint=lookup['math.constraint']['displayText']
            ref=re.fullmatch(r'(?:Policy|Reference) \[(\d+(?:\.\d+)?), (\d+(?:\.\d+)?)\] mg; abs (?:tol|tolerance) \+/-0\.2 mg',constraint)
            assert ref,'Reference interval kind, endpoint units, absolute tolerance purpose'
            lower,upper=map(Decimal,ref.groups())
            assert [str(lower),str(upper)]==wp['policy']['endpoints'],'Reference parameter changed'
            exceptions=sum(not lower<=v<=upper for v in load)
            second=lookup['body.2']['displayText']
            assert re.search(r'\b'+NUMBER_WORDS[exceptions]+r'\s+observations\b',second),'Reference exception count over full population'
            if expanded:
                assert re.search(r'observation rows 1, 3 and 6',second),'Weighted subset lacks visible scope'
            variables={v['symbol']:v for v in lookup['math.rule']['formula']['variables']}
            if relations is not None:
                page_rel=next(r for r in relations if r['pageId']==pid)
                formula_rel=next(r for r in page_rel['claims'] if r.get('blockId')==lookup['math.rule']['id'] and 'operands' in r)
                all_cells={table_row['id']:table_row for table_row in wp['observations']}
                for symbol,source in formula_rel['operands'].items():
                    var=variables[symbol]
                    if 'rowId' in source:
                        row_index=next(i for i,r in enumerate(wp['observations']) if r['id']==source['rowId'])
                        actual_cell=rows[row_index][1][source['column']]
                        assert Decimal(actual_cell['displayText'])==Decimal(var['valueDecimal']),('Formula cell binding',symbol)
                        assert actual_cell['unit']==var['unit'],('Formula cell units',symbol)
                    elif 'parameter' in source:
                        value=wp['calibration'][source['parameter']]
                        if 'index' in source:value=value[source['index']]
                        assert Decimal(value)==Decimal(var['valueDecimal']),('Frozen independent parameter',symbol)
            for symbol,v in variables.items():
                if symbol.startswith('v_'):
                    i=int(symbol[2:])-1 if expanded else (0 if symbol=='v_1' else len(rows)-1)
                    assert Decimal(v['valueDecimal'])==load[i],'Selected operand differs from actual cell'
                    assert v['unit']=='mg','Selected operand unit'
            if 'chart' in lookup:
                chart=lookup['chart']['chart']
                assert len(chart['data'])==2 and all(len(s['xDecimals'])==len(s['yDecimals'])==8 for s in chart['data']),'Full chart population'
                assert all(s['unitX']=='s' and s['unitY']=='mg' for s in chart['data']),'Chart units'
                assert len(chart['legend'])==2 and {l['seriesIndex'] for l in chart['legend']}=={0,1},'Legend associations'
            checked+=len(rows)+5
        except (AssertionError,ValueError,KeyError) as e:misses.append(dict(pageId=pid,kind='semantic-population-binding',detail=str(e)))
    return dict(passed=not misses,checks=checked,misses=misses,
        basis='Recomputed from actual authored semantic cells and compared to visible literals; no duplicated generated expected count')


def negative_controls(authoring,world):
    baseline=validate(authoring,world)
    assert baseline['passed'],baseline
    receipts=[]
    expanded=authoring['classId']=='E2'
    def mutate(name,fn):
        a=copy.deepcopy(authoring);fn(a['pages'][0])
        result=validate(a,world)
        assert not result['passed'],('Undetected semantic mutation',name)
        receipts.append(dict(name=name,detected=True,misses=result['misses']))
    def table(p):return next(b for b in p['blocks'] if b['templateId']=='matrix.table')
    def block(p,tid):return next(b for b in p['blocks'] if b['templateId']==tid)
    def append_extreme(p):
        cells=table(p)['cells'];newrow=max(c['row'] for c in cells)+1
        copied=copy.deepcopy([c for c in cells if c['row']==newrow-1])
        for c in copied:c['row']=newrow
        copied[1]['displayText']='999.9';cells.extend(copied)
    mutate('append-extreme-observation',append_extreme)
    def alter_nonprefix(p):
        cells=table(p)['cells'];last=max(c['row'] for c in cells)
        next(c for c in cells if c['row']==last and c['column']==1)['displayText']='998.8'
    mutate('change-final-nonprefix-observation',alter_nonprefix)
    def stale_quote(p):
        b=block(p,'discussion.excerpt');b['displayText']=re.sub(r'\b'+('six' if expanded else 'four')+r'\b','five',b['displayText'])
    mutate('stale-spelled-out-quoted-count',stale_quote)
    def wrong_kind(p):
        b=block(p,'math.constraint');b['displayText']=re.sub(r'^(Policy|Reference)','Empirical',b['displayText'])
    mutate('reference-relabeled-empirical',wrong_kind)
    def wrong_unit(p):
        b=block(p,'math.constraint');b['displayText']=b['displayText'].replace('mg','s')
    mutate('endpoint-unit-mismatch',wrong_unit)
    def wrong_tol(p):
        b=block(p,'math.constraint');b['displayText']=b['displayText'].replace('abs','relative')
    mutate('relative-versus-absolute-tolerance',wrong_tol)
    if expanded:
        def unscoped(p):
            b=block(p,'body.2');b['displayText']=b['displayText'].replace('observation rows 1, 3 and 6','readings chosen for convenience')
        mutate('unscoped-three-term-subset',unscoped)
    return dict(baseline=baseline,controls=receipts)
