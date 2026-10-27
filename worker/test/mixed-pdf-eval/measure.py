"""Local paired measurements. Extractors receive PDF pixels only, never reference labels.

Labels are loaded after extraction for deterministic scoring. Heldout requires a frozen
policy receipt. Raw outputs, component scores, time and cache identities are retained.
"""
import argparse
import csv
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from difflib import SequenceMatcher
import hashlib
import json
import os
import socket
import uuid
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata

import fitz
from contract import (evaluation_identity,identity_hash,file_hash,immutable_json,validate_manifest,
                      validate_policy_receipt,validate_labels,validate_complete_inventory,validate_panel_binding,validate_panel_manifest)

VERSION = "mixed-page-preservation@v2"
MEASURE_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
OCR_BINARY_HASH = hashlib.sha256(Path(shutil.which("tesseract")).read_bytes()).hexdigest()
OCR_LANGUAGE_HASH = hashlib.sha256(Path(os.environ.get("TESSDATA_PREFIX","/usr/share/tessdata"),"eng.traineddata").read_bytes()).hexdigest()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def tokens(text):
    # Markdown table separators and list markers are envelopes, not printed operators.
    text='\n'.join(line for line in text.splitlines()
                   if not ('-' in line and set(line.strip())<=set('|:- \t') and line.count('-')>=3))
    text=re.sub(r'(?m)^\s*[-*]\s+','',text)
    return re.findall(r"[-+]?\d+(?:\.\d+)?|[^\W\d_]+|[=+*/<>^%−×÷±≤≥≠-]", unicodedata.normalize("NFKC", text).casefold())

def value_contexts(text):
    """Bind numeric values and mathematical operators to adjacent semantic tokens."""
    sequence=tokens(text)
    return Counter(tuple(sequence[max(0,i-2):i+3]) for i,t in enumerate(sequence)
                   if re.fullmatch(r'[-+]?\d+(?:\.\d+)?|[=+*/<>^%−×÷±≤≥≠-]',t))

def content_score(reference, text, legacy):
    expected, actual = Counter(tokens(reference["expectedMarkdown"])), Counter(tokens(text))
    matched = sum((expected & actual).values())
    recall = matched/sum(expected.values()) if expected else 1.0
    precision = matched/sum(actual.values()) if actual else (0.0 if expected else 1.0)
    sections = []
    for section in reference["sections"]:
        wanted=tokens(section)
        if not wanted:continue
        matched=sum(m.size for m in SequenceMatcher(None,wanted,tokens(text),autojunk=False).get_matching_blocks())
        sections.append(matched/max(1,len(wanted)))
    numbers = lambda c: Counter({k:v for k,v in c.items() if re.fullmatch(r"[-+]?\d+(?:\.\d+)?",k)})
    a,b = numbers(expected), numbers(actual)
    numeric = sum((a&b).values())/sum(a.values()) if a else None
    wanted_contexts=value_contexts(reference['expectedMarkdown']);actual_contexts=value_contexts(text)
    contextual=sum((wanted_contexts&actual_contexts).values())/sum(wanted_contexts.values()) if wanted_contexts else None
    compact=lambda s:re.sub(r'[^\w]','',unicodedata.normalize('NFKC',s).casefold())
    excluded = any(compact(x) and compact(x) in compact(text) for x in reference["excludedText"])
    ordered=SequenceMatcher(None,tokens(reference['expectedMarkdown']),tokens(text),autojunk=False).ratio()
    stream=" " + " ".join(tokens(text)) + " "
    table_rows=[row for table in reference["tables"] for row in table["rows"][1:]]
    cursor=0;row_matches=0
    for row in table_rows:
        wanted=" "+" ".join(tokens(" ".join(row)))+" "
        found=stream.find(wanted,cursor)
        if found>=0:row_matches+=1;cursor=found+len(wanted)-1
    table_row_recall=row_matches/len(table_rows) if table_rows else None
    minimum_section=min(sections,default=1.0)
    applicable=[recall,precision,minimum_section,ordered]+[v for v in [table_row_recall,numeric,contextual] if v is not None]
    ref = {"prose":reference["expectedMarkdown"], "paragraphs":reference["paragraphs"],
           "tables":reference["tables"], "formulas":reference["formulas"], "groundTruth":{"prosePresent":True,"kind":"authored"}}
    modern = legacy.compact(legacy.score(ref,text))
    return {"version":VERSION, "recall":recall,"precision":precision,
            "f1":2*recall*precision/max(1e-9,recall+precision),"sectionRecall":sections,
            "minimumSectionRecall":minimum_section,"numericRecall":numeric,"contextualValueRecall":contextual,"hiddenTextLeak":excluded,
            "tableRowRecall":table_row_recall,"orderedSimilarity":ordered,
            "quality": min(applicable),
            "acceptable":recall>=.95 and precision>=.95 and minimum_section>=.90 and all(v is None or v>=.95 for v in [numeric,table_row_recall,contextual]) and ordered>=.9 and not excluded,
            "modern":modern}

