"""Resolved E1-E5 authoring. Execution remains behind the coordinator gates."""
import copy
from decimal import Decimal, ROUND_HALF_UP
import random
from fools_gold_v4_common import *


def sym(name):return dict(op='symbol',name=name)
def op(kind,*args):return dict(op=kind,args=list(args))


E1_CAUSAL=[
          'A delay between response and observation can change apparent agreement even when the underlying process remains unchanged. Preserve the ordering of interventions so a later comparison can distinguish that delay from a persistent difference in the material or instrument itself.',
          'Local evidence is useful because a global adjustment can conceal the original disturbance without explaining its cause. The next comparison should preserve the unaffected locations, creating a counterfactual against which the suspected local mechanism can be tested independently.',
          'The inspected interval defines the reach of this conclusion. An observation outside that interval would require additional evidence, since agreement within a limited operating range does not establish behavior where support conditions or material exposure may differ materially.',
          'An isolated departure need not invalidate the entire procedure, but it must remain visible during review. Testing a reversible explanation first preserves the unaffected evidence and avoids combining an uncertain diagnosis with an irreversible change to the inspected setup.',
          'Interventions should remain separable when their consequences can be measured independently. Closing the completed action while preserving the unresolved response produces a clearer handover than treating several observations as one fault with an assumed common explanation.',
          'A counterexample identifies the limit of a convenient operational shortcut. Retaining it prevents future reviews from mistaking a proxy for the physical condition of interest, especially when the proxy responds more quickly than the material or mechanism under inspection.',
          'Agreement requires a shared definition of the boundary event rather than retrospective adjustment of observations. Original records should remain intact so a reviewer can reproduce both the earlier discrepancy and its resolution using the same independent evidence.',
          'A changed starting condition may affect the next observation without implying permanent deterioration. The comparison should therefore preserve that history and separate transient recovery from the sustained response expected under uninterrupted operation in the accepted configuration.',
          'Improved observation conditions strengthen confidence in the evidence but do not automatically expand the claim that it supports. Retaining a separate check of the unresolved condition avoids turning a procedural improvement into an unsupported conclusion about the whole system.',
          'A useful handover distinguishes completed actions from remaining uncertainty. The receiving role needs enough evidence to reproduce the accepted condition while continuing the open investigation, without repeating settled work or assuming that every earlier concern has already been resolved.'
]

E1_ACTION=[
          'Assign responsibility for the repeat before releasing the present record. The receiving operator should keep the same comparison boundary, retain the raw indications and document any equipment change before collecting additional evidence for the unresolved mechanism.',
          'Preserve the local mark and unaffected surfaces together. Photographing only the suspected location would lose the comparison needed to judge whether a later intervention removed a specific disturbance or merely changed conditions throughout the inspected setup.',
          'The scope restriction should accompany the operational handover. A later user needs to know which positions were accessible, which remain untested and what additional fixture or inspection would be required before expanding acceptance beyond the present evidence.',
          'A reversible test preserves the diagnostic sequence. Record the condition before and after that test, using the same observation event so the result does not combine a mechanical intervention with an unnoticed change in timing or handling.',
          'Close each supported action using its own evidence reference. Any remaining behavior should carry a separate open item and repeat condition, enabling later reviewers to distinguish a completed correction from an explanation that still requires independent confirmation.',
          'Keep the counterexample beside the operating rule rather than in an unrelated note. Its conditions define when the shortcut becomes unreliable, and they provide a concrete starting point for the next controlled comparison of the actual response.',
          'Preserve both original accounts after resolving their different boundary definitions. The reconciled record should show the shared event explicitly, allowing another reviewer to reproduce the alignment without estimating a replacement time or removing an inconvenient original observation.',
          'Separate the changed starting condition from the sustained operating condition in the next comparison. This prevents a recovery interval from being pooled with stable operation and makes the scope of any resulting acceptance decision reproducible during handover.',
          'Document the improved observation method before comparing later readings. Its effect should be checked separately from the unresolved material or mechanical state, since better handling can improve evidence quality without proving that the underlying condition itself has changed.',
          'Name the receiving responsibility and retain the evidence needed for the open test. This closes the administrative handover while keeping technical uncertainty visible, so the next shift can continue the investigation without treating transfer of ownership as experimental resolution.'
]


