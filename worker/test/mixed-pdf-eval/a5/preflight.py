#!/usr/bin/env python3
"""Only the authorized 15-family native preflight. No pilot/full stage exists."""
import argparse
from concurrent.futures import ProcessPoolExecutor,as_completed
import datetime
from importlib.metadata import version,distribution
import shutil
import subprocess
import traceback
from support import *

FAMILY_IDS=[i for i in range(1,18) if i not in (6,12)]


def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()


def build_one(task):
    from content import new_world
    from author import resolve
    from check import semantic_checks,native_check
    from producer import export
    from world_schema import validate_world
    from references import charts,primitives,writer_tables
    family=task['family'];directory=Path(task['directory'])/f'f{family["familyId"]:04d}'
    directory.mkdir()
    os.environ['MPLCONFIGDIR']=str(Path(task['scratch'])/f'mpl-{family["familyId"]}')
    result=dict(familyId=family['familyId'],classLayout=family['classId']+'-'+family['layoutId'],producer=family['producerPath'],attempt=5,round=task['round'],status='provisional',startedAt=now())
    try:
        world=new_world(family);validate_world(world,family);save(directory/'world.json',world)
        a,plans,r,misses=resolve(task['spec'],family,world,task['versions'])
        save(directory/'authoring-budget-check.json',dict(passed=not misses,misses=misses))
        save(directory/'authoring.json',a);save(directory/'source-layout.json',r)
        for p in plans:save(directory/'support-plans'/f'{p["pageId"]}.json',p)
        semantic=semantic_checks(task['spec'],family,world,a,plans,r);save(directory/'semantic-check.json',semantic)
        save(directory/'freeze-receipt.json',dict(frozenAt=now(),worldHash=world['worldHash'],authoringHash=a['authoringHash'],supportPlanHashes=[p['planHash'] for p in plans],beforeNativeExport=True))
        if misses or not semantic['passed']:
            result.update(status='authoring-failed',budgetMisses=len(misses),semanticMisses=len(semantic['misses']))
            return result
        # Apply calibration only to export parameters, never the frozen target.
        # Values came from constructed characters prior to E authoring.
        for page in r['pages']:page['baselineCalibration']=task['calibration']
        for page in r['pages']:
            for table in page['tables'].values():
                key=f'{table["kind"]}|{table["size"]}|{table["rowHeight"]}|{table["padding"]}'
                table.update(task['tableCalibration'].get(key,{}))
        proof=export(a,r,world,directory);save(directory/'producer-proof.json',proof)
        result['nativeHash']=digest(Path(proof['path']).read_bytes())
        check=native_check(a,plans,proof['path'],directory/'renders');save(directory/'native-check.json',check)
        chart_check=charts(task['spec'],family,world,proof['path']);save(directory/'actual-chart-reference-check.json',chart_check)
        primitive_check=primitives(a,plans,proof['path']);save(directory/'native-primitive-reference-check.json',primitive_check)
        table_check=writer_tables(a,r,directory/'native.odt') if family['producerPath']=='libreoffice-full' else dict(passed=True,owner='ReportLab Table API')
        save(directory/'editable-native-table-check.json',table_check)
        reference_passed=all(c['passed'] for c in [chart_check,primitive_check,table_check])
        with __import__('fitz').open(proof['path']) as doc:
            save(directory/'native-profile.json',dict(pages=len(doc),metadata=doc.metadata,fonts=[list(row[:6]) for row in doc[0].get_fonts(full=True)],version=doc.pdf_version() if hasattr(doc,'pdf_version') else None))
        result.update(status='native-checks-clean' if check['passed'] and reference_passed else 'native-checks-failed',nativeMisses=len(check['misses'])+sum(len(c.get('misses',[])) for c in [chart_check,primitive_check,table_check]),pages=len(check['pages']),minGlyphIoU=min(p['minGlyphIoU'] for p in check['pages']))
        print(json.dumps(dict(event='family-native-checked',**result)),flush=True)
    except Exception as error:
        result.update(status='failed',error=repr(error));save(directory/'failure.txt',traceback.format_exc())
    finally:
        result['endedAt']=now();save(directory/'family-receipt.json',result)
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a5'))
    p.add_argument('--scratch',type=Path,required=True)
    p.add_argument('--round',type=int,choices=[1,2,3,4],required=True)
    p.add_argument('--workers',type=int,choices=[1,2,3],default=3)
    args=p.parse_args();verify_clean()
    spec=json.loads((CLEAN/'spec-a5.json').read_text());directory=args.output/f'round-{args.round}'
    assert not directory.exists(),'Each formal round needs a fresh directory'
    directory.mkdir(parents=True)
    health=subprocess.check_output(['/home/dan/.local/bin/agent-temp-health']).decode();save(directory/'temp-health.json',health)
    for file in CLEAN.rglob('*'):
        if file.is_file() and '__pycache__' not in file.parts:save(directory/'clean-inputs'/file.relative_to(CLEAN),file.read_bytes())
    source_hashes={}
    for file in ROOT.glob('*.py'):
        save(directory/'builder-source'/file.name,file.read_bytes());source_hashes[file.name]=digest(file.read_bytes())
    packages=['reportlab','PyMuPDF','fonttools','matplotlib','Pillow','numpy','pikepdf','jsonschema']
    package_hashes={}
    for name in packages:
        dist=distribution(name);files={}
        for rel in dist.files or []:
            if '__pycache__' in str(rel) or str(rel).endswith('.pyc'):continue
            path=dist.locate_file(rel)
            if path.is_file():files[str(rel)]=digest(path.read_bytes())
        package_hashes[name]=dict(manifestHash=digest(files),files=files)
    versions=dict(packages={name:version(name) for name in packages},packageCodeHashes=package_hashes,producer=subprocess.check_output(['soffice','--version']).decode().strip(),executables={name:dict(path=shutil.which(name),sha256=digest(Path(shutil.which(name)).read_bytes())) for name in ['soffice','qpdf','gs']},fonts={k:dict(path=str(f.path),hash=f.hash) for k,f in FONTS.items()})
    save(directory/'tools.json',versions)
    calibration={}
    table_calibration={}
    cal=args.output/'calibration-r1/baseline-results.json'
    if cal.exists():
        rows=json.loads(cal.read_text());keys=[('sans',10,14.7705),('sans',13,19.2017),('sans',9,13.2935),('sans',8,12),('mono',10,11.6407),('mono',9,10.4766),('mono',8,12)]
        for row,(kind,size,lead) in zip(rows,keys):calibration[f'{kind}|{size}|{lead}']=row['difference']
        save(directory/'constructed-baseline-calibration.json',dict(sourceHash=digest(cal.read_bytes()),calibration=calibration))
    table_cal=args.output/'table-calibration-r2-ruled/table-calibration.json'
    if table_cal.exists():
        for row in json.loads(table_cal.read_text()):
            assert max(row['leftDeltas'])-min(row['leftDeltas'])<.15,'Constructed table grid still expands'
            table_calibration[row['key']]=dict(baselineCorrection=row['baselineCorrection'],leftCorrection=sum(row['leftDeltas'])/len(row['leftDeltas']))
        save(directory/'constructed-table-calibration.json',dict(sourceHash=digest(table_cal.read_bytes()),calibration=table_calibration))
    initial=dict(schema='attempt5-native-preflight@1',attempt=5,round=args.round,startedAt=now(),familyIds=FAMILY_IDS,authoredPages=150,maxWorkers=args.workers,apiCalls=0,paidCostUsd=0,builderHashes=source_hashes,handoffHash=digest({name:digest((CLEAN/name).read_bytes()) for name in ['spec-a5.md','spec-a5.json']}),status='provisional; no audit/judge acceptance')
    save(directory/'preflight-start.json',initial)
    tasks=[dict(family=spec['dataset']['family_plan'][i],directory=str(directory),scratch=str(args.scratch),round=args.round,spec=spec,versions=versions,calibration=calibration,tableCalibration=table_calibration) for i in FAMILY_IDS]
    results=[]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures=[pool.submit(build_one,t) for t in tasks]
        for future in as_completed(futures):
            result=future.result();results.append(result);print(json.dumps(result),flush=True)
    results.sort(key=lambda r:r['familyId'])
    receipt={**initial,'endedAt':now(),'families':results,'all15NativeClean':all(r['status']=='native-checks-clean' for r in results),'stageAdvancementRequested':False,'additionalGates':'stream-pair, native visibility/render and full reference reconciliation still required before advancement'}
    save(directory/'preflight-receipt.json',receipt)
    return 0 if receipt['all15NativeClean'] else 1


if __name__=='__main__':raise SystemExit(main())