def invoke(argv):
    started=time.perf_counter()
    completed=subprocess.run(argv, capture_output=True, timeout=90,
        env={**os.environ,"OMP_THREAD_LIMIT":"1"})
    elapsed=time.perf_counter()-started
    if completed.returncode:
        raise RuntimeError(f"command-failed:{argv[0]}:{completed.returncode}:{completed.stderr[-500:]!r}")
    return completed.stdout,elapsed

def ocr(image, cache, dpi, psm, use_cache=True):
    key=sha(image+f"{OCR_BINARY_HASH}-{OCR_LANGUAGE_HASH}-dpi{dpi}-psm{psm}-txt-tsv-v2".encode())
    output=cache/f"{key}.json"
    if use_cache and output.exists():
        return {**json.loads(output.read_text()), "cacheHit":True}
    # Atomic replace supports concurrent identical pages without corrupting the cache.
    with tempfile.TemporaryDirectory(prefix="mixed-ocr-",dir=os.environ["TMPDIR"]) as tmp:
        path=Path(tmp)/"page.png"; path.write_bytes(image)
        base=Path(tmp)/"output"
        _,elapsed=invoke(["tesseract",str(path),str(base),"-l","eng","--psm",str(psm),"--dpi",str(dpi),"txt","tsv"])
        words=[r for r in csv.DictReader(base.with_suffix(".tsv").read_text().splitlines(),delimiter="\t") if float(r['conf'])>=0 and r['text'].strip()]
        weight=sum(len(r['text']) for r in words)
        confidence=sum(float(r['conf'])*len(r['text']) for r in words)/max(1,weight)
        result={"text":base.with_suffix(".txt").read_text(),"seconds":elapsed,"confidence":confidence,
                "lowConfidenceWordShare":sum(float(r['conf'])<60 for r in words)/max(1,len(words)),
                "cacheHit":False,"imageHash":sha(image),"execution":{"capturedAt":datetime.now(timezone.utc).isoformat(),"host":socket.gethostname(),"workers":os.environ.get("MIXED_EVAL_WORKERS"),"attempt":os.environ.get("MIXED_EVAL_ATTEMPT")}}
        temp=cache/f"{key}.{os.getpid()}.new"
        temp.write_text(json.dumps(result)); temp.replace(output)
        return result

def stream_bytes(doc, refs, raw):
    total=0
    for ref in set(refs):
        try:
            data=doc.xref_stream_raw(ref) if raw else doc.xref_stream(ref)
            if data is None:raise RuntimeError('expected-stream-missing')
            total+=len(data)
        except (RuntimeError,ValueError) as error:
            raise RuntimeError(f"stream-accounting-failed:{ref}") from error
    return total

