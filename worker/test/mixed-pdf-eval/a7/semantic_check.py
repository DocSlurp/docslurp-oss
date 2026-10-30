"""Independent all-final-cell recomputation; uses frozen records, never candidate PDFs."""
from copy import deepcopy
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round1')

def rounded(value,places):
    return str((Decimal(value.numerator)/Decimal(value.denominator)).quantize(Decimal(places),rounding=ROUND_HALF_UP))

def inspect(author):
    family=author['familyId'];rows=author['table'][2:] if family==16 else author['table'][1:]
    w=author['world'];reports=[];misses=[]; ids=[row[0] for row in rows]
    expected=author['formula']['allObservationPopulation']
    if ids!=expected:misses.append({'kind':'observation population differs','actual':ids,'expected':expected})
    if len(rows)!=(6 if family==16 else 4):misses.append({'kind':'count mismatch','actual':len(rows)})
    def check(kind,actual,expected,scope,unit):
        reports.append({'kind':kind,'actual':actual,'expected':expected,'population':scope,'unit':unit})
        if actual!=expected:misses.append(reports[-1])
    if family==10:
        rates=[]
        for row,typed in zip(rows,w['rows']):
            volume=Fraction(Decimal(row[1]));seconds=Fraction(Decimal(row[2]));value=volume/seconds*60
            check('typed volume binding',row[1],typed['volumeL'],[row[0]],'L')
            check('typed elapsed binding',row[2],typed['elapsedS'],[row[0]],'s')
            check('L/min conversion and rounding',row[3],rounded(value,'.1'),[row[0]],'L/min')
            rates.append(value)
        check('all central values in reference band',all(Fraction('12')<=x<=Fraction('14') for x in rates),True,ids,'L/min')
        check('first result at lower reference limit',rates[0],Fraction('12'),[ids[0]],'L/min')
        check('first draw elapsed minutes',str(Fraction(Decimal(rows[0][2]))/60),author['formula']['variables']['t']['valueDecimal'],[ids[0]],'min')
        check('four printed volume literals',[row[1] for row in rows],['180','198','204','210'],ids,'L')
    elif family==16:
        means=[];sums=[];counts=[]
        for row,typed in zip(rows,w['rows']):
            count=Fraction(Decimal(row[1]));total=Fraction(Decimal(row[2]));mean=total/count
            check('typed count',row[1],typed['count'],[row[0]],'1')
            check('typed sum',row[2],typed['sumK'],[row[0]],'K')
            check('derived mean with visible unit',row[3],rounded(mean,'.1')+' K',[row[0]],'K')
            means.append(mean);sums.append(total);counts.append(count)
        check('six-row reference membership',all(Fraction(299)<=x<=Fraction(306) for x in means),True,ids,'K')
        check('warmer plateau sequence',all(a<b for a,b in zip(means,means[1:])),True,ids,'K')
        check('counts vary',len(set(counts))>1,True,ids,'1')
        subset=author['formula']['population'];check('visible early-cycle scope',subset,w['earlyCycle'],subset,'1')
        indices=[ids.index(id) for id in subset]
        weighted=sum(sums[i] for i in indices)/sum(counts[i] for i in indices)
        check('three-term weighted result',str(weighted),author['formula']['resultExact'],subset,'K')
        check('weighted result printed hundredths',rounded(weighted,'.01'),author['formula']['resultPrinted'],subset,'K')
        check('sample rate','10',w['sampleRateHz'],ids,'Hz')
        for number,index in enumerate(indices,1):
            check('AST count operand',author['formula']['variables'][f'n_{number}']['valueDecimal'],str(counts[index]),[ids[index]],'1')
            check('AST temperature operand',author['formula']['variables'][f'T_{number}']['valueDecimal'],str(means[index]),[ids[index]],'K')
        reports.append({'kind':'full population extrema','actual':[str(min(means)),str(max(means))],'population':ids,'unit':'K',
                        'role':'diagnostic empirical extrema, distinct from printed policy band'})
    else:
        for row,typed in zip(rows,w['rows']):
            v=Fraction(Decimal(row[1]));t=Fraction(Decimal(w['gainKPerMV']))*v+Fraction(Decimal(w['offsetK']))
            check('typed input',row[1],typed['inputMV'],[row[0]],'mV')
            check('nominal kelvin',t,Fraction(Decimal(row[2])),[row[0]],'K')
            check('Celsius conversion and rounding',row[3],rounded(t-Fraction(Decimal(w['kelvinCelsiusOffset'])),'.1'),[row[0]],'degC')
        before=list(map(Fraction,w['beforeMK']));after=list(map(Fraction,w['afterMK']))
        check('paired chart point counts',[len(before),len(after)],[8,8],w['xReadings'],'readings')
        check('all post-trim residuals within 10 mK',max(abs(x) for x in after)<=10,True,w['xReadings'],'mK')
        check('all pre-trim residuals positive',min(before)>0,True,w['xReadings'],'mK')
        for name,values in [('before',before),('after',after)]:
            check('nonmonotone '+name,any(b>a for a,b in zip(values,values[1:])) and any(b<a for a,b in zip(values,values[1:])),True,w['xReadings'],'mK')
        check('reference hold',w['holdReferenceK'],'294',w['xReadings'],'K')
    for val in [w['referenceInterval']['lower'],w['referenceInterval']['upper'],w['measurementTolerance']['value']]:Fraction(Decimal(val))
    check('policy lower below upper',Fraction(w['referenceInterval']['lower'])<Fraction(w['referenceInterval']['upper']),True,ids,w['referenceInterval']['unit'])
    check('positive absolute tolerance',Fraction(w['measurementTolerance']['value'])>0,True,ids,w['measurementTolerance']['unit'])
    return {'familyId':family,'observations':ids,'claims':reports,'misses':misses}

