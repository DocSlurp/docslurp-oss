"""Inspect storage accounting independently from text-quality scoring, on training PDFs."""
import argparse,json,re,subprocess
from collections import Counter,defaultdict
from pathlib import Path
import fitz

def inspect(path):
    doc=fitz.open(path);objects=[];totals=Counter();page_users=defaultdict(list)
    font_files=set()
    for xref in range(1,doc.xref_length()):
        for key in ["FontFile","FontFile2","FontFile3"]:
            kind,value=doc.xref_get_key(xref,key)
            if kind=="xref":font_files.add(int(value.split()[0]))
    for index,page in enumerate(doc):
        refs=set(page.get_contents())|{r for x in page.get_images(full=True) for r in [x[0],x[1]] if r}|{x[0] for x in page.get_xobjects()}|{x[0] for x in page.get_fonts()}
        pending=list(refs)
        while pending:
            parent=pending.pop()
            for key in ['FontDescriptor','DescendantFonts','FontFile','FontFile2','FontFile3','SMask','Mask']:
                _,value=doc.xref_get_key(parent,key)
                for child in re.findall(r'(\d+)\s+\d+\s+R',value):
                    child=int(child)
                    if child not in refs:refs.add(child);pending.append(child)
        for ref in refs:page_users[ref].append(index+1)
    for xref in range(1,doc.xref_length()):
        if not doc.xref_is_stream(xref):continue
        subtype=doc.xref_get_key(xref,"Subtype")[1]
        kind="image" if subtype=="/Image" else "font" if xref in font_files else "form-content" if subtype=="/Form" else "other-content"
        raw=len(doc.xref_stream_raw(xref));decoded=len(doc.xref_stream(xref))
        totals[kind]+=raw;objects.append({"xref":xref,"kind":kind,"compressedBytes":raw,"decodedBytes":decoded,"referencedByPages":page_users.get(xref,[])})
    doc.close();size=path.stat().st_size
    return {"pdf":str(path),"fileBytes":size,"streamBytes":dict(totals),"nonStreamAndContainerBytes":size-sum(totals.values()),
            "sharedStreamObjects":sum(len(o["referencedByPages"])>1 for o in objects),"objects":objects,
            "limitations":["A resource reference does not prove it is visible after clipping", "Form content mixes text and drawing operators", "Shared-resource attribution is a policy, not a physical page byte range"]}

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--dataset",type=Path,required=True);a=p.parse_args()
    out=a.dataset/"object-maps";out.mkdir(exist_ok=True)
    summaries=[]
    for family,hard in [(0,0),(0,20),(0,80),(0,100),(2,0),(5,0)]:
        path=a.dataset/"inputs/train"/f"mixed-source-{family:04d}-hard-{hard:03d}.pdf"
        report=inspect(path);(out/f"{path.stem}.json").write_text(json.dumps(report,indent=2))
        raw=subprocess.run(["qpdf","--show-xref",str(path)],capture_output=True,check=True).stdout
        (out/f"{path.stem}.xref.txt").write_bytes(raw)
        raw=subprocess.run(["qpdf","--json",str(path)],capture_output=True,check=True).stdout
        (out/f"{path.stem}.qpdf.json").write_bytes(raw)
        summaries.append({k:v for k,v in report.items() if k!="objects"})
    (out/"summary.json").write_text(json.dumps(summaries,indent=2))
    print(json.dumps(summaries))