def features(doc,page,text):
    images=page.get_images(full=True)
    image_refs=[x[0] for x in images]+[x[1] for x in images if x[1]]
    contents=list(page.get_contents())+[x[0] for x in page.get_xobjects()]
    image_info=page.get_image_info(xrefs=True)
    visible_rect=page.rect * page.derotation_matrix
    area=max(1,visible_rect.get_area())
    rects=[fitz.Rect(i['bbox']) & visible_rect for i in image_info]
    rects=[r for r in rects if not r.is_empty]
    xs=sorted({x for r in rects for x in [r.x0,r.x1]});union=0
    for x0,x1 in zip(xs,xs[1:]):
        intervals=sorted((r.y0,r.y1) for r in rects if r.x0<x1 and r.x1>x0)
        bottom=None;vertical=0
        for y0,y1 in intervals:
            if bottom is None or y0>bottom:vertical+=y1-y0
            elif y1>bottom:vertical+=y1-bottom
            bottom=max(bottom or y1,y1)
        union+=(x1-x0)*vertical
    coverage=min(1,union/area)
    placed_refs={i.get('xref',0) for i in image_info if i.get('xref',0) and (fitz.Rect(i['bbox']) & visible_rect).get_area()>0}
    placed_refs|={x[1] for x in images if x[0] in placed_refs and x[1]}
    trace=page.get_texttrace()
    drawings=page.get_drawings()
    opaque=[d for d in drawings if d.get("fill") is not None and d.get("fill_opacity",1)==1 and len(d["items"])==1 and d["items"][0][0]=="re"]
    chars=sum(len(x["chars"]) for x in trace)
    invisible=sum(len(x["chars"]) for x in trace if x.get("type")==3 or x.get("opacity",1)==0)
    occluded=sum(len(x["chars"]) for x in trace if any(d.get("seqno",-1)>x.get("seqno",0) and fitz.Rect(d["rect"]).contains(fitz.Rect(x["bbox"])) for d in opaque))
    return {"actualTextBytes":len(text.encode()),"actualCharacters":len(text.strip()),
            "observedGlyphs":chars,"invisibleGlyphs":invisible,"occludedGlyphs":occluded,
            "glyphYield":len(text.strip())/max(1,chars),
            "imageCoverage":coverage,"imageCount":len(image_info),
            "imageStreamBytes":stream_bytes(doc,image_refs,True),
            "placedImageStreamBytes":stream_bytes(doc,placed_refs,True),
            "contentCompressedBytes":stream_bytes(doc,contents,True),
            "contentDecodedBytes":stream_bytes(doc,contents,False),
            "vectorDrawingCount":len(drawings),"fontCount":len(page.get_fonts()),
            "pageArea":area,"rotation":page.rotation,"documentObjectCount":doc.xref_length()}

