"""Invoke the two independent native producers once, without modifying frozen inputs."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import traceback
from reportlab_native import export
from run_writer import launch

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4')

def main():
    freeze=json.loads((OUT/'FREEZE.json').read_text())
    for name,expected in freeze['files'].items():assert hashlib.sha256((OUT/name).read_bytes()).hexdigest()==expected,name
    assert json.loads((OUT/'pre-export-semantic-validation.json').read_text())['misses']==[]
    for i,path in enumerate(sorted(OUT.glob('*.drawing-plan.json'))):
        stem=path.name.removesuffix('.drawing-plan.json');plan=json.loads(path.read_text())
        support=json.loads((OUT/(stem+'.support.json')).read_text())
        receipt={'startedAtUtc':datetime.now(timezone.utc).isoformat(),'attempt':7,'formalRound':4,'familyId':plan['familyId'],
                 'frozenInputsSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'permutation':'none; untouched original previews only'}
        try:
            target=OUT/(stem+'-reportlab-original.pdf')
            export(plan,support,target)
            receipt['reportlab']={'status':'exported','pdf':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
        except Exception:
            receipt['reportlab']={'status':'failed','error':traceback.format_exc()}
        try:
            assert not (OUT/(plan['stem']+'.pdf')).exists()
            code=launch(path,OUT,'a7formalround4family'+str(plan['familyId']),OUT/'FREEZE.json')
            target=OUT/(plan['stem']+'.pdf')
            receipt['writer']={'status':'exported' if code==0 else 'failed','exitCode':code,'pdf':str(target),
                               'artifactReceipt':str(OUT/(plan['stem']+'.artifact-receipt.json')),
                               'outerExecution':str(OUT/(plan['stem']+'.execution.json')),
                               'sha256':hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None}
        except Exception:receipt['writer']={'status':'failed','error':traceback.format_exc()}
        receipt['finishedAtUtc']=datetime.now(timezone.utc).isoformat()
        record=OUT/(stem+'.execution.json');assert not record.exists();record.write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps(receipt),flush=True)

if __name__=='__main__':main()
