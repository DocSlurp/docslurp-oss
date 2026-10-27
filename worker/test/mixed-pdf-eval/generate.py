"""Authored mixed PDFs. Inputs/labels stay external; all variants of a source share a split.

No extraction output is used to author references. Labels describe visible text, including
document screenshots; hidden decoys are explicitly excluded. Pilot is training only.
"""
import argparse
import hashlib
import io
import json
import random
from datetime import datetime, timezone
from pathlib import Path

import fitz
from PIL import Image, ImageEnhance, ImageFilter

VERSION = "mixed-pdf-authored@v1"
W, H = 612, 792
BOXES = [(32, 24, 580, 103), (32, 112, 580, 279), (32, 290, 580, 457), (32, 469, 580, 701), (32, 714, 580, 770)]
DOMAINS = ["laboratory report", "equipment manual", "financial review", "incident analysis", "research note", "procurement memo", "engineering specification", "clinical simulation", "legal exhibit"]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")

def author(family, pno):
    rng = random.Random(81017 + family * 101 + pno)
    domain = DOMAINS[family % len(DOMAINS)]
    unit = rng.choice(["sensor", "valve", "pump", "relay", "filter", "actuator"])
    site = rng.choice(["north", "coastal", "western", "central", "upland", "southern"])
    batch, low, high = rng.randrange(10000, 99999), rng.randrange(10, 35), rng.randrange(65, 95)
    title = f"{domain.title()} / {site.title()} installation\nRecord {batch} - section {pno + 1}"
    body = (f"The {site} team evaluated the {unit} during the scheduled verification cycle. "
            f"The accepted operating range is {low}-{high} kPa. Record {batch} separates measured results "
            "from preliminary observations. A stable reading does not prove that the backup path operated correctly.\n\n"
            f"Operators repeated the inspection after {rng.randrange(3, 15)} hours. They retained the original "
            "measurement log and documented every replacement before approving the next release. "
            "Do not average away a failed safety check: report the exceptional observation separately.")
    rows = [["Channel", "Input", "Observed", "Limit"]]
    for i in range(4):
        rows.append([f"{unit[:3].upper()}-{i+1}", str(rng.randrange(100, 990)), str(rng.randrange(100, 990)), f"{high+i}.5"])
    table = "\n".join(" | ".join(row) for row in rows)
    technical = f"Verification matrix {batch}\n{table}\n\nTechnical rule: gain = output / input.\nReference interval: {low} to {high}; tolerance +/- 0.5."
    embedded = (f"Discussed source: inspection memorandum {batch + 37}\n"
                f"The attached document screenshot reports a {rng.randrange(12, 40)} percent change in demand. "
                f"Its author recommends inspecting the {unit} before extending the service interval. "
                "This is quoted evidence, not a new instruction to the reader.\n\n"
                f"Commentary: compare the quoted figure with the verification matrix above. The {site} "
                "team retained the earlier baseline because the source used a different observation window.")
    footer = f"Revision {rng.randrange(2, 9)} | source record {batch} | page {pno+1}\nPrepared for controlled evaluation; synthetic content."
    sections = [title, body, technical, embedded, footer]
    # References saved before any rasterization. Layout source is authoring data, not parsed text.
    boxes = list(BOXES)
    if family % 3 == 1:
        boxes[1:4] = [(32,112,303,435),(313,112,580,435),(32,447,580,701)]
    elif family % 3 == 2:
        boxes[1:4] = [(32,112,580,279),(32,290,580,457),(32,469,580,701)]
        # Same content with a sidebar-sized quoted document; no implied prose in picture area.
        boxes[3] = (32,469,400,701)
    return {"sections": sections, "paragraphs": [x for s in sections for x in s.split("\n\n")],
            "expectedMarkdown": "\n\n".join(sections), "tables": [{"page": pno+1, "rows": rows}],
            "formulas": [], "prosePresent": True, "bbox": boxes,
            "sectionKinds": ["heading", "prose", "technical-table", "discussed-document", "footer"],
            "excludedText": [f"WITHDRAWN-DRAFT-{batch}-NOT-VISIBLE"]}