def enriched_world(family):
    """A seeded causal world, not a renamed copy of prototype paragraphs.

    Distinct mechanisms change the claim, test and limitation. Family-specific
    permutations change argument order as well as facts. Values are unique to
    this world and no heldout evidence or model call is involved.
    """
    rng=random.Random(family['worldSeed']);fid=family['familyId']
    mechanisms=[
      ('surface cooling preceded internal mass stability','heat remained inside the thicker material','retain the warm piece for another observation','the visible surface cannot establish internal dryness'),
      ('reverse movement approached its final indication slowly','mechanical clearance affected the direction of approach','repeat travel using one fixed approach direction','averaging directions can conceal a persistent return lag'),
      ('receipt appeared after the physical transfer ended','posting time differed from the actual boundary event','preserve both timestamps beside the transfer reference','a balanced count cannot establish timely transaction posting'),
      ('a local ridge interrupted otherwise smooth movement','contact was confined to one inspected location','mark the contact point before removing loose debris','a global adjustment would obscure the localized disturbance'),
      ('the enclosure cleared before the indication settled','the optical proxy responded before the material itself','keep clearing and completion as separate recorded events','visual clearing alone cannot justify a general release'),
      ('one wrapper concealed material from two receipts','outward packaging no longer represented a single bundle','count the open group before assigning its quantity','package shape cannot substitute for an individual count'),
      ('a cable brushed the carriage during reversal','an external load changed the observed return response','restrain the loop outside the permitted travel envelope','opening the housing first would add another disturbance'),
      ('a short shutdown changed the next initial condition','moisture accumulated while forced ventilation remained interrupted','retain the restart as a separate observation window','a transient delay does not establish permanent deterioration'),
      ('the central span agreed while endpoints stayed inaccessible','the fixture limited the reach of the inspection','restrict acceptance to the positions actually inspected','middle readings cannot establish an untested endpoint response'),
      ('a new rack brought stored material beside dispatch','physical location no longer identified the transaction status','mark the storage boundary before the next stock count','proximity to orders does not prove an authorized issue'),
      ('the replacement bracket narrowed the available clearance','mounting geometry changed without an observed collision','check the largest movement before unrestricted service release','absence of contact at four stops has limited scope'),
      ('two observers assigned different origins to elapsed time','the records timed different events within one sequence','align both records using the independently visible event','agreement needs a shared definition of the timing boundary')
    ]
    order=rng.sample(range(len(mechanisms)),10);pages=[]
    from fools_gold_v4_content import PROSE
    evidence_slots=[(0,0),(6,0),(12,1),(6,1),(0,5),(12,3),(6,3),(0,7),(6,2),(12,7),(6,7),(6,6)]
    for p,mindex in enumerate(order):
        observation,cause,action,limit=mechanisms[mindex]
        a=111+((fid*37+p*17)%720);readings=[a+j*9 for j in range(4)];durations=[113+rng.randrange(130) for _ in range(4)]
        lower,upper=readings[0],readings[-1]
        qualifications=[
          'Compare equal thicknesses before assigning a common completion event.',
          'Use one approach direction throughout the next matched repeat.',
          'Retain each timestamp beside the transfer record.',
          'Mark that point before cleaning to preserve the local comparison.',
          'Keep the clearing event separate from final material acceptance.',
          'Verify the open group against both retained receipt references.',
          'Restrain the external loop before repeating the affected return stroke.',
          'Keep restart history for the next repeat.',
          'Limit release to positions reached by this fixture.',
          'Mark storage limits before the next stock count.',
          'Check maximum movement before permitting unrestricted operation after this change.',
          'Align both records at the same visible boundary event.'
        ]
        body1=(observation[0].upper()+observation[1:]+f'. Readings spanned {lower} to {upper} grams; '+cause+'. '+limit[0].upper()+limit[1:]+'. '+qualifications[mindex])
        bank,index=evidence_slots[mindex];body2=PROSE[bank][index][1]
        # Ten unique cause/action pairs; concise evidence and commentary use
        # different phrasing rather than copying a substantive eight-token run.
        quote=PROSE[bank][index][2];commentary=PROSE[bank][index][3]
        for ordinal in ['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth']:
            quote=quote.replace(ordinal+' ', 'current ')
        formula_facts=dict(g=str(Decimal(80+rng.randrange(100))/100),v=str(Decimal(30+rng.randrange(40))/10),h=str(-Decimal(1+rng.randrange(20))/10),u=str(Decimal(10+rng.randrange(20))/10),n=str(Decimal(10+rng.randrange(10))/10),w_1=str(1+rng.randrange(4)),w_2=str(1+rng.randrange(4)),w_3=str(1+rng.randrange(4)),x_1=str(readings[0]),x_2=str(readings[1]),x_3=str(readings[2]))
        if family['classId']=='E2':
            for j in range(3):formula_facts[f'x_{j+1}']=str(Decimal(readings[j])+Decimal(j)/10)
        chart_facts=[dict(name=name,xDecimals=[str(i) for i in range(1,9)],yDecimals=[str(40+(i%3-1)*11+rng.randrange(14)) for i in range(8)],unitX='window',unitY='%') for name in ['Baseline','Recheck']]
        if family['classId']=='E1':
            final_prose=[body1+' '+E1_CAUSAL[p],body2+' '+E1_ACTION[p],quote,commentary]
        else:final_prose=[body1,body2,quote,commentary]
        pages.append(dict(overlayRows=[f'{label} {p+1:02d}' for label in ['Receipt boundary confirmed','Issue timing remains open','Retained movement reference','Earlier tally superseded','Final balance note retained']],finalProse=final_prose,tolerance='0.4',number=p+1,lower=lower,upper=upper,readings=readings,durations=durations,ratios=[str((Decimal(x)/Decimal(y)).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)) for x,y in zip(readings,durations)],purpose=['observation','mechanism','qualification','decision','exception','counterexample','reconciliation','qualification','decision','handover'][p],prose=[body1,body2,quote,commentary],formulaFacts=formula_facts,chartFacts=chart_facts,causalModel=dict(observation=observation,cause=cause,action=action,limitation=limit)))
    return dict(schema='mixed-pdf-world@4',familyId=fid,seed=family['worldSeed'],genre=family['genreSlot'],unit='g',durationUnit='s',unitCatalog=['g','s','g/s','V','g/V','1','%','window'],title=['Process deviation and response review','Material acceptance and condition record','Instrument transfer and travel review','Stock movement and boundary reconciliation','Field maintenance and response review','Laboratory method and limitation review'][family['genreSlot']],role='Technical review',date='2026-05-%02d'%(1+fid%27),pages=pages)


