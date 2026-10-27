"""Prospective local export evidence; no external attestation or visual claim.
Standard library only. Never delete partial outputs or overwrite receipts.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import traceback
import uuid
import copy

SCHEMA = 'writer-export-binding@1'

def now():
    return datetime.now(timezone.utc).isoformat()

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def write_json(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())

def identity(path):
    path = Path(path).absolute()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size > 0, 'Missing/empty/nonregular artifact: ' + str(path))
        h = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
        after = os.fstat(fd)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        sig = lambda s: tuple(getattr(s, key) for key in fields)
        require(sig(before) == sig(after) == sig(path.lstat()), 'Artifact changed during hashing: ' + str(path))
        return {'path': str(path), 'sha256': h.hexdigest(), **{key: getattr(after, key) for key in fields}}
    finally:
        os.close(fd)

def unchanged(expected):
    actual = identity(expected['path'])
    require(actual == expected, 'Artifact replaced or changed: ' + expected['path'])
    return actual

def normalized_state(state):
    # Ignore only observational metadata and raw parent interfaces with unstable UNO reprs.
    require(state['pageCount'] == 1, 'Unexpected page count')
    objects = []
    for row in state['objects']:
        require(row['actualDrawPageMembership'] is True, 'Missing DrawPage membership')
        permitted={'WriterTextFrame':{'LayerID','LayerName','RotateAngle'},
                   'DrawingShape':{'Width','Height','SizeType','WidthType'}}.get(row.get('nativeType'),set())
        for name,value in row['properties'].items():
            require(not isinstance(value,dict) or name in permitted and 'unavailable' in value,
                    'Unavailable unexpected object property: '+name)
        objects.append({key: row[key] for key in ('identity', 'properties', 'actualDrawPageMembership', 'text')})
    tables = state['tables']
    for table in tables:
        require(table['parent']['bodyMembership'] is True, 'Table lost body membership')
        for cell in table['cells'].values():
            require('|' not in cell, 'Pipe character in native cell')
        for values in [table['properties']] + [p[k] for p in table['cellProperties'].values() for k in ('paragraph', 'cell')]:
            require(not any(isinstance(v, dict) for v in values.values()), 'Unavailable native table property')
    return {'objects': sorted(objects, key=lambda x: x['identity']), 'tables': sorted(tables, key=lambda x: x['identity']), 'pageCount': state['pageCount']}

def compare_states(first, other, plan):
    """Separate source binding from explicitly unresolved native observations.

    Raw snapshots are immutable. No UNO property or snapshot value is replaced.
    Only known Width and global ZOrder changes are recorded separately; all other
    captured native state remains an exact gate. Actual paint proof is separate.
    """
    a=copy.deepcopy(validate_plan_state(first,plan));b=copy.deepcopy(validate_plan_state(other,plan))
    observations=[]
    def diagnostic_core(d):
        d=copy.deepcopy(d)
        for route in ('direct','getPropertyValue'):d[route].pop('Width',None)
        d.pop('directMatchesPropertyValue',None)
        def error_types(value):
            if isinstance(value,dict):
                if 'errorType' in value:return {'errorType':value['errorType']}
                if 'Position' in value and 'IsVisible' in value:
                    require(isinstance(value['Position'],int) and 0<value['Position']<10000,
                            'Invalid raw row separator position')
                    return {'IsVisible':value['IsVisible']}
                return {k:error_types(v) for k,v in value.items()}
            if isinstance(value,list):return [error_types(v) for v in value]
            return value
        return error_types(d)
    for aa,bb in zip(a['objects'],b['objects']):
        require(aa['identity']==bb['identity'],'Changed native object identity')
        az=aa['properties'].pop('ZOrder',None);bz=bb['properties'].pop('ZOrder',None)
        if az!=bz:observations.append({'kind':'raw global ZOrder changed','id':aa['identity'],'before':az,'after':bz,
                                      'status':'retained; actual ink nonintersection proof and independent adjudication required'})
    for aa,bb in zip(a['tables'],b['tables']):
        require(aa['identity']==bb['identity'],'Changed native table identity')
        aw=aa['properties'].pop('Width',None);bw=bb['properties'].pop('Width',None)
        raw_a=next(t for t in first['tables'] if t['identity']==aa['identity'])
        raw_b=next(t for t in other['tables'] if t['identity']==aa['identity'])
        for key in ('widthDiagnosticBeforePagination','widthDiagnosticAfterPagination'):
            if key in raw_a or key in raw_b:
                require(key in raw_a and key in raw_b and diagnostic_core(raw_a[key])==diagnostic_core(raw_b[key]),
                        'Unexpected row/relative-width diagnostic change or new query error')
                if raw_a[key]!=raw_b[key]:
                    observations.append({'kind':'raw width/row-separator diagnostics differ','id':aa['identity'],'snapshot':key,
                        'before':raw_a[key],'after':raw_b[key],
                        'status':'exact diagnostic persistence is false; no position substitution or tolerance waiver; XML and actual cell geometry require separate verification'})
        for table in (aa,bb):
            # Diagnostics remain in the immutable snapshots and receipt hashes.
            # Their raw Width values are the observation being compared here.
            table.pop('widthDiagnosticBeforePagination',None)
            table.pop('widthDiagnosticAfterPagination',None)
        if aw!=bw:
            obj=next(o for o in plan['objects'] if o['kind']=='table' and o['id'].replace('.','_')+'_native'==aa['identity'])
            expected=round(sum(obj['columnWidthsPt'])*2540/72)
            require(aw==expected and bw==115596 and aa['properties']['HoriOrient']==bb['properties']['HoriOrient']==0,
                    'Unexpected raw Width/orientation change')
            for state in (first,other):
                t=next(t for t in state['tables'] if t['identity']==aa['identity'])
                for key in ['widthDiagnosticBeforePagination','widthDiagnosticAfterPagination']:
                    diagnostic=t[key]
                    require(diagnostic['direct']['IsWidthRelative']['value'] is False and
                            diagnostic['direct']['RelativeWidth']['value']==0,
                            'Unsupported relative-width state')
            observations.append({'kind':'raw margin-aligned Width changed','id':aa['identity'],'before':aw,'after':bw,
                                 'status':'raw scalar persistence assertion remains false; import reference-width path is separately documented; XML and actual rendered-column proof remain required'})
    require(a==b,'Unexpected native state change outside retained Width/ZOrder observations')
    return {'sameCapturedStateExceptListedObservations':True,'observations':observations,
            'nativeAcceptanceClaim':False,'rawReadbackValuesModified':False}

def validate_plan_state(state, plan):
    actual = normalized_state(state)
    expected = sorted(o['id'] for o in plan['objects'] if o['kind'] != 'table')
    require(sorted(o['identity'] for o in actual['objects']) == expected, 'Unexpected native object identities')
    for obj in plan['objects']:
        if obj['kind'] == 'text':
            observed = next(row for row in actual['objects'] if row['identity'] == obj['id'])
            require(observed['text'] == obj['text'], 'Native text differs from plan')
    tables = [o for o in plan['objects'] if o['kind'] == 'table']
    require(len(tables) == len(actual['tables']), 'Unexpected native table count')
    for obj in tables:
        require(all('|' not in cell for row in obj['data'] for cell in row), 'Pipe character in native plan cell')
        table = next((t for t in actual['tables'] if t['identity'] == obj['id'].replace('.', '_') + '_native'), None)
        require(table is not None and table['rows'] == len(obj['data']), 'Native table identity/rows differ')
        if 'Width' in table['properties'] and 'columnWidthsPt' in obj:
            configured=round(sum(obj['columnWidthsPt'])*2540/72)
            require(table['properties']['Width'] in (configured,115596) and table['properties']['HoriOrient']==0,
                    'Unexpected native Width/alignment mode')
        require(len(obj['data'][0]) <= 26, 'Unsupported table width')
        expected_cells = {chr(65+c)+str(r+1): value for r, row in enumerate(obj['data']) for c, value in enumerate(row)}
        if obj['span']:
            require(len(obj['data'][0]) >= 3 and obj['data'][0][2] == '', 'Unsupported nonempty merged source cell')
            del expected_cells['C1']
            # Writer renumbers the remaining first-row cells after a horizontal
            # merge. Semantic D1 is native C1; later rows keep four names.
            for col in range(3,len(obj['data'][0])):
                expected_cells[chr(64+col)+'1']=expected_cells.pop(chr(65+col)+'1')
        require(table['cells'] == expected_cells, 'Native cell text or span differs from plan')
        require(sorted(table['cellNames']) == sorted(expected_cells), 'Native cell names differ')
        for name, values in table['cellProperties'].items():
            col = ord(name[0])-65
            expected_adjust = 3 if obj['span'] and name == 'B1' else (0 if col == 0 else 1)
            if 'nativeCellPlacements' in obj:
                placement=next(p for p in obj['nativeCellPlacements'] if p['nativeName']==name)
                expected_adjust=placement['ParaAdjust']
                require(values['paragraph']['ParaLeftMargin']==placement['ParaLeftMarginHmm'],'Native left placement differs: '+name)
                require(values['paragraph']['ParaRightMargin']==0,'Native right clip changed: '+name)
            require(values['paragraph']['ParaAdjust'] == expected_adjust, 'Native alignment differs: '+name)
            if 'rightInkInsetHmm' in obj:
                expected_inset = obj['rightInkInsetHmm'] if expected_adjust == 1 else 0
                require(values['paragraph']['ParaRightMargin'] == expected_inset, 'Native overhang allowance differs: '+name)
            require(values['cell']['LeftBorderDistance'] == round(obj['paddingPt']*2540/72), 'Native left padding differs')
            require(values['cell']['RightBorderDistance'] == round(obj['paddingPt']*2540/72), 'Native right padding differs')
            if 'sizePt' in obj:
                require(values['paragraph']['CharHeight']==obj['sizePt'] and
                        values['paragraph']['CharEscapementHeight']==100,'Native table font size changed')
    return actual

def bind_export(plan_path, directory, tools, execution, *, build, save, close, reopen, readback, export_pdf):
    """All callbacks operate on one document, one worker. Reopen gets exact absolute ODT path.
    Save must close successfully before hashing. Export callback receives the reloaded document.
    tools maps role -> immutable regular file path; execution is the caller's actual context.
    """
    plan_path = Path(plan_path).absolute()
    directory = Path(directory).absolute()
    plan_id = identity(plan_path)
    plan = json.loads(plan_path.read_bytes())
    unchanged(plan_id)
    stem = plan['stem']
    require(stem and Path(stem).name == stem and stem not in ('.', '..'), 'Unsafe stem')
    odt, pdf = directory/(stem+'.odt'), directory/(stem+'.pdf')
    before_path = directory/(stem+'.readback-before.json')
    reload_path = directory/(stem+'.readback-reloaded.json')
    post_path = directory/(stem+'.readback-after-export.json')
    receipt_path = directory/(stem+'.artifact-receipt.json')
    for path in (odt, pdf, before_path, reload_path, post_path, receipt_path):
        require(not path.exists() and not path.is_symlink(), 'Refusing existing artifact: '+str(path))
    receipt = {'schema': SCHEMA, 'status': 'started', 'executionId': execution['executionId'], 'startedAtUtc': now(),
               'execution': execution, 'plan': plan_id, 'events': [], 'artifacts': {}}
    doc = None
    def event(phase):
        receipt['events'].append({'phase': phase, 'atUtc': now()})
    def guard():
        unchanged(plan_id)
        for item in receipt['tools'].values():
            unchanged(item)
    try:
        receipt['tools'] = {role: identity(path) for role, path in tools.items()}
        require(receipt['tools'], 'Tool identities required')
        doc = build(plan)
        baseline = readback(doc, plan)
        write_json(before_path, baseline)
        receipt['artifacts']['readbackBefore'] = identity(before_path)
        stable = validate_plan_state(baseline, plan)
        event('readback-before-save')
        guard()
        save(doc, odt)
        close(doc)
        doc = None
        event('saved-and-closed')
        receipt['odtBeforeReload'] = identity(odt)
        event('odt-hashed-before-reload')
        guard()
        unchanged(receipt['odtBeforeReload'])
        doc = reopen(odt)
        event('reopened-exact-saved-path')
        unchanged(receipt['odtBeforeReload'])
        reloaded = readback(doc, plan)
        write_json(reload_path, reloaded)
        receipt['artifacts']['readbackReloaded'] = identity(reload_path)
        receipt['nativeStateComparisons']=[compare_states(baseline,reloaded,plan)]
        event('reloaded-state-checked')
        guard()
        unchanged(receipt['odtBeforeReload'])
        require(not pdf.exists() and not pdf.is_symlink(), 'PDF appeared before export')
        event('pdf-export-started')
        export_pdf(doc, pdf)
        event('pdf-export-returned')
        receipt['artifacts']['pdf'] = identity(pdf)
        with pdf.open('rb') as stream:
            require(stream.read(5) == b'%PDF-', 'Output lacks PDF header')
        receipt['odtAfterExport'] = unchanged(receipt['odtBeforeReload'])
        post = readback(doc, plan)
        write_json(post_path, post)
        receipt['artifacts']['readbackAfter'] = identity(post_path)
        receipt['nativeStateComparisons'].append(compare_states(baseline,post,plan))
        receipt['nativeStateComparisons'].append(compare_states(reloaded,post,plan))
        close(doc)
        doc = None
        guard()
        unchanged(receipt['odtBeforeReload'])
        for item in receipt['artifacts'].values():
            unchanged(item)
        for key, path in [('odt', odt), ('readbackBefore', before_path), ('readbackReloaded', reload_path), ('readbackAfter', post_path)]:
            receipt['artifacts'][key] = identity(path)
        receipt['status'] = 'bound'
        event('odt-unchanged-after-export-and-close')
    except Exception:
        receipt['status'] = 'failed'
        receipt['error'] = traceback.format_exc()
        # Preserve partial files in place, identify what remains, never relabel as bound.
        for name, path in [('odt', odt), ('pdf', pdf), ('readbackBefore', before_path), ('readbackReloaded', reload_path), ('readbackAfter', post_path)]:
            try:
                receipt['artifacts'][name] = identity(path)
            except Exception as error:
                receipt['artifacts'][name] = {'path': str(path), 'inspectionError': str(error)}
        raise
    finally:
        if doc is not None:
            try:
                close(doc)
            except Exception:
                receipt['cleanupError'] = traceback.format_exc()
        receipt['finishedAtUtc'] = now()
        write_json(receipt_path, receipt)
    return receipt_path

def verify_receipt(path, plan_path, execution_id, expected_tools):
    """Independent wrapper check. Failure never produces an exported outer status."""
    path = Path(path).absolute()
    receipt_id = identity(path)
    receipt = json.loads(Path(path).read_bytes())
    require(receipt['schema'] == SCHEMA and receipt['status'] == 'bound', 'No successful prospective binding')
    require(receipt['executionId'] == execution_id == receipt['execution']['executionId'], 'Wrong execution')
    require(receipt['plan'] == identity(plan_path), 'Wrong plan identity')
    require(receipt['tools'] == expected_tools, 'Tool identity differs from outer launch')
    for item in receipt['tools'].values():
        unchanged(item)
    require(receipt['odtBeforeReload'] == receipt['odtAfterExport'] == receipt['artifacts']['odt'], 'ODT binding differs')
    expected_phases = ['readback-before-save', 'saved-and-closed', 'odt-hashed-before-reload', 'reopened-exact-saved-path',
                       'reloaded-state-checked', 'pdf-export-started', 'pdf-export-returned', 'odt-unchanged-after-export-and-close']
    require([e['phase'] for e in receipt['events']] == expected_phases, 'Missing/out-of-order export events')
    stamps = [receipt['startedAtUtc']] + [e['atUtc'] for e in receipt['events']] + [receipt['finishedAtUtc']]
    require(stamps == sorted(stamps), 'Nonmonotonic wall-clock timestamps')
    plan = json.loads(Path(plan_path).read_bytes())
    require(path.name == plan['stem']+'.artifact-receipt.json', 'Unexpected receipt name')
    expected_names = {'odt': '.odt', 'pdf': '.pdf', 'readbackBefore': '.readback-before.json',
                      'readbackReloaded': '.readback-reloaded.json', 'readbackAfter': '.readback-after-export.json'}
    states=[]
    for role in ('odt', 'pdf', 'readbackBefore', 'readbackReloaded', 'readbackAfter'):
        item = receipt['artifacts'][role]
        require(item['path'] == str(path.parent/(plan['stem']+expected_names[role])), 'Unexpected artifact path')
        unchanged(item)
        if role.startswith('readback'):
            state=json.loads(Path(item['path']).read_bytes())
            validate_plan_state(state,plan);states.append(state)
    comparisons=[compare_states(states[0],states[1],plan),compare_states(states[0],states[2],plan),compare_states(states[1],states[2],plan)]
    require(receipt['nativeStateComparisons']==comparisons,'Outer native observation record mismatch')
    unchanged(receipt_id)
    return {'checkedAtUtc': now(), 'receiptIdentity': receipt_id, 'receipt': receipt}
