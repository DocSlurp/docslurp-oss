#!/usr/bin/env python3
"""Deterministic source-first synthetic layout silver corpus (Pillow + NumPy).

No downloaded photos, fonts, models, or paid calls. Sources and reference labels
are persisted before rasterization. Synthetic artwork is explicitly not evidence
of camera-domain accuracy. Run test_corpus.py before publishing a corpus.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import math
import random
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

VERSION = "layout-synthetic-v1"
ASSET_RECORDS = []
ASSET_DIR = None
FAMILIES = ("report", "academic", "magazine", "classified", "textbook", "infographic", "mindmap", "financial", "form", "menu", "image_full", "image_half", "newsletter", "manual", "table_continuation", "poster")
LABELS = {"paragraph", "title", "list", "table", "chart", "photo", "logo", "formula", "caption", "header", "footer", "form", "mind_map", "illustration"}
DIMENSIONS = ((850, 1100), (827, 1169), (1000, 750), (700, 1000), (1000, 1400))
PALETTES = (("#193847", "#d36a34", "#eef3ef"), ("#603d77", "#dbb72e", "#faf0df"), ("#125d54", "#d94c69", "#e1f2ef"), ("#223758", "#d85b24", "#f0f4fb"))
TEXT = [
 "The neighborhood field survey records how people use shared spaces throughout the day. Observations combine counts, short interviews and sketches made at each location.",
 "A useful comparison keeps the scale and time window consistent. Small changes can reveal an underlying pattern, although individual observations still vary across sites.",
 "Materials should be stored in a dry place and inspected before use. Record the date, quantity and condition of each item, then check the summary against the original notes.",
 "Water moves between the air, soil and living things. Plants take up moisture through their roots, while warmth helps water return to the atmosphere as vapor.",
 "The proposed schedule includes preparation, measurement and review. Each team records its results independently before discussing differences and repeating uncertain measurements.",
]
FONT_ROOT = Path("/usr/share/fonts/liberation")


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def polygon(box):
    x0, y0, x1, y1 = box
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def add(source, label, box, text=None, **attrs):
    region = {"id": f"r{len(source['regions']):03d}", "label": label, "bbox": [round(v, 3) for v in box], "polygon": polygon(box), "text": text, "reading_order": len(source["regions"]), "visibility": 1.0, "attributes": attrs}
    source["regions"].append(region)
    return region


def table(source, box, rng, rows=8, columns=4, border=True, continuation=None, row_offset=0):
    x0, y0, x1, y1 = box
    cells = []
    for r in range(rows):
        for c in range(columns):
            b = [x0 + c * (x1-x0)/columns, y0+r*(y1-y0)/rows, x0+(c+1)*(x1-x0)/columns, y0+(r+1)*(y1-y0)/rows]
            text = (["Item", "Units", "Price", "Total", "Notes"][c % 5] if r == 0 else (f"Sample {row_offset+r:02d}" if c == 0 else f"{rng.randint(2, 99)}.{rng.randint(0,99):02d}"))
            cells.append({"row": r, "column": c, "logical_row": row_offset+r, "text": text, "bbox": b, "polygon": polygon(b), "is_header": r == 0})
    return add(source, "table", box, None, cells=cells, rows=rows, columns=columns, border=border, continuation_id=continuation, header_repeated=bool(continuation))


def build_source(index, seed):
    family = FAMILIES[index % len(FAMILIES)]
    serial = index // len(FAMILIES)
    # Groups are complete source families; no transformed sibling crosses a split.
    split = "holdout" if serial >= 12 else "dev" if serial >= 8 else "train"
    rng = random.Random(seed + index * 7919)
    w, h = DIMENSIONS[(serial + index % 3) % len(DIMENSIONS)]
    source = {"schema_version": VERSION, "id": f"{family}-{serial:03d}", "source_family": family, "template_family": f"{family}-structure-{serial//2:02d}", "difficulty": "dense" if family in ("magazine","classified","mindmap") else "mixed" if family in ("infographic","textbook","academic") else "regular", "split": split, "seed": seed + index * 7919, "width": w, "height": h, "document_id": f"{family}-doc-{serial//2:03d}" if family == "table_continuation" else f"{family}-{serial:03d}", "page_number": serial % 2 + 1 if family == "table_continuation" else 1, "palette": PALETTES[serial % 4], "regions": [], "ground_truth": {"status": "source-derived-silver", "prose_presence": "present", "paragraph_boundaries": "explicit-region-boundaries", "line_boundaries": "recorded-after-font-layout", "math": "not_applicable", "tables": "not_applicable", "absent_labels": []}, "limitations": ["Programmatic page layouts; decorative art and hands are synthetic illustrations. Photo regions use attributed real assets when supplied.", "Text regions use unions of rendered glyph bounds; container regions use authored borders. Glyph masks are not annotated."]}
    def box(a,b,c,d): return [a*w,b*h,c*w,d*h]
    def text(label, b, value, size=15, **kwargs): return add(source,label,box(*b),value,font_size=size,**kwargs)
    if family == "image_full":
        add(source,"photo",box(0,0,1,1),scene=["coast", "cafe", "city"][serial%3], extent="full_page")
        source["ground_truth"]["prose_presence"] = "absent"
    else:
        text("header",(.06,.025,.94,.047),f"FIELD JOURNAL  /  ISSUE {serial+1:02d}",11)
        title = {"classified":"THE COMMUNITY EXCHANGE", "magazine":"A city of possibilities", "textbook":"Explore, notice, discover!", "infographic":"How our water travels", "mindmap":"Ideas for a shared garden", "financial":"Quarterly operating review", "form":"Visitor information & consent", "menu":"The corner kitchen", "image_half":"On the edge of the coast", "table_continuation":"Inventory register — continued", "poster":"BUILD SOMETHING TOGETHER"}.get(family,"Measuring change in everyday places")
        text("title",(.06,.07,.94,.15),title, 30 if family != "classified" else 27)
        text("footer",(.06,.957,.94,.981),f"Independent field notes  •  {serial+1:02d}  •  Open sample edition",10)
        if family in ("report", "academic", "newsletter", "manual"):
            cols = 2 + (serial//2)%2 if family != "academic" else 2
            for col in range(cols):
                x=.06+col*.89/cols
                for row in range(4):
                    y=.19+row*.175
                    text("paragraph",(x,y,x+.89/cols-.025,y+.14),TEXT[(row+col+serial)%len(TEXT)],14 if cols==2 else 12)
            if family == "academic":
                # Reserve bottom right region, replacing paragraph rather than overlapping labels.
                source["regions"].pop()
                text("formula",(.52,.715,.93,.81),"E = mc²    ∑ xᵢ / n = μ",23)
                source["ground_truth"]["math"] = {"status":"present","expressions":["E = mc^2", "sum_i(x_i)/n = mu"]}
            elif family == "manual":
                source["regions"] = [r for r in source["regions"] if not (r["label"]=="paragraph" and r["bbox"][1] > .6*h and r["bbox"][0] > .5*w)]
                text("list",(.52,.62,.94,.9),"1. Inspect the cable.\n2. Connect the sensor.\n3. Record the reading.\n4. Clean and store the tool.",16)
        elif family == "classified":
            cols=4+(serial//2)%3; nrows=6+(serial//2)%3
            for col in range(cols):
                for row in range(nrows):
                    cw=.92/cols; rh=.754/nrows
                    x=.045+col*cw; y=.18+row*rh
                    text("paragraph",(x,y,x+cw-.008,y+rh-.007),f"{['FOR SALE','SERVICES','ROOMS','WANTED'][rng.randrange(4)]}\n{['Garden tools, good condition. Call today.','Repairs and lessons. Friendly local service.','Sunny room near the station. View Saturday.'][rng.randrange(3)]}\n555-{rng.randrange(100,999)}-{rng.randrange(1000,9999)}",9,border=bool(serial%2))
        elif family == "magazine":
            cols=2+(serial//2)%2; nrows=2+(serial//4)%2; cw=.94/cols; rh=.758/nrows
            for col in range(cols):
                for row in range(nrows):
                    x=.035+col*cw; y=.17+row*rh
                    add(source,"photo",box(x,y,x+cw-.025,y+rh*.57),scene=["cafe","coast","city"][(row+col+serial)%3],extent="advertisement_panel")
                    text("title",(x,y+rh*.59,x+cw-.025,y+rh*.73),["Make room for adventure","Fresh ideas, daily","Design for real life"][(row+col)%3],16,colorful=True)
                    text("paragraph",(x,y+rh*.75,x+cw-.025,y+rh*.96),"Local makers. Thoughtful details. Discover the collection this weekend.",11)
                    add(source,"logo",box(x+cw*.72,y+rh*.37,x+cw*.93,y+rh*.54),brand=f"NOVA {row+col}")
        elif family in ("financial", "table_continuation"):
            text("paragraph",(.06,.17,.94,.24),TEXT[serial%len(TEXT)],14)
            cont = f"inventory-{serial//2:03d}" if family == "table_continuation" else None
            table(source,box(.06,.29,.94,.86),rng,rows=13+(serial//2)%5,columns=4+(serial//2)%2,border=serial%2==0,continuation=cont,row_offset=0 if serial%2==0 else 12+(serial//2)%5)
            text("caption",(.06,.87,.94,.91),"Table 1. Counts exclude items pending inspection. All amounts are illustrative.",12)
        elif family == "form":
            text("paragraph",(.06,.17,.94,.25),"Please complete the fields below. Use block letters and check all options that apply.",15)
            for row in range(6):
                text("form",(.07,.29+row*.085,.93,.355+row*.085),["Full name", "Street address", "Email address", "Date of visit", "□ Morning  □ Afternoon", "Signature"][row],16)
            text("paragraph",(.07,.83,.93,.92),"I confirm that the information supplied is accurate. I understand the schedule may change and agree to follow the posted instructions.",13)
        elif family == "menu":
            for col in range(2):
                for row in range(6):
                    x=.07+col*.46; y=.19+row*.115
                    text("title",(x,y,x+.40,y+.032),["Roasted garden bowl","Soup of the day","Sourdough toast","Citrus salad","Coffee & cream","Seasonal cake"][row]+f"  {7+row}.50",16)
                    text("paragraph",(x,y+.036,x+.4,y+.09),"Fresh herbs, local ingredients and a little care. Ask about today's choices.",12)
        elif family == "image_half":
            add(source,"photo",box(.05,.18,.95,.64),scene="coast",extent="half_page")
            text("caption",(.06,.65,.94,.69),"The tidal marsh at first light, looking toward the headland.",12)
            text("paragraph",(.06,.73,.49,.92),TEXT[0],15)
            text("paragraph",(.53,.73,.94,.92),TEXT[1],15)
        elif family == "textbook":
            add(source,"illustration",box(.06,.18,.50,.49),scene="garden")
            text("paragraph",(.55,.18,.94,.47),"Can you find three shapes?\nLook at the leaves and flowers.\nDraw a circle around the tallest plant.\nWhat changes after the rain?",21,colorful=True)
            text("title",(.06,.54,.94,.60),"Try it yourself",25,colorful=True)
            text("list",(.08,.64,.53,.89),"• Count the green leaves.\n• Trace the round shapes.\n• Tell a friend what you see.",19)
            add(source,"chart",box(.59,.64,.94,.90),kind="bars",values=[2,5,3,7],axis_labels=["Red","Blue","Gold","Green"])
        elif family == "infographic":
            for row in range(3):
                y=.19+row*.24
                add(source,"chart",box(.06,y,.43,y+.20),kind=["bars","line","pie"][row],values=[rng.randint(2,12) for _ in range(5)],axis_labels=["A","B","C","D","E"])
                text("title",(.49,y,.94,y+.045),["Collect","Share","Renew"][row],24,colorful=True)
                text("paragraph",(.49,y+.06,.94,y+.20),TEXT[row],14)
        elif family == "mindmap":
            add(source,"mind_map",box(.06,.20,.94,.88),nodes=["Community garden","Water","Seeds","Tools","Volunteers","Harvest","Compost","Learning"],edges=[[0,i] for i in range(1,8)])
            text("caption",(.06,.90,.94,.93),"Working map: connections show planning relationships, not reading order.",11)
        elif family == "poster":
            add(source,"photo",box(.04,.18,.96,.66),scene="city",extent="poster")
            text("title",(.08,.69,.92,.77),"Saturday • 10 AM–4 PM",34,colorful=True)
            text("paragraph",(.08,.80,.72,.92),"Bring your ideas, meet your neighbors and help shape the next chapter. Free entry. Everyone is welcome.",20)
            add(source,"logo",box(.77,.81,.92,.92),brand="COMMON")
    source['regions'].sort(key=lambda r: (r['label']=='footer', r['label'] not in ('header','title') if r['bbox'][1]<h*.16 else True, r['reading_order']))
    for region in source['regions']:
        if region['label']=='photo':
            if ASSET_RECORDS:
                asset=ASSET_RECORDS[(serial+len(source['regions'])+source['regions'].index(region))%len(ASSET_RECORDS)]
                region['attributes']['photographic_asset']=asset
            else:
                region['label']='illustration'
                region['attributes']['photo_placeholder']=True
    for i,r in enumerate(source["regions"]):
        r['id']=f'r{i:03d}'; r["reading_order"] = i
    # Per-template geometric framing varies independently of capture variants.
    inset=(serial//2 % 4)*.012
    for region in source['regions']:
        def frame(poly): return [[round(w*inset+x*(1-2*inset),3),round(h*inset+y*(1-2*inset),3)] for x,y in poly]
        if family!='image_full':
            region['polygon']=frame(region['polygon']); xs,ys=zip(*region['polygon']); region['bbox']=[min(xs),min(ys),max(xs),max(ys)]
            for cell in region['attributes'].get('cells',[]):
                cell['polygon']=frame(cell['polygon']); xs,ys=zip(*cell['polygon']); cell['bbox']=[min(xs),min(ys),max(xs),max(ys)]
    source['expected_markdown']='\n\n'.join(r['text'] for r in source['regions'] if r['text'] is not None)
    present={r['label'] for r in source['regions']}
    source["ground_truth"]["absent_labels"] = sorted(LABELS-present)
    if "table" in present: source["ground_truth"]["tables"]={"status":"present","region_ids":[r['id'] for r in source['regions'] if r['label']=='table']}
    return source


def font(size, bold=False, serif=False):
    name = f"Liberation{'Serif' if serif else 'Sans'}-{'Bold' if bold else 'Regular'}.ttf"
    path = FONT_ROOT / name
    if not path.exists(): raise RuntimeError(f"Required reproducible font missing: {path}")
    return ImageFont.truetype(str(path), max(6,int(size)))


def layout_text(text, box, size, bold=False, serif=False):
    f=font(size,bold,serif); width=box[2]-box[0]-4; lines=[]
    for para in text.split('\n'):
        current=''
        for word in para.split():
            candidate=(current+' '+word).strip()
            if f.getlength(candidate)>width and current: lines.append(current); current=word
            else: current=candidate
        lines.append(current)
    max_lines=max(1,int((box[3]-box[1])/(size*1.25)))
    # Never silently drop authored prose: shrink until it fits.
    if len(lines)>max_lines and size>6: return layout_text(text,box,size-1,bold,serif)
    if len(lines)>max_lines: raise ValueError("Text cannot fit authored region")
    return f,lines,size


def prepare_reference(source):
    ref=copy.deepcopy(source)
    for r in ref['regions']:
        if r['text'] is not None:
            f,lines,size=layout_text(r['text'],r['bbox'],r['attributes'].get('font_size',15),r['label']=='title',source['source_family']=='academic')
            r['attributes']['render_font_size']=size
            r['attributes']['layout_bbox']=list(r['bbox'])
            painter=ImageDraw.Draw(Image.new('RGB',(1,1)))
            line_refs=[]
            for i,line in enumerate(lines):
                pos=(r['bbox'][0]+2,r['bbox'][1]+i*size*1.25)
                lb=list(painter.textbbox(pos,line,font=f))
                line_refs.append({'text':line,'baseline_y':pos[1]+f.getmetrics()[0],'bbox':lb})
            r['attributes']['lines']=line_refs
            if r['label']!='form' and not r['attributes'].get('border'):
                boxes=[line['bbox'] for line in line_refs if line['text']]
                r['bbox']=[min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)]
                r['polygon']=polygon(r['bbox'])
                r['attributes']['extent_policy']='union-of-rendered-glyph-bounds'
            else: r['attributes']['extent_policy']='authored-container-border'
    ref['image']={'width':source['width'],'height':source['height']}
    validate_reference(ref)
    return ref


def validate_reference(ref):
    if not ref.get('ground_truth') or 'prose_presence' not in ref['ground_truth']: raise ValueError('Missing explicit ground truth')
    w,h=ref['image']['width'],ref['image']['height']
    for r in ref['regions']:
        if r.get('label') not in LABELS or 'text' not in r or 'polygon' not in r or 'visibility' not in r: raise ValueError('Incomplete region label')
        x0,y0,x1,y1=r['bbox']
        if not (0<=x0<x1<=w+1e-5 and 0<=y0<y1<=h+1e-5): raise ValueError(f"Invalid box {r['id']} {r['bbox']}")
        if r['label']=='table' and not r['attributes'].get('cells'): raise ValueError('Missing table cell ground truth')


def paint_scene(draw,box,scene,rng):
    x0,y0,x1,y1=box; w=x1-x0; h=y1-y0
    draw.rectangle(box,fill='#b8d9e1')
    if scene=='coast':
        draw.rectangle((x0,y0+h*.52,x1,y1),fill='#537d87')
        draw.polygon([(x0,y1),(x0+w*.48,y0+h*.46),(x1,y0+h*.7),(x1,y1)],fill='#c5b89b')
        for _ in range(22):
            x=rng.uniform(x0,x1); y=rng.uniform(y0+h*.55,y1)
            draw.line((x,y,min(x1,x+w*.13),y),fill='#d7e9e9',width=2)
        draw.ellipse((x0+w*.12,y0+h*.1,x0+w*.22,y0+h*.1+w*.1),fill='#f4dfa4')
    elif scene=='city':
        for i in range(10):
            bx=x0+i*w/10; bh=rng.uniform(.25,.75)*h
            draw.rectangle((bx,y1-bh,bx+w*.09,y1),fill=rng.choice(['#596b71','#a17b62','#8a9397']))
            for yy in range(int(y1-bh+8),int(y1-6),15):
                for xx in range(int(bx+5),int(bx+w*.08),12): draw.rectangle((xx,yy,xx+4,yy+6),fill='#d9c99b')
    elif scene=='cafe':
        draw.rectangle((x0,y0+h*.55,x1,y1),fill='#8e6d54')
        for i in range(4): draw.line((x0,y0+h*(.58+i*.12),x1,y0+h*(.58+i*.12)),fill='#74533f',width=2)
        draw.ellipse((x0+w*.3,y0+h*.3,x0+w*.7,y0+h*.85),fill='#e5ddd0')
        draw.ellipse((x0+w*.36,y0+h*.36,x0+w*.64,y0+h*.65),fill='#60402b')
        draw.arc((x0+w*.60,y0+h*.4,x0+w*.81,y0+h*.69),-80,90,fill='#eee8da',width=max(2,int(w*.04)))
    else:
        draw.rectangle(box,fill='#d7ecb7')
        for i in range(7):
            cx=x0+(i+.5)*w/7; cy=y0+h*rng.uniform(.25,.65)
            draw.line((cx,y1,cx,cy),fill='#3e873f',width=4)
            for ang in range(0,360,60):
                ex=cx+math.cos(math.radians(ang))*w*.035; ey=cy+math.sin(math.radians(ang))*w*.035
                draw.ellipse((ex-7,ey-7,ex+7,ey+7),fill=['#efb73f','#d46c8e'][i%2])
            draw.ellipse((cx-5,cy-5,cx+5,cy+5),fill='#78583c')


def render(ref):
    rng=random.Random(ref['seed']); image=Image.new('RGB',(ref['width'],ref['height']),'#fffdf8'); d=ImageDraw.Draw(image)
    accent,hot,pale=ref['palette']
    for r in ref['regions']:
        b=r['bbox']; x0,y0,x1,y1=b; w=x1-x0; h=y1-y0; a=r['attributes']; label=r['label']
        if label in ('photo','illustration'):
            if a.get('photographic_asset'):
                asset=Image.open(ASSET_DIR/a['photographic_asset']['path']).convert('RGB')
                patch=ImageOps.fit(asset,(max(1,round(w)),max(1,round(h))),Image.Resampling.LANCZOS,centering=(rng.uniform(.25,.75),rng.uniform(.25,.75)))
                image.paste(patch,(round(x0),round(y0)))
            else: paint_scene(d,b,a.get('scene','garden'),rng)
        elif label=='table':
            for c in a['cells']:
                cb=c['bbox']
                if c['is_header']: d.rectangle(cb,fill=pale)
                elif c['row']%2==0 and a['border']: d.rectangle(cb,fill='#f1f2ef')
                if a['border']: d.rectangle(cb,outline='#878d90',width=1)
                f=font(min(14,max(7,(cb[3]-cb[1])*.36)))
                d.text((cb[0]+4,cb[1]+4),c['text'],font=f,fill='#24282b')
        elif label=='chart':
            d.rectangle(b,fill=pale)
            vals=a['values']; mx=max(vals); colors=[accent,hot,'#518b74','#b48a38','#8772a4']
            if a['kind']=='pie':
                angle=0
                for i,v in enumerate(vals):
                    end=angle+360*v/sum(vals); d.pieslice((x0+w*.22,y0+h*.12,x0+w*.78,y0+h*.83),angle,end,fill=colors[i%5]); angle=end
            else:
                d.line((x0+w*.13,y0+h*.1,x0+w*.13,y0+h*.83,x0+w*.95,y0+h*.83),fill='#535e62',width=2)
                points=[]
                for i,v in enumerate(vals):
                    x=x0+w*(.21+i*.69/len(vals)); y=y0+h*(.79-v/mx*.61)
                    if a['kind']=='bars': d.rectangle((x,y,x+w*.09,y0+h*.82),fill=colors[i%5])
                    points.append((x,y)); d.text((x,y0+h*.86),a['axis_labels'][i],font=font(max(7,w*.035)),fill='#273a40')
                if a['kind']=='line': d.line(points,fill=hot,width=4)
        elif label=='logo':
            d.rounded_rectangle(b,radius=min(w,h)*.15,fill=accent)
            d.ellipse((x0+w*.1,y0+h*.22,x0+w*.36,y0+h*.78),outline='#ffffff',width=2)
            d.text((x0+w*.4,y0+h*.31),a['brand'],font=font(max(6,min(15,w*.09)),True),fill='white')
        elif label=='mind_map':
            nodes=a['nodes']; centers=[(x0+w*.5,y0+h*.5)]+[(x0+w*(.5+.35*math.cos(i*2*math.pi/7)),y0+h*(.5+.39*math.sin(i*2*math.pi/7))) for i in range(7)]
            for i,j in a['edges']: d.line((*centers[i],*centers[j]),fill=accent,width=3)
            for i,(cx,cy) in enumerate(centers):
                nb=(cx-w*.12,cy-h*.045,cx+w*.12,cy+h*.045); d.rounded_rectangle(nb,radius=12,fill=hot if i==0 else pale,outline=accent,width=2)
                d.text((cx-w*.105,cy-h*.015),nodes[i],font=font(max(8,w*.018)),fill=accent)
        else:
            if label=='form':
                d.rectangle(b,outline='#858b8b',width=1); d.line((x0+12,y1-8,x1-12,y1-8),fill='#8a8f8f')
            elif a.get('border'): d.rectangle(b,outline='#858b8b')
            size=a['render_font_size']; f=font(size,label=='title',ref['source_family']=='academic')
            x0,y0,_,_=a['layout_bbox']
            for i,line in enumerate(a['lines']):
                d.text((x0+2,y0+i*size*1.25),line['text'],font=f,fill=accent if label=='title' or a.get('colorful') else '#292b2d')
    return image


def homography(src,dst):
    rows=[]; rhs=[]
    for (x,y),(u,v) in zip(src,dst):
        rows.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]); rhs.extend([u,v])
    return np.append(np.linalg.solve(np.asarray(rows),np.asarray(rhs)),1).reshape(3,3)


def mapped(poly,matrix):
    p=np.array([[x,y,1] for x,y in poly]) @ matrix.T
    return (p[:,:2]/p[:,2:]).tolist()


def transform(image, ref, mode):
    out=copy.deepcopy(ref); w,h=image.size; rng=random.Random(ref['seed']+9127)
    matrix=np.eye(3); occluder=None
    if mode in ('skew','rotate90','phone','phone_hand'):
        if mode=='rotate90':
            image=image.transpose(Image.Transpose.ROTATE_270); matrix=np.array([[0,-1,h],[1,0,0],[0,0,1.]])
        elif mode=='skew':
            angle=(-1 if rng.random()<.5 else 1)*rng.uniform(2,9); radians=math.radians(angle)
            # PIL inverse sampling, fixed canvas; foreground corners retain 8% margin.
            s=.82; c=math.cos(radians)*s; sn=math.sin(radians)*s
            matrix=np.array([[c,-sn,w/2-c*w/2+sn*h/2],[sn,c,h/2-sn*w/2-c*h/2],[0,0,1.]])
            inv=np.linalg.inv(matrix); image=image.transform((w,h),Image.Transform.AFFINE,tuple(inv[:2].flat),Image.Resampling.BICUBIC,fillcolor='#bcb7af')
        else:
            ow,oh=round(w*1.2),round(h*1.2)
            dst=[[w*.17,h*.12],[w*1.05,h*.18],[w*1.12,h*1.1],[w*.10,h*1.04]]
            matrix=homography(polygon([0,0,w,h]),dst); inv=np.linalg.inv(matrix); inv/=inv[2,2]
            # Deterministic wood/counter texture, not a stock photograph.
            yy,xx=np.indices((oh,ow)); noise=np.random.default_rng(ref['seed']).normal(0,3,(oh,ow))
            shade=(168+12*np.sin(yy/16)+noise).clip(0,255)
            bg=np.stack([shade,shade*.83,shade*.66],axis=-1).astype('uint8')
            canvas=Image.fromarray(bg)
            if ASSET_RECORDS:
                background=next((a for a in ASSET_RECORDS if 'coffee' in a['path']),ASSET_RECORDS[0])
                canvas=ImageOps.fit(Image.open(ASSET_DIR/background['path']).convert('RGB'),(ow,oh),Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(2))
                out['capture_background_asset']=background
            layer=image.convert('RGBA').transform((ow,oh),Image.Transform.PERSPECTIVE,tuple(inv.flat)[:8],Image.Resampling.BICUBIC)
            shadow=layer.getchannel('A').filter(ImageFilter.GaussianBlur(9)); canvas.paste('#493c2f',(0,0),shadow.point(lambda p:p//3)); canvas.paste(layer,mask=layer.getchannel('A')); image=canvas
            if mode=='phone_hand':
                draw=ImageDraw.Draw(image); occluder=[int(ow*.78),int(oh*.65),ow,int(oh*.95)]
                draw.ellipse(occluder,fill='#c89070',outline='#9d7057',width=2)
                for i in range(3):
                    x=int(ow*.81+i*ow*.035); draw.rounded_rectangle((x,int(oh*.58),x+int(ow*.04),int(oh*.83)),radius=ow*.02,fill='#d5a181')
                # The bbox conservatively includes all generated fingers.
                occluder=[int(ow*.78),int(oh*.58),ow,int(oh*.95)]
    elif mode=='scan':
        arr=np.asarray(image.convert('L')).astype(float); yy,xx=np.indices(arr.shape)
        arr*=.82+.18*xx/w; arr+=np.random.default_rng(ref['seed']).normal(0,5,arr.shape)
        image=Image.fromarray(arr.clip(0,255).astype('uint8')).convert('RGB').filter(ImageFilter.GaussianBlur(.45))
    elif mode=='blur': image=image.filter(ImageFilter.GaussianBlur(1.25))
    elif mode=='low_resolution': image=image.resize((w//2,h//2),Image.Resampling.LANCZOS); matrix=np.diag([image.width/w,image.height/h,1])
    elif mode!='clean': raise ValueError(mode)
    iw,ih=image.size
    for r in out['regions']:
        p=mapped(r['polygon'],matrix); r['polygon']=p
        xs,ys=zip(*p); b=[max(0,min(xs)),max(0,min(ys)),min(iw,max(xs)),min(ih,max(ys))]; r['bbox']=b
        if occluder:
            ox0,oy0,ox1,oy1=occluder; x0,y0,x1,y1=b
            intersection=max(0,min(x1,ox1)-max(x0,ox0))*max(0,min(y1,oy1)-max(y0,oy0))
            r['visibility']=round(max(0,1-intersection/((x1-x0)*(y1-y0))),4)
            r['attributes']['visibility_method']='conservative-occluder-bbox-overlap'
        for cell in r['attributes'].get('cells',[]):
            cp=mapped(cell['polygon'],matrix); cell['polygon']=cp; xs,ys=zip(*cp); cell['bbox']=[min(xs),min(ys),max(xs),max(ys)]
    out['image']={'width':iw,'height':ih}; out['width']=iw; out['height']=ih
    out['transform']={'mode':mode,'source_to_image_matrix':matrix.tolist(),'occluder_bbox':occluder,'occluder_label':'synthetic-hand' if occluder else None}
    validate_reference(out)
    return image,out


def contact_sheet(rows, root, name, limit=48):
    chosen=rows[:limit]; tw,th=160,224; cols=8
    sheet=Image.new('RGB',(cols*tw,math.ceil(len(chosen)/cols)*th),'#d9dddf'); draw=ImageDraw.Draw(sheet)
    for i,row in enumerate(chosen):
        img=Image.open(root/row['image_path']).convert('RGB'); img.thumbnail((tw-10,th-32)); x=i%cols*tw+5; y=i//cols*th+5
        sheet.paste(img,(x,y)); draw.text((x,y+th-27),row['id'][:25],font=font(10),fill='#14202a')
    sheet.save(root/name,quality=85)


def generate(root, count=256, seed=20261020, modes=('clean','scan','phone','phone_hand','skew','rotate90','blur','low_resolution')):
    if count<32: raise ValueError('At least 32 sources are required for paired document coverage')
    root=Path(root); root.mkdir(parents=True,exist_ok=True)
    rows=[]; source_rows=[]; integrity_cases=[]
    for i in range(count):
        source=build_source(i,seed); sid=source['id']; ref=prepare_reference(source)
        # Source layout and initial reference exist before any source rasterization.
        dump(root/'sources'/f'{sid}.json',source); dump(root/'references'/f'{sid}.json',ref)
        image=render(ref)
        source_rows.append({'id':sid,'source_family':source['source_family'],'split':source['split']})
        for mode in modes:
            transformed,tref=transform(image,ref,mode); rid=f'{sid}--{mode}'; tref['id']=rid
            refpath=f'references/{rid}.json'; imagepath=f'images/{rid}.jpg'
            dump(root/refpath,tref)  # Final coordinates persisted BEFORE final encoded raster.
            (root/'images').mkdir(exist_ok=True)
            quality=45 if mode=='low_resolution' else 72 if mode=='scan' else 88
            transformed.save(root/imagepath,quality=quality,optimize=True,subsampling=2)
            digest=hashlib.sha256((root/imagepath).read_bytes()).hexdigest()
            integrity_path=f'integrity-labels/{rid}.json'
            dump(root/integrity_path,{'labels':[{'name':'layout_regions','expected':[{'label':r['label'],'bbox':r['bbox'],'polygon':r['polygon']} for r in tref['regions']]}]})
            integrity_cases.append({'id':f'layout-case-{rid}','source':{'path':imagepath,'sha256':digest},'labels':{'path':integrity_path,'sha256':hashlib.sha256((root/integrity_path).read_bytes()).hexdigest()},'provenance':{'kind':'authored','author':'DocSlurp deterministic layout corpus generator','description':f'Programmatically authored geometry, seed {source["seed"]}; source-first layout, transformed by {mode}. OCR text is reference context; integrity answers are layout geometry.','createdAt':'2026-10-20T00:00:00Z'}})
            rows.append({'id':rid,'image_path':imagepath,'width':transformed.width,'height':transformed.height,'split':source['split'],'regions':tref['regions'],'metadata':{'source_family':source['source_family'],'template_family':source['template_family'],'difficulty':source['difficulty'],'capture_variant':mode,'source_id':sid,'source_path':f'sources/{sid}.json','reference_path':refpath,'document_id':source['document_id'],'page_number':source['page_number'],'transform':tref['transform'],'image_sha256':digest,'image_bytes':(root/imagepath).stat().st_size,'ground_truth':tref['ground_truth'],'limitations':source['limitations']}})
    with (root/'manifest.jsonl').open('w') as f:
        for row in rows: f.write(json.dumps(row,ensure_ascii=False)+'\n')
    coverage={'schema_version':VERSION,'seed':seed,'photographic_assets':ASSET_RECORDS,'asset_manifest_sha256':hashlib.sha256((ASSET_DIR/'asset-manifest.json').read_bytes()).hexdigest() if ASSET_DIR else None,'base_pages':count,'variants':len(rows),'families':dict(Counter(r['source_family'] for r in source_rows)),'split_base_pages':dict(Counter(r['split'] for r in source_rows)),'split_variants':dict(Counter(r['split'] for r in rows)),'labels':dict(Counter(r['label'] for row in rows for r in row['regions'])),'transforms':list(modes),'image_bytes':sum(r['metadata']['image_bytes'] for r in rows),'limitations':['Silver geometry is generated from authored sources, not independently human-corrected gold.','Phone/hand compositing remains synthetic; photographic inserts do not replace real-world held-out document scans.','Source/template-instance holdout includes all semantic families; procedural primitives are reused. It does not establish unseen-family or real-world transfer.','Visibility is conservative bbox overlap, not exact raster pixel mask.']}
    dump(root/'coverage.json',coverage)
    dump(root/'integrity-manifest.json',{'schema':'docslurp-authored-eval@v1','asset_manifest_sha256':coverage['asset_manifest_sha256'],'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'cases':integrity_cases})
    # A declared stratified benchmark slice: all families and transforms, picked by seed hash, never by detector success.
    selection=[]
    for family in FAMILIES:
      for split in ('train','dev','holdout'):
        candidates=sorted([r for r in rows if r['metadata']['source_family']==family and r['split']==split],key=lambda r:hashlib.sha256(r['id'].encode()).hexdigest())
        for mode in modes:
            matches=[r for r in candidates if r['metadata']['transform']['mode']==mode]
            selection.extend(matches[:2])
    with (root/'benchmark-slice.jsonl').open('w') as f:
        for row in selection: f.write(json.dumps(row,ensure_ascii=False)+'\n')
    dump(root/'selection-policy.json',{'method':'two source IDs per semantic family, split and transform, ascending SHA256(id), without detector outputs','rows':len(selection),'coverage_dimensions':['source_family','split','transform'],'holdout_policy':'never tune using holdout metrics; final evaluation once settings freeze'})
    dump(root/'manifest.json',{'schema_version':VERSION,'pages':[{k:v for k,v in row.items() if k!='regions'}|{'reference_path':row['metadata']['reference_path']} for row in rows]})
    clean=[r for r in rows if r['metadata']['transform']['mode']=='clean']
    for start in range(0,len(clean),48): contact_sheet(clean[start:start+48],root,f'contact-sources-{start//48+1:02d}.jpg')
    contact_sheet([r for r in rows if r['metadata']['transform']['mode']!='clean'][::max(1,(len(rows)-len(clean))//48)],root,'contact-transforms.jpg')
    (root/'README.md').write_text(f"# Synthetic layout corpus\n\n{count} authored base pages; {len(rows)} transformed image candidates.\n\nSources and references were written before rendering. Labels are source-derived silver, not human-reviewed gold. See coverage.json for caveats and family split. Table continuation IDs join paired pages. The synthetic artwork/hand scenes do not establish accuracy on real photographs.\n\nReproduce with: python scripts/layout-eval/corpus.py --output <directory> --count {count} --seed {seed}\n")
    return coverage


def load_assets(directory):
    global ASSET_RECORDS, ASSET_DIR
    ASSET_DIR=Path(directory)
    payload=json.loads((ASSET_DIR/'asset-manifest.json').read_text())
    entries=payload if isinstance(payload,list) else payload['assets']
    ASSET_RECORDS=[]
    for entry in entries:
        if not all(entry.get(k) for k in ('path','author','license','source_url')): raise ValueError('Missing photographic asset provenance')
        path=(ASSET_DIR/entry['path']).resolve()
        if not path.is_relative_to(ASSET_DIR.resolve()): raise ValueError('Asset path outside asset directory')
        with Image.open(path) as image: image.verify()
        record=dict(entry); record['sha256']=hashlib.sha256(path.read_bytes()).hexdigest(); ASSET_RECORDS.append(record)


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--output',type=Path,required=True); parser.add_argument('--asset-dir',type=Path); parser.add_argument('--count',type=int,default=256); parser.add_argument('--seed',type=int,default=20261020); parser.add_argument('--modes',default='clean,scan,phone,phone_hand,skew,rotate90,blur,low_resolution')
    args=parser.parse_args()
    if args.asset_dir: load_assets(args.asset_dir)
    print(json.dumps(generate(args.output,args.count,args.seed,tuple(args.modes.split(','))),indent=2))


if __name__=='__main__': main()
