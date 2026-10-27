"""Offline, synthetic/local-native PDF outline/clip validator, restricted profile v2.
Never use for customer bytes. Unsupported inputs cannot receive coverage/no-loss.
"""
from pathlib import Path
from decimal import Decimal
from types import ModuleType
import hashlib
import json
import math
import sys

VERSION = 'validation-r2.1'
HERE = Path(__file__).resolve().parent
HELPER = HERE.parent / 'r4/outline_clip_check.py'
HELPER_SHA = '93e8e94f53e1b1801499b839753f3ed0e04bb28310d469fbc34f8611ab370dc7'

class Refusal(ValueError):
    pass

def require(ok, reason):
    if not ok:
        raise Refusal(reason)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def runtime():
    raw = (HERE / 'runtime-lock.json').read_bytes()
    lock = json.loads(raw)
    require(sys.flags.optimize == 0, 'Optimized Python disables frozen helper assertions')
    require(sys.version == lock['python'], 'Python version mismatch')
    require(str(Path(sys.executable).resolve()) == lock['executable'], 'Interpreter path mismatch')
    require(sha(Path(sys.executable).read_bytes()) == lock['executableSha256'], 'Interpreter hash mismatch')
    for name, dist in lock['packages'].items():
        for rel, expected in dist['files'].items():
            require(sha((Path(dist['root']) / rel).read_bytes()) == expected, 'Dependency hash mismatch: ' + name + '/' + rel)
    require(sha(Path(lock['font']['path']).read_bytes()) == lock['font']['sha256'], 'Control font hash mismatch')
    return sha(raw)

def numbers(args, count=None):
    require(count is None or len(args) == count, 'Malformed operand count')
    try:
        require(all(not isinstance(v, bool) for v in args), 'Boolean geometry')
        vals = tuple(Decimal(str(v)) for v in args)
        require(all(v.is_finite() for v in vals), 'Nonfinite geometry')
        require(all(abs(v) < Decimal('1e9') for v in vals), 'Out-of-profile coordinate magnitude')
        return vals
    except (ArithmeticError, TypeError) as e:
        raise Refusal('Malformed numeric geometry') from e

def similarity(args):
    a,b,c,d,e,f = numbers(args, 6)
    require(a == d and b == -c and a*a+b*b > 0, 'Nonuniform/sheared/singular/reflected matrix')
    # Exact quarter turns only: no tolerance can hide a small shear.
    require(a == 0 or b == 0, 'Non-quarter-turn similarity is outside restricted profile')
    return tuple(map(float, (a,b,c,d,e,f)))

def rectangle_geometry(args, matrix):
    """Validate signed re notation without changing the helper's four-corner math."""
    x,y,w,h = numbers(args, 4)
    require(w != 0 and h != 0, 'Zero-area rectangle')
    # Both mathematical endpoints and the actual floating operations used by the
    # frozen checker must remain finite, bounded and nondegenerate.
    numbers([x+w, y+h], 2)
    x,y,w,h = map(float, (x,y,w,h))
    endx,endy = x+w,y+h
    numbers([endx,endy], 2)
    require(endx != x and endy != y, 'Rectangle endpoint collapsed at runtime precision')
    a,b,c,d,e,f = matrix
    pts = [(a*u+c*v+e, b*u+d*v+f) for u in (x,endx) for v in (y,endy)]
    numbers([v for p in pts for v in p], 8)
    bounds = [min(p[0] for p in pts), min(p[1] for p in pts),
              max(p[0] for p in pts), max(p[1] for p in pts)]
    require(bounds[0] < bounds[2] and bounds[1] < bounds[3], 'Mapped rectangle collapsed')
    topdown = [bounds[0],792-bounds[3],bounds[2],792-bounds[1]]
    numbers(topdown, 4)
    require(topdown[0] < topdown[2] and topdown[1] < topdown[3], 'Top-down rectangle collapsed')
    return {'boundsPt':bounds,'topDownBoundsPt':topdown,'signedExtent':w<0 or h<0}