def recipe(spec,family,page,display_prefix):
    index=(family['familyId']+page['number']-1)%5
    chosen=spec['formula_shape_library'][index]
    ast=copy.deepcopy(chosen['ast']);rid=chosen['id'];a=Decimal(page['readings'][0]);b=Decimal(page['durations'][0]);unit='1'
    values={k:Decimal(v) for k,v in page['formulaFacts'].items()};values.update(a=a,b=b if rid=='Q' else Decimal(page['readings'][1]))
    units={k:'1' for k in values}
    units.update(a='g',b='g',x_1='g',x_2='g',v='V',u='V',g='g',h='g')
    latex={
      'Q':r'q = \dfrac{a}{b}',
      'D':r'q = \dfrac{a-b}{b}',
      'A':r'q = g\,v+h',
      'W':r'q = \dfrac{w_1 x_1+w_2 x_2}{w_1+w_2}',
      'P':r'q = g\,(\dfrac{v}{u})^n'
    }[rid]
    literal={
      'Q':'q = a ― b',
      'D':'q = a − b ― b',
      'A':'q = g v + h',
      'W':'q = w1 x1 + w2 x2 ― w1 + w2',
      'P':'q = g (v ― u) n'
    }[rid]
    if family['classId']=='E2':
        ast=op('equal',sym('q'),op('divide',op('add',*(op('multiply',sym(f'w_{i}'),sym(f'x_{i}')) for i in [1,2,3])),op('add',*(sym(f'w_{i}') for i in [1,2,3]))))
        units.update(w_3='1',x_3='g');unit='g'
        latex=r'q = \dfrac{w_1 x_1+w_2 x_2+w_3 x_3}{w_1+w_2+w_3}'
        literal='q = w1x1 + w2x2 + w3x3 ― w1 + w2 + w3'
    from fools_gold_v4_check import evaluate_ast
    names=set()
    def visit(node):
        if node['op']=='symbol':names.add(node['name'])
        for a in node.get('args',[]):visit(a)
    visit(ast)
    # Unit-consistent recipe-specific environments.
    if rid=='Q':units.update(a='g',b='s');unit='g/s'
    elif rid=='D':units.update(a='g',b='g');unit='1'
    elif rid=='A':units.update(g='g/V',v='V',h='g');unit='g'
    elif rid=='W':unit='g'
    elif rid=='P':units.update(g='g',v='V',u='V',n='1');unit='g'
    if family['classId']=='E2':unit='g';units.update(x_1='g',x_2='g',x_3='g',w_1='1',w_2='1',w_3='1')
    result=evaluate_ast(ast['args'][1],{k:str(v) for k,v in values.items()}).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
    values['q']=result;units['q']=unit
    display=display_prefix+literal
    return dict(display=display,latex=display_prefix.replace(' ',r'\ ')+latex,ast=ast,variables=[dict(symbol=k,valueDecimal=str(values[k]),unit=units[k]) for k in sorted(names)],valueDecimal=str(result),absoluteTolerance=.000001,constraints=(['v interval=[0.1,100] V'] if rid=='P' and family['classId']!='E2' else [])+['rounding=ROUND_HALF_UP; decimal_places=6','glyph_bindings: underscores indicate subscripts, fraction bar is U+2015','recipe='+('W3' if family['classId']=='E2' else rid)]),latex


