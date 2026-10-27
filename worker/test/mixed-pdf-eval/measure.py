"""Local paired measurements. Extractors receive PDF pixels only, never reference labels.

Labels are loaded after extraction for deterministic scoring. Heldout requires a frozen
policy receipt. Raw outputs, component scores, time and cache identities are retained.
"""
import argparse
import csv
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unicodedata

import fitz

VERSION = "mixed-page-preservation@v1"
MEASURE_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def tokens(text):
    return re.findall(r"[-+]?\d+(?:\.\d+)?|[^\W\d_]+", unicodedata.normalize("NFKC", text).casefold())

def content_score(reference, text, legacy):
    expected, actual = Counter(tokens(reference["expectedMarkdown"])), Counter(tokens(text))
    matched = sum((expected & actual).values())
    recall = matched/max(1, sum(expected.values()))
    precision = matched/max(1, sum(actual.values()))
    sections = []
    for section in reference["sections"]:
        wanted = Counter(tokens(section))
        sections.append(sum((wanted & actual).values())/max(1,sum(wanted.values())))
    numbers = lambda c: Counter({k:v for k,v in c.items() if re.fullmatch(r"[-+]?\d+(?:\.\d+)?",k)})
    a,b = numbers(expected), numbers(actual)
    numeric = sum((a&b).values())/max(1,sum(a.values()))
    excluded = any(x in text for x in reference["excludedText"])
    stream=" " + " ".join(tokens(text)) + " "
    table_rows=[row for table in reference["tables"] for row in table["rows"][1:]]
    table_row_recall=sum((" "+" ".join(tokens(" ".join(row)))+" ") in stream for row in table_rows)/max(1,len(table_rows))
    ref = {"prose":reference["expectedMarkdown"], "paragraphs":reference["paragraphs"],
           "tables":reference["tables"], "formulas":reference["formulas"], "groundTruth":{"prosePresent":True,"kind":"authored"}}
    modern = legacy.compact(legacy.score(ref,text))
    return {"version":VERSION, "recall":recall,"precision":precision,
            "f1":2*recall*precision/max(1e-9,recall+precision),"sectionRecall":sections,
            "minimumSectionRecall":min(sections),"numericRecall":numeric,"hiddenTextLeak":excluded,
            "tableRowRecall":table_row_recall,
            "quality": min(recall, precision, min(sections),table_row_recall),
            "acceptable":recall>=.95 and precision>=.95 and min(sections)>=.90 and numeric>=.95 and table_row_recall>=.95 and not excluded,
            "modern":modern}

def invoke(argv):
    started=time.perf_counter()
    completed=subprocess.run(argv, capture_output=True, timeout=90,
        env={**os.environ,"OMP_THREAD_LIMIT":"1"})
    elapsed=time.perf_counter()-started
    if completed.returncode:
        raise RuntimeError(f"command-failed:{argv[0]}:{completed.returncode}:{completed.stderr[-500:]!r}")
    return completed.stdout,elapsed

def ocr(image, cache, dpi, psm):
    key=sha(image+f"tesseract-5.5.3-eng-dpi{dpi}-psm{psm}-txt-tsv-v2".encode())
    output=cache/f"{key}.json"
    if output.exists():
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
                "cacheHit":False,"imageHash":sha(image)}
        temp=cache/f"{key}.{os.getpid()}.new"
        temp.write_text(json.dumps(result)); temp.replace(output)
        return result

def stream_bytes(doc, refs, raw):
    total=0
    for ref in set(refs):
        try:
            data=doc.xref_stream_raw(ref) if raw else doc.xref_stream(ref)
            total+=len(data or b"")
        except (RuntimeError,ValueError):
            pass
    return total

def features(doc,page,text):
    images=page.get_images(full=True)
    image_refs=[x[0] for x in images]+[x[1] for x in images if x[1]]
    contents=list(page.get_contents())+[x[0] for x in page.get_xobjects()]
    image_info=page.get_image_info(xrefs=True)
    area=max(1,page.rect.get_area())
    coverage=min(1,sum((fitz.Rect(i["bbox"]) & page.rect).get_area() for i in image_info)/area)
    trace=page.get_texttrace()
    chars=sum(len(x["chars"]) for x in trace)
    invisible=sum(len(x["chars"]) for x in trace if x.get("type")==3 or x.get("opacity",1)==0)
    return {"actualTextBytes":len(text.encode()),"actualCharacters":len(text.strip()),
            "observedGlyphs":chars,"invisibleGlyphs":invisible,
            "glyphYield":len(text.strip())/max(1,chars),
            "imageCoverage":coverage,"imageCount":len(image_info),
            "imageStreamBytes":stream_bytes(doc,image_refs,True),
            "placedImageStreamBytes":stream_bytes(doc,[i.get("xref",0) for i in image_info if i.get("xref",0) and (fitz.Rect(i["bbox"]) & page.rect).get_area()>0],True),
            "contentCompressedBytes":stream_bytes(doc,contents,True),
            "contentDecodedBytes":stream_bytes(doc,contents,False),
            "vectorDrawingCount":len(page.get_drawings()),"fontCount":len(page.get_fonts()),
            "pageArea":area,"rotation":page.rotation,"documentObjectCount":doc.xref_length()}

