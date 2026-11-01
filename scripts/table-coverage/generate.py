"""Create original, deterministic CC0 table layouts and gold before PDF extraction.
Requires PyMuPDF. Usage: python generate.py /external/dataset/path
No benchmark content or customer documents are read.
"""
import json, random, sys, hashlib
from pathlib import Path
from datetime import datetime, timezone
import fitz
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
rng=random.Random(731905)
cases=[]
for category in ['simple','colspan','rowspan','multi-header','multipage','scan','rotated','borderless','financial']:
 for variant in range(2):
  ident=f'{category}-{variant+1}';gold=[];layout=[]
  pages=2 if category=='multipage' else 1
  for page in range(pages):
   occupied=set()
   for row in range(1,7):
    for col in range(1,4):
     if (row,col) in occupied:continue
     rs=2 if category=='rowspan' and row==2 and col==1 else 1
     cs=2 if category in ['colspan','multi-header'] and row==1 and col==1 else 1
     text=(f'Group {col}' if row==1 else f'Metric {col}') if category=='multi-header' and row<=2 else f'Label {col}' if row==1 else str(rng.randint(100,9999))
     if category=='financial' and row>1: text=f'({rng.randint(100,999):,}.00)' if col==3 else f'{rng.randint(1000,9999):,}.25'
     cell={'table':page+1,'row':row,'column':col,'rowspan':rs,'colspan':cs,'value':text};gold.append(cell)
     layout.append({**cell,'page':page,'rect':[48+(col-1)*150,100+(row-1)*38,48+(col-1+cs)*150,100+(row-1+rs)*38]})
     for r in range(row,row+rs):
      for c in range(col,col+cs):occupied.add((r,c))
  (out/f'{ident}.gold.json').write_text(json.dumps(gold,indent=2))
  (out/f'{ident}.layout.json').write_text(json.dumps(layout,indent=2))
  doc=fitz.open()
  for page in range(pages):
   p=doc.new_page(width=595,height=842)
   p.insert_text((48,60),'Measurement register',fontsize=18)
   for cell in [c for c in layout if c['page']==page]:
    rect=fitz.Rect(cell['rect'])
    if category!='borderless':p.draw_rect(rect,color=(0,0,0),width=.7)
    p.insert_text((rect.x0+8,rect.y0+24),cell['value'],fontsize=10)
   if category=='rotated':p.set_rotation(90)
  if category=='scan':
   raster=fitz.open()
   for p in doc:
    pix=p.get_pixmap(dpi=150);q=raster.new_page(width=p.rect.width,height=p.rect.height);q.insert_image(q.rect,stream=pix.tobytes('png'))
   doc.close();doc=raster
  doc.save(out/f'{ident}.pdf');doc.close()
  cases.append({'id':ident,'category':category,'input':f'{ident}.pdf','gold':f'{ident}.gold.json','sourceLayout':f'{ident}.layout.json','sha256':hashlib.sha256((out/f'{ident}.pdf').read_bytes()).hexdigest(),'outputs':{}})
(out/'manifest.json').write_text(json.dumps({'createdAt':datetime.now(timezone.utc).isoformat(),'author':'DocSlurp authored fixture generator','license':'CC0-1.0','candidate':'docslurp','providers':['docslurp','llamaparse','unstructured-v2'],'requiredCategories':['simple','colspan','rowspan','multi-header','multipage','scan','rotated','borderless','financial'],'cases':cases},indent=2))
print(f'Wrote {len(cases)} original cases to {out}')
