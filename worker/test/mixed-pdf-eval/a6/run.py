"""Capped native preflight. Every invocation is one preserved formal build round."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import traceback
from contract import *
from prose import Author
from worlds import make_world
from resolve import author_family
import jsonschema


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--round',type=int,required=True,choices=range(1,5))
    parser.add_argument('--author-only',action='store_true')
    args=parser.parse_args()
    output=args.output.resolve()
    assert str(output)=='/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a6'
    rounddir=output/f'round-{args.round:02d}'
    assert not rounddir.exists(),'A formal round cannot be reused or overwritten'
    if args.round>1:assert (output/f'round-{args.round-1:02d}'/'receipt.json').exists()
    rounddir.mkdir(parents=True)
    save(rounddir/'tools.json',tool_receipt())
    source={}
    for code in sorted(CODE.glob('*.py')):
        raw=code.read_bytes();source[code.name]=sha(raw);save(rounddir/'source'/code.name,raw)
    save(rounddir/'source-hashes.json',source)
    save(rounddir/'started.json',dict(attempt=6,formalRound=args.round,startedAt=datetime.now(timezone.utc).isoformat(),sourceHashes=source))
    inputs=output/'clean-inputs'
    for name in INPUT_HASHES:save(inputs/name,(HANDOFF/name).read_bytes())
    receipt=dict(attempt=6,formalRound=args.round,maximumRounds=4,acceptanceDecision=None,
        startedAt=datetime.now(timezone.utc).isoformat(),families=[],notAuthorized=['pilot','delivered-variants','full-corpus','heldout','model-calls','paid-work'],
        invalidatedAssertions=[dict(assertion='Earlier commentary observation time 07:05 MDT',reason='host clock at subsequent check was 06:58 MDT; use file timestamps')])
    author=Author()
    for family in family_plan():
        fid=family['familyId'];directory=rounddir/f'f{fid:04d}';directory.mkdir()
        status=dict(familyId=fid,classId=family['classId'],layoutId=family['layoutId'],stage='authoring',passed=False)
        save(directory/'world.json',make_world(family))
        try:
            w,a,plans,scenes,relations=author_family(family,author,
                observer=lambda pid,tid,auth:save(directory/'partial-authoring'/pid/(tid+'.json'),auth))
            save(directory/'authoring.json',a);save(directory/'support-plans.json',plans);save(directory/'native-scenes.json',scenes)
            save(directory/'semantic-relations.json',relations)
            jsonschema.Draft202012Validator(SPEC['immutable_records']['schemas']['authoring']).validate(a)
            for p in plans:jsonschema.Draft202012Validator(SPEC['enriched_resolution_plan_schema']).validate(p)
            from bindings import make_bindings,SCHEMA
            sidecar=make_bindings(a,w);jsonschema.Draft202012Validator(SCHEMA).validate(sidecar)
            save(directory/'semantic-bindings.schema.json',SCHEMA);save(directory/'semantic-bindings.json',sidecar)
            atlas={kind:{c:dict(glyphName=f.glyph(c)[0],glyphId=f.glyph(c)[1],advanceEm=f.glyph(c)[2],outlineBounds=f.glyph(c)[3],fontHash=f.hash)
                for c in sorted({g['text'] for p in plans for l in p['leaves'] for g in l['glyphs'] if g['fontHash']==f.hash})} for kind,f in FONTS.items()}
            save(directory/'frozen-font-atlas.json',atlas)
            from semantics import validate,negative_controls
            semantic=validate(a,w,relations);save(directory/'semantic-check.json',semantic)
            assert semantic['passed'],semantic['misses']
            save(directory/'semantic-negative-controls.json',negative_controls(a,w))
            status.update(stage='frozen-authoring',authoringHash=a['authoringHash'],supportHashes=[p['planHash'] for p in plans],pages=10)
            if not args.author_only:
                from reportlab_native import build
                for permuted in [False,True]:
                    build(a,scenes,directory/('reportlab-permuted.pdf' if permuted else 'reportlab-canonical.pdf'),permuted)
                status['stage']='reportlab-exported'
                from native_checks import inspect_pdf,compare_pair
                rl=inspect_pdf(a,plans,scenes,directory/'reportlab-canonical.pdf',directory/'images-reportlab')
                save(directory/'reportlab-native-check.json',rl)
                save(directory/'reportlab-pixel-pair.json',compare_pair(directory/'reportlab-canonical.pdf',directory/'reportlab-permuted.pdf'))
                from writer_scene import make_scene
                ws=make_scene(a,scenes,directory/'writer-assets')
                save(directory/'writer-scene.json',ws)
                subprocess.run(['/usr/bin/python3',str(CODE/'writer_native.py'),str(directory/'writer-scene.json'),
                    str(directory/'writer'),'--profile',str(Path('/home/dan/tmp/agents/fools-gold-a6.dFM9qD')/f'round{args.round}-f{fid}-profile')],check=True)
                status['stage']='native-exports-pending-independent-validation'
                writer=inspect_pdf(a,plans,scenes,directory/'writer/original.pdf',directory/'images-writer-original')
                save(directory/'writer-original-check.json',writer)
                if writer['passed']:
                    from native_stream import reorder_writer
                    from copy import deepcopy
                    for permuted in (False,True):
                        ordered=deepcopy(scenes)
                        for ap,rs in zip(a['pages'],ordered):rs['paintOrder']=paint_order(ap['blocks'],fid,ap['number'],permuted)[1]
                        receipt_order=reorder_writer(directory/'writer/original.pdf',directory/('writer-permuted.pdf' if permuted else 'writer-canonical.pdf'),a,dict(pages=ordered))
                        save(directory/('writer-permuted-order.json' if permuted else 'writer-canonical-order.json'),receipt_order)
                    save(directory/'writer-pixel-pair.json',compare_pair(directory/'writer-canonical.pdf',directory/'writer-permuted.pdf'))
            status['passed']=False
            status['pending']=['independent semantics','all-page visibility','native geometry','editable table readback',
                'Writer original export before reorder','canonical-permuted order proof','all transformation probes']
        except Exception as e:
            status.update(error=str(e),exceptionType=type(e).__name__,traceback=traceback.format_exc())
            save(directory/'failure.json',status)
        receipt['families'].append(status)
        print(json.dumps({k:v for k,v in status.items() if k not in ('traceback','supportHashes','pending')}),flush=True)
    receipt['finishedAt']=datetime.now(timezone.utc).isoformat()
    receipt['stageAdvancementReady']=False
    save(rounddir/'receipt.json',receipt)
    print('Preserved formal round',args.round,'at',rounddir,flush=True)


if __name__=='__main__':main()