def measure_case(args):
    root,case,out,scorers=args
    root,out=Path(root),Path(out)
    destination=out/"cases"/f"{case['id']}.json"
    if destination.exists():
        existing=json.loads(destination.read_text())
        if existing.get("sourceHash")!=case["sha256"] or existing.get("measureHash")!=MEASURE_HASH:
            raise RuntimeError("cached-case-identity-mismatch-use-new-run")
        return {"id":case["id"],"cached":True}
    sys.path.insert(0,scorers)
    import tolerant_markdown
    source=root/case["pdf"]
    if sha(source.read_bytes()) != case["sha256"]: raise RuntimeError("input-hash-mismatch")
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
                              "nativeTokensEqual":tokens("\n".join(joined))==tokens(native.decode())}
    doc.close()
    # Reference access is confined to scoring after candidates are complete.
    labels=json.loads((root/case["labels"]).read_text())
    for page,reference in zip(outputs,labels["pages"]):
        for result in page["candidates"].values():
            result["score"]=content_score(reference,result["text"],tolerant_markdown)
    result={"id":case["id"],"family":case["family"],"split":case["split"],"hardPercent":case["hardPercent"],
            "measureHash":MEASURE_HASH,
            "baseRegionRasterShare":case["baseRegionRasterShare"],"sourceHash":case["sha256"],
            "pdfBytes":source.stat().st_size,"nativeSeconds":native_seconds,"imageListSeconds":list_seconds,
            "pdfimages":listing.decode(),"splits":splits,"pages":outputs}
    destination.write_text(json.dumps(result))
    return {"id":case["id"],"pages":len(outputs)}

if __name__ == "__main__":
    p=argparse.ArgumentParser(); p.add_argument("--dataset",type=Path,required=True); p.add_argument("--out",type=Path,required=True)
    p.add_argument("--scorers",type=Path,required=True); p.add_argument("--splits",default="train,tune"); p.add_argument("--limit",type=int)
    p.add_argument("--workers",type=int,default=3); p.add_argument("--frozen-policy",type=Path)
    p.add_argument("--families", help="Comma-separated source-family numbers; predeclared evaluation panel")
    p.add_argument("--manifest",default="manifest.json",help="Frozen input inventory; allows a completed training panel during corpus generation")
    a=p.parse_args()
    if "heldout" in a.splits.split(",") and (not a.frozen_policy or not a.frozen_policy.is_file()):
        raise RuntimeError("heldout-requires-frozen-policy")
    os.environ.setdefault("TMPDIR","/home/dan/tmp/agents")
    manifest=json.loads((a.dataset/a.manifest).read_text())
    cases=[c for c in manifest["cases"] if c["split"] in a.splits.split(",")]
    if a.families:
        selected={f"mixed-source-{int(x):04d}" for x in a.families.split(",")}
        cases=[c for c in cases if c["family"] in selected]
    if a.limit: cases=cases[:a.limit]
    for folder in [a.out/"cases",a.out/"cache"]: folder.mkdir(parents=True,exist_ok=True)
    identity={"datasetHash":sha((a.dataset/a.manifest).read_bytes()),"measureHash":MEASURE_HASH,
              "scorerHashes":{p.name:sha(p.read_bytes()) for p in a.scorers.glob("*.py")},
              "splits":a.splits,"workers":a.workers,"caseCount":len(cases),
              "frozenPolicyHash":sha(a.frozen_policy.read_bytes()) if a.frozen_policy else None}
    (a.out/f"run-{a.splits.replace(',','-')}.json").write_text(json.dumps(identity,indent=2))
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        futures=[pool.submit(measure_case,(str(a.dataset),c,str(a.out),str(a.scorers))) for c in cases]
        for count,future in enumerate(as_completed(futures),1):
            print(json.dumps({"done":count,"total":len(cases),**future.result()}),flush=True)