def jsonable(v):
    if isinstance(v,Fraction):return str(v)
    if isinstance(v,dict):return {k:jsonable(x) for k,x in v.items()}
    if isinstance(v,list):return [jsonable(x) for x in v]
    return v

def main():
    authors=[json.loads(p.read_text()) for p in sorted(OUT.glob('*.exact-authoring.json'))]
    assert len(authors)==3
    reports=[inspect(a) for a in authors];misses=[m for r in reports for m in r['misses']]
    controls=[]
    for a in authors:
        changed=deepcopy(a);changed['table'][-1][1]='989' if a['familyId']!=16 else '24001'
        controls.append({'name':'alter final non-prefix row f'+str(a['familyId']), 'detected':bool(inspect(changed)['misses'])})
    changed=deepcopy(next(a for a in authors if a['familyId']==16));changed['formula']['population']=['AM-0001','AM-0002','PM-0003']
    controls.append({'name':'wrong weighted subset scope','detected':bool(inspect(changed)['misses'])})
    changed=deepcopy(authors[0]);changed['table'].append(changed['table'][-1])
    controls.append({'name':'append observation without count update','detected':bool(inspect(changed)['misses'])})
    assert all(c['detected'] for c in controls)
    report=jsonable({'observedAtUtc':datetime.now(timezone.utc).isoformat(),'source':'all frozen final typed table cells; exact Decimal/Fraction arithmetic',
                     'reports':reports,'misses':misses,'negativeControls':controls,
                     'limitations':['Source-overlap and protected-name controls are dirty-side coordinator work; not executed here.',
                                    'Editorial, generic filler and synonym-template judgments require human/independent review; not certified by arithmetic.']})
    target=OUT/'pre-export-semantic-validation.json';assert not target.exists();target.write_text(json.dumps(report,indent=2)+'\n')
    print('SEMANTICS',len(misses),'misses;',len(controls),'mutation controls detected')

if __name__=='__main__':main()