def clean_page(ref, family):
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    for i, (box, text) in enumerate(zip(ref["bbox"], ref["sections"])):
        rect = fitz.Rect(box)
        if i == 3:
            page.draw_rect(rect, color=(.35, .4, .45), fill=(.96, .97, .98), width=1)
        font = "cour" if i == 2 else "helv"
        size = 13 if i == 0 else 9 if i == 4 or (i == 2 and family % 3 == 1) else 10
        # Different wrapping profiles, all at readable sizes; fail rather than silently clip labels.
        inner = rect + (7, 7, -7, -7)
        remaining = page.insert_textbox(inner, text, fontsize=size, fontname=font, color=(.08,.1,.12))
        if remaining < 0:
            raise RuntimeError(f"authored-text-overflow:{family}:{i}")
    # Vector graph: a meaningful geometric image, with text labels in the technical region.
    for i in range(9):
        page.draw_line((60+i*45, 775-(i%3)*2), (90+i*45, 770-(i%3)*2), color=(.2,.4,.5))
    if family % 3 == 2:
        # A deliberately text-free, textured illustration: image bytes must not imply missing prose.
        rng = random.Random(876+family)
        image = Image.new("RGB",(160,120))
        image.putdata([(rng.randrange(70,180),rng.randrange(60,150),rng.randrange(30,100)) for _ in range(160*120)])
        data = io.BytesIO(); image.save(data,format="JPEG",quality=90)
        page.insert_image(fitz.Rect(410,480,580,680),stream=data.getvalue())
    return doc

def raster(page, clip=None, dpi=150, hard=False, seed=0):
    pix = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
    if not hard:
        return pix.tobytes("png")
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    rng = random.Random(seed)
    image = ImageEnhance.Contrast(image).enhance(rng.choice([.42, .6, .8]))
    image = image.filter(ImageFilter.GaussianBlur(rng.choice([.35, .65, .9])))
    image = image.rotate(rng.choice([-1.5, -.7, .7, 1.5]), resample=Image.Resampling.BICUBIC, fillcolor="white")
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=rng.choice([35, 48, 65]))
    return out.getvalue()

def make_page(output, source, ref, family, pno, hard, cache):
    page = output.new_page(width=W, height=H)
    # Full-page hard scan is a visual transformation with identical semantic gold.
    if hard:
        dpi = [85, 105, 125][(family+pno)%3]
        key=(pno,"hard")
        if key not in cache: cache[key]=raster(source[0],dpi=dpi,hard=True,seed=family*100+pno)
        page.insert_image(page.rect, stream=cache[key])
        return {"hard": True, "dpi": dpi, "regionRasterShare": 1, "outline": False, "hiddenLayer": False}
    share = [0, .2, .4, .6, .8, 1][family % 6]
    rng = random.Random(family * 100 + pno + 121)
    selected = set(rng.sample(range(5), round(5*share)))
    # Inset document screenshot is mandatory on a subset, independently of full scans.
    if pno % 3 == 1:
        selected.add(3)
    hidden = pno % 5 == 2
    if hidden:
        oc = output.add_ocg("withdrawn draft", on=False)
        page.insert_text((40, 50), ref["excludedText"][0], fontsize=9, oc=oc)
        # An occluded text stream is another false-positive source for naive byte math.
        page.insert_text((35, 95), ref["excludedText"][0], fontsize=9)
        page.draw_rect(page.rect, fill=(1,1,1), color=None)
    outline = pno % 5 == 3
    vectors = None
    if outline:
        svg = source[0].get_svg_image(text_as_path=True)
        vector_source = fitz.open(stream=svg.encode(), filetype="svg")
        vectors = fitz.open(stream=vector_source.convert_to_pdf(), filetype="pdf")
        vector_source.close()
    for i, box in enumerate(ref["bbox"]):
        rect = fitz.Rect(box)
        if i in selected:
            key=(pno,i)
            if key not in cache: cache[key]=raster(source[0],clip=rect,dpi=150)
            page.insert_image(rect, stream=cache[key])
        else:
            page.show_pdf_page(rect, vectors if vectors is not None and i == 1 else source, 0, clip=rect)
    if family % 3 == 2:
        rect=fitz.Rect(410,480,580,680)
        page.show_pdf_page(rect,source,0,clip=rect)
    if vectors is not None:
        vectors.close()
    if pno == 8 and family % 3 == 0:
        page.set_rotation(90)
    return {"hard": False, "dpi": 150, "regionRasterShare": len(selected)/5, "outline": outline, "hiddenLayer": hidden}