def guard(data):
    import pikepdf
    from io import BytesIO
    with pikepdf.open(BytesIO(data), attempt_recovery=False) as pdf:
        require(not pdf.is_encrypted, 'Encrypted PDF unsupported')
        require(len(pdf.pages) == 1, 'Only one-page PDFs supported')
        page = pdf.pages[0]
        # Resolve inherited geometry; helper only understands this exact page frame.
        obj = page.obj
        while obj is not None:
            require('/Rotate' not in obj or numbers([obj.Rotate],1)==(0,), 'Page rotation unsupported')
            require('/UserUnit' not in obj or numbers([obj.UserUnit],1)==(1,), 'UserUnit unsupported')
            if '/MediaBox' in obj:
                require(numbers(obj.MediaBox,4)==(0,0,612,792), 'MediaBox unsupported')
            if '/CropBox' in obj:
                require(numbers(obj.CropBox,4)==(0,0,612,792), 'CropBox unsupported')
            obj = obj.get('/Parent')
        require(not page.obj.get('/Annots'), 'Annotations unsupported')
        require('/OCProperties' not in pdf.Root, 'Optional content unsupported')
        numeric = {'TL':1,'Td':2,'TD':2,'re':4,'m':2,'l':2,'c':6,'v':4,'y':4,
                   'w':1,'J':1,'j':1,'M':1,'rg':3,'RG':3,'g':1,'G':1,'k':4,'K':4}
        zero = set('q Q BT ET T* h W W* n S s f F f* B B* b b* EMC'.split())
        stack=[]; matrix=(1.,0.,0.,1.,0.,0.); intext=False; marks=0; shown=0; rectangles=[]
        for index, ins in enumerate(pikepdf.parse_content_stream(page)):
            op=str(ins.operator); args=ins.operands
            try:
                if op in {'Tz','Ts','Tc','Tw','Tr','gs','Do','sh','BI','ID','EI',"'",'"'}:
                    raise Refusal('Unsupported text/graphics state or nested paint: '+op)
                if op in {'Tm','cm'}:
                    m=similarity(args)
                    if op=='Tm': require(intext,'Tm outside BT/ET')
                    else:
                        require(not intext,'cm inside text object')
                        a,b,c,d,e,f=matrix;g,h,i,j,k,l=m
                        matrix=(a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f)
                        require(all(math.isfinite(v) and abs(v)<1e9 for v in matrix),'Invalid accumulated CTM')
                        similarity([str(v) for v in matrix])
                elif op=='Tf':
                    require(len(args)==2 and str(args[0]).startswith('/'),'Malformed Tf')
                    require(numbers([args[1]],1)[0]>0,'Nonpositive font size')
                elif op in {'Tj','TJ'}:
                    require(intext,'Text show outside BT/ET')
                    require(len(args)==1,'Malformed text show')
                    if op=='Tj': require(isinstance(args[0],pikepdf.String),'Malformed Tj')
                    else:
                        require(isinstance(args[0],pikepdf.Array),'Malformed TJ')
                        for v in args[0]:
                            if not isinstance(v,pikepdf.String): numbers([v],1)
                    shown+=1
                elif op in numeric:
                    v=numbers(args,numeric[op])
                    if op=='re': rectangles.append({'instruction':index,**rectangle_geometry(args,matrix)})
                elif op=='d':
                    require(len(args)==2 and isinstance(args[0],pikepdf.Array),'Malformed dash')
                    numbers(args[0]);numbers([args[1]],1)
                elif op in {'BMC','BDC'}:
                    require(len(args)==(1 if op=='BMC' else 2),'Malformed marked content')
                    require(str(args[0])!='/OC','Optional content unsupported');marks+=1
                elif op in zero:
                    require(len(args)==0,'Unexpected operands')
                    if op=='q': require(not intext,'q inside text object');stack.append(matrix)
                    elif op=='Q':
                        require(not intext and bool(stack),'Unbalanced Q');matrix=stack.pop()
                    elif op=='BT': require(not intext,'Nested BT');intext=True
                    elif op=='ET': require(intext,'Unbalanced ET');intext=False
                    elif op=='EMC': require(marks>0,'Unbalanced EMC');marks-=1
                else: raise Refusal('Unknown/unhandled operator: '+op)
            except Exception as e:
                raise Refusal(f'instruction {index} ({op}): {e}') from e
        require(not stack and not intext and marks==0,'Unbalanced graphics/text/marked-content state')
        require(shown>0,'No text shows; cannot award vacuous coverage')
        require(not pdf.get_warnings(),'PDF parser warning')
    return {'profile':'one-page origin-zero letter; exact positive uniform quarter-turn similarities; default text state; opaque fill embedded TrueType; rectangular clips only', 'textShowCount':shown,'rectangles':rectangles}

def inspect(path):
    path=Path(path)
    report={'pdf':str(path.resolve()),'validatorVersion':VERSION,'wrapperSha256':sha(Path(__file__).read_bytes()),
            'frozenHelperSha256':HELPER_SHA,'completeForObservedMechanisms':False,'noOutlineClipMisses':False,
            'scope':'Outline-vs-active-clip only; no extraction/fixture/score/acceptance or occlusion claim'}
    try:
        report['runtimeLockSha256']=runtime()
        data=path.read_bytes();report['sha256']=sha(data)
        helper=HELPER.read_bytes();require(sha(helper)==HELPER_SHA,'Frozen helper hash mismatch')
        report['guard']=guard(data)
        module=ModuleType('verified_frozen_r4_outline_clip_check')
        exec(compile(helper,str(HELPER),'exec'),module.__dict__)
        result=module.inspect(path)
        require(result['sha256']==sha(data)==sha(path.read_bytes()),'PDF changed during inspection')
        require(sha(HELPER.read_bytes())==HELPER_SHA,'Helper changed during inspection')
        # Reject malformed/nonfinite derived geometry before exposing helper success.
        for key in ['minimumClipSlackPt']:
            require(result[key] is not None and math.isfinite(result[key]),'Empty/nonfinite outline result')
        require(result['outlinedGlyphsChecked']>0,'No outlines checked')
        report['frozenResult']=result
        report['completeForObservedMechanisms']=bool(result['completeForObservedMechanisms'])
        report['noOutlineClipMisses']=bool(result['noOutlineClipMisses'])
        report['status']='checked' if report['completeForObservedMechanisms'] else 'unsupported'
    except Exception as e:
        report.update(status='refused',failure={'type':type(e).__name__,'message':str(e)})
    return report

if __name__=='__main__':
    result=inspect(sys.argv[1]); print(json.dumps(result,indent=2,allow_nan=False))
    sys.exit(0 if result['noOutlineClipMisses'] else 1)