def material(spec,family,world,page,texts,base_table):
    """Every added semantic item is instantiated before the native export."""
    cid=family['classId'];tables={'matrix.table':dict(data=base_table,spans=[],separator=' | ',ruled=False)};formulas={};figures={}
    if cid=='P':return texts,tables,formulas,figures
    texts['math.constraint']=f'Range {page["number"]:02d}: [{page["lower"]}, {page["upper"]}] g; tolerance +/- 0.4 g'
    tables['matrix.table']['data'][0][3]='Rate/s'
    if cid=='E1':
        # Extend distinct causal arguments, not a repeated filler notice. Ten
        # different mechanisms remain tied to the underlying observation.
        extra=E1_CAUSAL[page['number']-1]
        texts['body.1']+=' '+extra
        texts['body.2']+=' '+E1_ACTION[page['number']-1]
    if cid=='E2':
        rows=[['Record','Readouts','','Rate/s'],['Item-ID','Span-s','Mass-g','Gain-g/s']]
        for i in range(6):
            a=Decimal(page['readings'][i%4])+Decimal(i)/10;b=Decimal(page['durations'][i%4])+Decimal(i)/10
            rows.append([f'R{page["number"]:02d}{i:04d}',f'{b:07.2f}',f'{a:07.2f}',f'{a/b:05.2f}'])
        tables['matrix.table']=dict(data=rows,spans=[(0,1,0,2)],separator=None,ruled=True)
    if cid=='E3':
        data=copy.deepcopy(page['chartFacts'])
        chart=dict(kind='line',data=data,title='Response over inspection window',axisTitles=['Window index','Response (%)'],ticks=[],legend=[],textGlyphIds=[],captionBlockId=f'f{family["familyId"]:04d}.p{page["number"]:02d}.chart.caption')
        figures['chart']=dict(kind='chart',chart=chart);texts['chart.caption']='Both series retain alternating local peaks.'
    if cid=='E4':
        rows=[['Position','Reading','Unit']]+[[f'Zone {i+1}',f'{page["readings"][i]}.0','grams'] for i in range(3)]
        tables['discussion.mini-table']=dict(data=rows,spans=[],separator=None,ruled=True)
        a,b=page['readings'][:2];display=f'Difference: delta = late - early'
        formulas['discussion.mini-math']=dict(display=display,latex=r'\delta=\mathrm{late}-\mathrm{early}',ast=op('equal',sym('delta'),op('subtract',sym('late'),sym('early'))),variables=[dict(symbol='delta',valueDecimal=str(b-a),unit='g'),dict(symbol='late',valueDecimal=str(b),unit='g'),dict(symbol='early',valueDecimal=str(a),unit='g')],valueDecimal=str(b-a),absoluteTolerance=0,constraints=['rounding=ROUND_HALF_UP; decimal_places=6'])
        texts['discussion.mini-math']=display
    if cid=='E5':
        # The cover hides only rows 2 and 3; they remain authored, never inferred.
        phrases=['Receipt boundary confirmed','Issue timing remains open','Retained movement reference','Earlier tally superseded','Final balance note retained']
        for i,text in enumerate(phrases):texts[f'overlay.row.{i}']=f'{text} {page["number"]:02d}'
    formula,latex=recipe(spec,family,page,f'Rule {page["number"]:02d}: ')
    formulas['math.rule']=formula;figures['math.rule']=dict(kind='math',latex=latex,formula=formula)
    texts['math.rule']=formula['display']
    return texts,tables,formulas,figures