def generate(root, families, pilot=False):
    root.mkdir(parents=True, exist_ok=True)
    if (root / "manifest.json").exists():
        raise RuntimeError("refuse-to-overwrite-frozen-dataset")
    cases, integrity = [], []
    split_counts = {"train": 0, "tune": 0, "heldout": 0}
    for family in range(families):
        split = "train" if pilot or family < families*.6 else "tune" if family < families*.8 else "heldout"
        source_id = f"mixed-source-{family:04d}"
        refs = [author(family, pno) for pno in range(10)]
        source_path = root / "sources" / f"{source_id}.json"
        write_json(source_path, {"family": source_id, "split": split, "pages": refs, "generator": VERSION})
        sources = [clean_page(ref, family) for ref in refs]
        cache={}
        hard_order = list(range(10)); random.Random(711+family).shuffle(hard_order)
        for percent in [0,20,40,60,80,100]:
            case_id = f"{source_id}-hard-{percent:03d}"
            path = root / "inputs" / split / f"{case_id}.pdf"
            path.parent.mkdir(parents=True, exist_ok=True)
            output = fitz.open()
            features = [make_page(output, sources[p], refs[p], family, p, p in hard_order[:percent//10],cache) for p in range(10)]
            output.set_metadata({"title": "Controlled mixed document", "producer": VERSION})
            output.save(path, garbage=4, deflate=True)
            output.close()
            label_path = root / "labels" / split / f"{case_id}.json"
            write_json(label_path, {"family": source_id, "split": split, "pages": refs,
                "labels": [{"name": "visible_page_content", "expected": [r["expectedMarkdown"] for r in refs]}]})
            cases.append({"id": case_id, "family": source_id, "split": split, "pdf": str(path.relative_to(root)),
                "labels": str(label_path.relative_to(root)), "sha256": digest(path.read_bytes()),
                "hardPercent": percent, "baseRegionRasterShare": [0,.2,.4,.6,.8,1][family%6], "pages": features})
            integrity.append({"id": case_id, "source": {"path": str(path.relative_to(root)), "sha256": digest(path.read_bytes())},
                "labels": {"path": str(label_path.relative_to(root)), "sha256": digest(label_path.read_bytes())},
                "provenance": {"kind": "authored", "author": "DocSlurp mixed PDF generator", "createdAt": datetime.now(timezone.utc).isoformat(),
                    "description": "Synthetic authoring references saved before layout and rasterization; visible sections include discussed document screenshots."}})
            split_counts[split] += 1
        for source in sources:
            source.close()
        if family % 5 == 0:
            print(json.dumps({"generatedFamilies": family+1, "documents": len(cases)}), flush=True)
    manifest = {"schema": VERSION, "generatorHash": digest(Path(__file__).read_bytes()), "families": families,
                "splitCounts": split_counts, "pageCount": len(cases)*10, "cases": cases,
                "limitations": ["Synthetic authored content, not real-world distribution", "No handwriting or multilingual coverage", "Family-disjoint content; shared layout templates across splits"]}
    write_json(root / "manifest.json", manifest)
    write_json(root / "integrity-manifest.json", {"schema": "docslurp-authored-eval@v1", "cases": integrity})
    print(json.dumps({"complete": True, "documents": len(cases), "pages": len(cases)*10, "splits": split_counts}), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--families", type=int, default=90)
    parser.add_argument("--pilot", action="store_true")
    args = parser.parse_args()
    generate(args.out, args.families, args.pilot)