def measure_case(args):
    root,case,out,scorers,identity,policy_hash=args
    root,out=Path(root),Path(out)
    destination=out/"cases"/case['split']/f"{case['id']}.json"
    case_identity={'sourceHash':case['sha256'],'labelHash':case['labelHash'],'evaluationIdentityHash':identity_hash(identity),'policyHash':policy_hash}
    source=root/case["pdf"]
    labels_path=root/case['labels']
    if not source.resolve().is_relative_to(root.resolve()) or not labels_path.resolve().is_relative_to(root.resolve()):raise RuntimeError('artifact-escaped-dataset')
    if file_hash(source)!=case['sha256'] or file_hash(labels_path)!=case['labelHash']:raise RuntimeError('artifact-hash-mismatch')
    if destination.exists():
        existing=json.loads(destination.read_text())
        if existing.get("caseIdentity")!=case_identity:
            raise RuntimeError("cached-case-identity-mismatch-use-new-run")
        return {"id":case["id"],"cached":True}
    sys.path.insert(0,scorers)
    import tolerant_markdown
    source=root/case["pdf"]
    if sha(source.read_bytes()) != case["sha256"]: raise RuntimeError("input-hash-mismatch")
    if file_hash(root/case['labels'])!=case['labelHash']:raise RuntimeError('label-hash-mismatch')
    doc=fitz.open(source)
    outputs=[]
    # Capture real per-document Poppler work too, including its startup cost.
    listing,list_seconds=invoke(["pdfimages","-list",str(source)])
    native,native_seconds=invoke(["pdftotext","-layout",str(source),"-"])
    native_pages=native.decode().split("\f")
    if len(native_pages)==len(doc)+1 and not native_pages[-1].strip(): native_pages.pop()
    if len(native_pages)!=len(doc): raise RuntimeError("poppler-page-alignment-mismatch")
    for index,page in enumerate(doc):
        started=time.perf_counter()
        feat=features(doc,page,native_pages[index])
        probe_seconds=time.perf_counter()-started
        candidates={"native":{"text":native_pages[index],"seconds":native_seconds/len(doc),"cacheHit":False}}
        for name,dpi,psm in [("ocr-fast",150,6),("ocr-strong",300,3)]:
            start=time.perf_counter()
            image=page.get_pixmap(dpi=dpi,alpha=False).tobytes("png")
            render_seconds=time.perf_counter()-start
            result=ocr(image,out/"cache",dpi,psm)
            result["renderSeconds"]=render_seconds
            candidates[name]=result
        outputs.append({"page":index+1,"features":feat,"probeSeconds":probe_seconds,"candidates":candidates})
    # Splitting experiments use exact object lengths and preserve shared-resource identities
    # within each output; no file-size/character conversion is assumed.
    splits={}
    with tempfile.TemporaryDirectory(prefix="mixed-split-",dir=os.environ["TMPDIR"]) as tmp:
        for size in [1,4]:
            started=time.perf_counter()
            pattern=str(Path(tmp)/f"{size}-%d.pdf")
            _,split_seconds=invoke(["qpdf",f"--split-pages={size}",str(source),pattern])
            parts=sorted(Path(tmp).glob(f"{size}-*.pdf"))
            byte_total=0; chunks=[]; extract_seconds=0; joined=[]
            for part in parts:
                byte_total+=part.stat().st_size
                extracted,elapsed=invoke(["pdftotext","-layout",str(part),"-"])
                extract_seconds+=elapsed; joined.append(extracted.decode())
                chunk=fitz.open(part)
                refs={r for page in chunk for image in page.get_images(full=True) for r in [image[0],image[1]] if r}
                image_bytes=stream_bytes(chunk,refs,True)
                chunks.append({"bytes":part.stat().st_size,"imageBytes":image_bytes,"residualBytes":part.stat().st_size-image_bytes,"pages":len(chunk),"textBytes":len(extracted)})
                chunk.close()
            splits[str(size)]={"splitSeconds":split_seconds,"extractSeconds":extract_seconds,"bytes":byte_total,"chunks":chunks,
                              "accountingSeconds":max(0,time.perf_counter()-started-split_seconds-extract_seconds),
                              "nativeTokensEqual":tokens("\n".join(joined))==tokens(native.decode())}
    doc.close()
    for index,page in enumerate(outputs):
        page["features"]["singleResidualBytes"]=splits["1"]["chunks"][index]["residualBytes"]
        chunk=splits["4"]["chunks"][index//4]
        page["features"]["fourResidualBytes"]=chunk["residualBytes"]/chunk["pages"]
    # Reference access is confined to scoring after candidates are complete.
    labels=json.loads((root/case["labels"]).read_text())
    validate_labels(labels,case,len(outputs))
    for page,reference in zip(outputs,labels["pages"]):
        for result in page["candidates"].values():
            result["score"]=content_score(reference,result["text"],tolerant_markdown)
    result={"id":case["id"],"family":case["family"],"split":case["split"],"hardPercent":case["hardPercent"],
            "measureHash":MEASURE_HASH,"caseIdentity":case_identity,
            "baseRegionRasterShare":case["baseRegionRasterShare"],"sourceHash":case["sha256"],
            "pdfBytes":source.stat().st_size,"nativeSeconds":native_seconds,"imageListSeconds":list_seconds,
            "pdfimages":listing.decode(),"splits":splits,"pages":outputs}
    destination.write_text(json.dumps(result))
    return {"id":case["id"],"pages":len(outputs)}

if __name__ == "__main__":
    p=argparse.ArgumentParser(); p.add_argument("--dataset",type=Path,required=True); p.add_argument("--out",type=Path,required=True)
    p.add_argument("--scorers",type=Path,required=True); p.add_argument("--split",choices=["train","tune","heldout"],required=True)
    p.add_argument("--workers",type=int,default=3); p.add_argument("--frozen-policy",type=Path)
    p.add_argument("--families",help="Predeclared complete source families, comma-separated numbers")
    a=p.parse_args();os.environ["MIXED_EVAL_WORKERS"]=str(a.workers);os.environ["MIXED_EVAL_ATTEMPT"]=str(uuid.uuid4());os.environ.setdefault("TMPDIR","/home/dan/tmp/agents")
    manifest=json.loads((a.dataset/"manifest.json").read_text())
    all_cases=validate_manifest(manifest)
    identity=evaluation_identity(a.dataset,a.scorers,Path(__file__),OCR_BINARY_HASH,OCR_LANGUAGE_HASH,fitz.VersionBind)
    policy_hash=None
    if a.split=="heldout":
        if not a.frozen_policy or not a.frozen_policy.is_file():raise RuntimeError("heldout-requires-frozen-policy")
        receipt=json.loads(a.frozen_policy.read_text())
        tuning=a.out/"tune-complete.json"
        completed_tuning=json.loads(tuning.read_text())
        validate_complete_inventory(completed_tuning,"tune")
        tuning_panel=a.out/'tune-panel.json'
        panel=json.loads(tuning_panel.read_text())
        validate_panel_binding(completed_tuning,panel,file_hash(tuning_panel))
        validate_panel_manifest(panel,manifest)
        validate_policy_receipt(receipt,identity,file_hash(Path(__file__).with_name("optimize.py")),file_hash(tuning))
        policy_hash=file_hash(a.frozen_policy)
    cases=[c for c in all_cases if c['split']==a.split]
    if a.families:
        selected={f"mixed-source-{int(x):04d}" for x in a.families.split(',')}
        cases=[c for c in cases if c['family'] in selected]
        if {c['family'] for c in cases}!=selected:raise RuntimeError('family-selection-not-in-split')
    if not cases:raise RuntimeError('empty-panel')
    for folder in [a.out/'cases'/a.split,a.out/'cache']:folder.mkdir(parents=True,exist_ok=True)
    immutable_json(a.out/'evaluation-identity.json',identity)
    immutable_json(a.out/'dataset-manifest.json',manifest)
    inventory={'schema':'mixed-pdf-panel@v2','split':a.split,'evaluationIdentityHash':identity_hash(identity),
               'policyHash':policy_hash,'selectedFamilies':sorted({c['family'] for c in cases}),'cases':[{k:c[k] for k in ['id','family','split','hardPercent','sha256','labelHash']} for c in cases]}
    validate_panel_manifest(inventory,manifest)
    immutable_json(a.out/f'{a.split}-panel.json',inventory)
    started=time.time()
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        futures=[pool.submit(measure_case,(str(a.dataset),c,str(a.out),str(a.scorers),identity,policy_hash)) for c in cases]
        for count,future in enumerate(as_completed(futures),1):
            print(json.dumps({'done':count,'total':len(cases),**future.result()}),flush=True)
    completed={**inventory,'schema':'mixed-pdf-complete@v2',
               'panelHash':file_hash(a.out/f'{a.split}-panel.json'),'resultHashes':{c['id']:file_hash(a.out/'cases'/a.split/f"{c['id']}.json") for c in cases}}
    validate_complete_inventory(completed,a.split)
    immutable_json(a.out/f'{a.split}-complete.json',completed)
    with (a.out/'attempts.jsonl').open('a') as stream:
        stream.write(json.dumps({'split':a.split,'workers':a.workers,'startedUnix':started,'elapsedSeconds':time.time()-started,'completedCases':len(cases)})+'\n')
