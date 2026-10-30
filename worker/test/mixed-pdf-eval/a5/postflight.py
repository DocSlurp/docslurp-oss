"""Read-only reconciliation after the bounded attempt. Never exports PDFs."""
import argparse
import datetime
from pathlib import Path
import re
import json
from support import *
from maths import parse


def latex_ast(latex):
    text=latex.replace(r'\left','').replace(r'\right','').replace(r'\cdot','*')
    text=re.sub(r'([A-Za-z])_\{([0-9]+)\}',r'\1_\2',text)
    while r'\frac{' in text:
        start=text.index(r'\frac{');pos=start+5;groups=[]
        for _ in range(2):
            assert text[pos]=='{';first=pos+1;depth=1;pos+=1
            while depth:
                if text[pos]=='{':depth+=1
                if text[pos]=='}':depth-=1
                pos+=1
            groups.append(text[first:pos-1])
        text=text[:start]+'(('+groups[0]+')/('+groups[1]+'))'+text[pos:]
    text=re.sub(r'\^\{([^{}]+)\}',r'^(\1)',text)
    text=re.sub(r'([A-Za-z0-9_)])\s*(\()',r'\1*\2',text)
    return parse(text)


def reconcile(directory):
    directory=Path(directory);records=[];misses=[];latex_count=0;freeze_count=0
    for fid in [i for i in range(1,18) if i not in (6,12)]:
        p=directory/f'f{fid:04d}';a=json.loads((p/'authoring.json').read_text());w=json.loads((p/'world.json').read_text());receipt=json.loads((p/'family-receipt.json').read_text())
        assert a['authoringHash']==digest({k:v for k,v in a.items() if k!='authoringHash'})
        assert w['worldHash']==digest({k:v for k,v in w.items() if k!='worldHash'})
        assert (p/'freeze-receipt.json').stat().st_mtime_ns<=(p/'native.pdf').stat().st_mtime_ns
        for page,facts in zip(a['pages'],w['pages']):
            plan=json.loads((p/'support-plans'/f'{page["id"]}.json').read_text());assert plan['planHash']==digest({k:v for k,v in plan.items() if k!='planHash'});freeze_count+=1
            for b in page['blocks']:
                if b['formula'] and b['templateId']!='math.constraint':
                    try:assert latex_ast(b['formula']['latex'])==b['formula']['ast']
                    except Exception as error:misses.append(dict(id=b['id'],kind='LaTeX/AST reference mismatch',error=repr(error)))
                    latex_count+=1
            # The printed row count and the prose must agree independently of
            # the generator's four-row default. Retain findings, never change
            # frozen prose or limits to turn an observation into a pass.
            if a['classId']=='E2':
                table=next(b for b in page['blocks'] if b['templateId']=='matrix.table')
                observations=sorted({c['row'] for c in table['cells'] if c['row']>=2})
                body=normalized(next(b['displayText'] for b in page['blocks'] if b['templateId']=='body.1'))
                if re.search(r'\bFour readings\b',body) and len(observations)!=4:
                    misses.append(dict(id=page['id'],kind='authored observation-count inconsistency',proseCount=4,tableObservationRows=len(observations)))
                masses=[c for c in table['cells'] if c['row']>=2 and c['column']==2]
                from decimal import Decimal
                if any(not Decimal(facts['lower'])<=Decimal(c['value'])<=Decimal(facts['upper']) for c in masses):
                    misses.append(dict(id=page['id'],kind='expanded-table interval interpretation requires coordinator review',printedInterval=[facts['lower'],facts['upper']],observedMassRange=[min(Decimal(c['value']) for c in masses).__str__(),max(Decimal(c['value']) for c in masses).__str__()],detail='Six-row matrix extends beyond the interval described by the narrative; do not promote as internally reconciled.'))
        native=json.loads((p/'native-check.json').read_text())
        records.append(dict(familyId=fid,classLayout=a['classId']+'-'+a['layoutId'],producer=a['producerPath'],nativeGate=receipt['status'],nativeMisses=receipt.get('nativeMisses'),minimumLeafIoU=min(row['minLeafIoU'] for row in native['pages']),minimumSemanticParentIoU=min(row['minSemanticParentIoU'] for row in native['pages']),nativeHash=digest((p/'native.pdf').read_bytes()),worldHash=w['worldHash'],authoringHash=a['authoringHash']))
    report=dict(schema='attempt5-bounded-postflight@1',observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),attempt=5,roundsUsed=4,maxBuildRounds=4,uniqueAuthoredPages=150,families=records,immutableSupportPlansVerified=freeze_count,latexAstReferencesChecked=latex_count,additionalFindings=misses,status='unaccepted; fourth round exhausted',all15NativeClean=all(r['nativeGate']=='native-checks-clean' for r in records),stageAdvancementRequested=False,nextAction='Coordinator decides next attempt; no additional build under attempt 5.',auditOrJudgeScoreAssigned=False,apiCalls=0,paidCostUsd=0,commitsMade=0,heldoutAccess=False,pilotOrFullGenerated=False)
    save(directory.parent/'final-preflight-receipt.json',report)
    save(directory.parent/'postflight-source.py',Path(__file__).read_bytes())
    print(json.dumps(dict(status=report['status'],nativeGatePassingFamilies=sum(r['nativeGate']=='native-checks-clean' for r in records),additionalFindings=len(misses),latexAstReferencesChecked=latex_count,immutablePlans=freeze_count)))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('round_directory',type=Path);args=parser.parse_args();reconcile(args.round_directory)
