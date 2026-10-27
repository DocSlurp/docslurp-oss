"""Small v4-only primitives: immutable writes, metrics, geometry and schemas."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata

TEMP_ROOT = Path('/home/dan/tmp/agents')
for _name in ('TMPDIR', 'TMP', 'TEMP'):
    os.environ.setdefault(_name, str(TEMP_ROOT))


def nfc(value):
    if isinstance(value, str): return unicodedata.normalize('NFC', value)
    if isinstance(value, list): return [nfc(v) for v in value]
    if isinstance(value, dict): return {nfc(k): nfc(v) for k,v in value.items()}
    return value


def canonical(value):
    return json.dumps(nfc(value),sort_keys=True,separators=(',', ':'),ensure_ascii=False,allow_nan=False).encode('utf-8')


def sha(data): return hashlib.sha256(data).hexdigest()
def file_hash(path): return sha(Path(path).read_bytes())
def record_hash(record, key): return sha(canonical({k:v for k,v in record.items() if k != key}))


def freeze(record, key):
    record[key]=record_hash(record,key)
    return record


def save(path, value):
    """No overwrite, even after a failed revision. Identical files stay untouched."""
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    raw=value if isinstance(value,bytes) else value.encode() if isinstance(value,str) else canonical(value)+b'\n'
    if path.exists():
        if path.read_bytes()!=raw: raise FileExistsError(f'Immutable artifact exists: {path}')
        return
    with path.open('xb') as f: f.write(raw)


def load(path): return json.loads(Path(path).read_text())
def norm(text): return ' '.join(unicodedata.normalize('NFC',text).split())
def words(text): return [w for w in norm(text).split() if any(c.isalnum() for c in w)]


def run(command, **kw):
    return subprocess.run([str(x) for x in command],check=True,capture_output=True,**kw)


def validate_schema(record, schema):
    """Use the installed system jsonschema, not an incomplete local substitute.

    The system has CPython 3.14 and the graphics venv CPython 3.13. Passing JSON
    over stdin avoids importing incompatible native modules into either runtime.
    """
    program='''import json,sys
from jsonschema import Draft202012Validator
v=json.load(sys.stdin)
Draft202012Validator.check_schema(v['schema'])
errors=sorted(Draft202012Validator(v['schema']).iter_errors(v['record']), key=lambda e:str(e.path))
if errors:
 print('\\n'.join(str(list(e.path))+': '+e.message[:600] for e in errors[:30]))
 sys.exit(1)
'''
    result=subprocess.run(['/usr/bin/python','-c',program],input=canonical(dict(record=record,schema=schema)),capture_output=True)
    if result.returncode: raise ValueError(result.stdout.decode()+result.stderr.decode())


def union_box(boxes):
    boxes=list(boxes)
    if not boxes:return [0,0,0,0]
    return [min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)]


def area(b): return max(0,b[2]-b[0])*max(0,b[3]-b[1])
def intersection(a,b): return [max(a[0],b[0]),max(a[1],b[1]),min(a[2],b[2]),min(a[3],b[3])]
def iou(a,b):
    x=area(intersection(a,b));d=area(a)+area(b)-x
    return x/d if d else 1


def contains(outer,inner,epsilon=0.00001):
    return outer[0]-epsilon<=inner[0]<=inner[2]<=outer[2]+epsilon and outer[1]-epsilon<=inner[1]<=inner[3]<=outer[3]+epsilon


def box_polygon(box): return [[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]]
IDENTITY=[1,0,0,1,0,0]


def affine_point(p,m):
    a,b,c,d,e,f=m;x,y=p
    return [a*x+c*y+e,b*x+d*y+f]


def transformed_box(box,m): return union_box([[x,y,x,y] for x,y in (affine_point(p,m) for p in box_polygon(box))])


def compose(after,before):
    a,b,c,d,e,f=after;g,h,i,j,k,l=before
    return [a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f]


def rotation(degrees):
    return {0:IDENTITY,90:[0,1,-1,0,792,0],180:[-1,0,0,-1,612,792],270:[0,-1,1,0,0,612]}[degrees]


def normalized(box,size=(612,792)): return [box[0]/size[0],box[1]/size[1],box[2]/size[0],box[3]/size[1]]


def rectangle_union_area(boxes):
    """Exact sweep union for axis-aligned opaque footprints, clipped first."""
    boxes=[intersection(b,[0,0,612,792]) for b in boxes if area(intersection(b,[0,0,612,792]))]
    xs=sorted(set(x for b in boxes for x in (b[0],b[2])))
    total=0
    for left,right in zip(xs,xs[1:]):
        intervals=sorted((b[1],b[3]) for b in boxes if b[0]<right and b[2]>left)
        height=0;lo=hi=None
        for a,b in intervals:
            if lo is None:lo,hi=a,b
            elif a<=hi:hi=max(hi,b)
            else:height+=hi-lo;lo,hi=a,b
        if lo is not None:height+=hi-lo
        total+=(right-left)*height
    return total


def layout_for(spec,family):
    if family['classId']=='P': return copy.deepcopy(spec['prototype_layouts'][family['layoutId']])
    return copy.deepcopy(spec['enriched_derivatives'][family['classId']]['layouts'][family['layoutId']])


def font_paths():
    return {kind:Path(run(['fc-match','-f','%{file}',name]).stdout.decode())
            for kind,name in [('sans','Liberation Sans'),('mono','Liberation Mono')]}


def versions():
    from importlib.metadata import version
    return dict(packages={x:version(x) for x in ['reportlab','PyMuPDF','Pillow','numpy','pikepdf','matplotlib','fonttools']},
                executables={x:run([x,flag]).stdout.decode().strip() for x,flag in [('soffice','--version'),('qpdf','--version'),('gs','--version')]},
                fonts={k:dict(name=p.name,sha256=file_hash(p)) for k,p in font_paths().items()})


def paragraph_fingerprint(text): return re.findall(r'[a-z]+',text.lower())


def diversity_report(authoring):
    rows=[];seen={};runs={};duplicates=[];shared=[];flags=[]
    for page in authoring['pages']:
        for b in page['blocks']:
            if b['role'] not in ['body','quoted-excerpt','commentary']:continue
            t=paragraph_fingerprint(b['displayText']);key=' '.join(t)
            if key in seen:duplicates.append([seen[key],b['id']])
            seen[key]=b['id']
            for i in range(len(t)-7):
                k=tuple(t[i:i+8])
                if k in runs and runs[k]!=b['id']:shared.append([runs[k],b['id'],' '.join(k)])
                runs[k]=b['id']
            ngrams=set(tuple(t[i:i+5]) for i in range(len(t)-4))
            for bid,other in rows:
                j=len(ngrams&other)/max(1,len(ngrams|other))
                if j>.35:flags.append([bid,b['id'],j])
            rows.append((b['id'],ngrams))
    return dict(exactDuplicates=duplicates,sharedEightTokenRuns=shared,jaccardReviewFlags=flags,
                passed=not(duplicates or shared or flags))
