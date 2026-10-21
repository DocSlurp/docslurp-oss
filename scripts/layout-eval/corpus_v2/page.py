"""Source-first editorial page composition. No procedural family-count expansion."""
import hashlib
import json
import math
import os
import uuid
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

FONT_FILES={
 'serif':'/usr/share/fonts/gsfonts/NimbusRoman-Regular.otf',
 'serif-bold':'/usr/share/fonts/gsfonts/NimbusRoman-Bold.otf',
 'serif-italic':'/usr/share/fonts/gsfonts/NimbusRoman-Italic.otf',
 'sans':'/usr/share/fonts/gsfonts/NimbusSans-Regular.otf',
 'sans-bold':'/usr/share/fonts/gsfonts/NimbusSans-Bold.otf',
 'narrow':'/usr/share/fonts/gsfonts/NimbusSansNarrow-Regular.otf',
 'narrow-bold':'/usr/share/fonts/gsfonts/NimbusSansNarrow-Bold.otf',
 'book':'/usr/share/fonts/gsfonts/URWBookman-Light.otf',
 'book-bold':'/usr/share/fonts/gsfonts/URWBookman-Demi.otf',
 'mono':'/usr/share/fonts/gsfonts/NimbusMonoPS-Regular.otf',
}


def poly(b):return [[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]]
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write_atomic(path,data):
 path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_name('.'+path.name+'.writing-'+uuid.uuid4().hex)
 try:temporary.write_bytes(data);os.replace(temporary,path)
 finally:temporary.unlink(missing_ok=True)
def save_json(path,value):write_atomic(path,(json.dumps(value,indent=2,ensure_ascii=False)+'\n').encode())


class Page:
 def __init__(self,id,width,height,paper='#fffdf7',document_id=None,page_number=1):
  self.id,self.width,self.height=id,width,height
  self.source={'schema':'layout-editorial-pilot-source-v2','id':id,'width':width,'height':height,'paper':paper,'document_id':document_id or id,'page_number':page_number,'commands':[],'regions':[],'text_blocks':[],'review_status':'pilot-awaiting-visual-review','provenance':{'kind':'deliberately-authored-editorial-composition','not_a_real_publication':True,'geometry':'source commands and tightly measured glyph boxes persisted before rasterization'},'limitations':['Authored synthetic editorial content. Visual pilot only; not admitted benchmark gold.']}
  self.measure=ImageDraw.Draw(Image.new('RGB',(1,1)))
 def font(self,face,size):return ImageFont.truetype(FONT_FILES[face],round(size))
 def region(self,label,box,text=None,**attrs):
  if len(box)!=4 or not all(math.isfinite(v) for v in box) or not (0<=box[0]<box[2]<=self.width and 0<=box[1]<box[3]<=self.height):raise ValueError(f'Invalid authored region geometry: {label} {box}')
  r={'id':f'r{len(self.source["regions"]):03d}','label':label,'bbox':list(box),'polygon':poly(box),'text':text,'visibility':1.0,'reading_order':None,'attributes':attrs}
  self.source['regions'].append(r);return r
 def rectangle(self,b,fill,outline=None,width=1):self.source['commands'].append({'op':'rect','bbox':list(b),'fill':fill,'outline':outline,'width':width})
 def line(self,xy,fill='#30302b',width=1):self.source['commands'].append({'op':'line','xy':list(xy),'fill':fill,'width':width})
 def ellipse(self,b,fill,outline=None,width=1):self.source['commands'].append({'op':'ellipse','bbox':list(b),'fill':fill,'outline':outline,'width':width})
 def wrap_lines(self,text,width,size,face):
  f=self.font(face,size);lines=[]
  for paragraph in text.split('\n'):
   current=''
   for word in paragraph.split():
    if f.getlength(word)>width:
     if current:lines.append(current);current=''
     while f.getlength(word)>width:
      count=1
      while count<len(word) and f.getlength(word[:count+1])<=width:count+=1
      if f.getlength(word[:count])>width:raise ValueError('Text column narrower than one glyph')
      preferred=[i+1 for i,char in enumerate(word[:count]) if char in '@./-_:' and i+1>=count/2]
      cut=preferred[-1] if preferred else count
      lines.append(word[:cut]);word=word[cut:]
     current=word
    else:
     attempt=(current+' '+word).strip()
     if f.getlength(attempt)>width and current:lines.append(current);current=word
     else:current=attempt
   lines.append(current)
  return lines
 def text(self,text,x,y,width,size=20,face='serif',color='#242522',leading=None,label='paragraph',tracking=0,**attrs):
  f=self.font(face,size);leading=leading or size*1.2;lines=self.wrap_lines(text,width,size,face)
  line_boxes=[];block_id=f't{len(self.source["text_blocks"]):03d}';command_start=len(self.source['commands'])
  for i,line in enumerate(lines):
   pos=[x,y+i*leading];b=list(self.measure.textbbox(pos,line,font=f));line_boxes.append(b)
   self.source['commands'].append({'op':'text','text':line,'position':pos,'face':face,'size':size,'fill':color,'text_block_id':block_id})
  boxes=[b for b in line_boxes if b[0]<b[2] and b[1]<b[3]]
  if not boxes:return y+leading*len(lines)
  b=[min(z[0] for z in boxes),min(z[1] for z in boxes),max(z[2] for z in boxes),max(z[3] for z in boxes)]
  if b[2]>self.width or b[3]>self.height or b[0]<0 or b[1]<0:raise ValueError(f'Text outside page: {text[:40]} {b}')
  self.source['text_blocks'].append({'id':block_id,'text':text,'bbox':b,'line_texts':lines,'line_boxes':line_boxes,'requested_layout_label':label,'command_start':command_start,'command_end':len(self.source['commands']),'font':face,'font_size':size})
  if label:self.region(label,b,text,font=face,font_size=size,line_boxes=line_boxes,extent_policy='exact-rendered-glyph-union',**attrs)
  return y+leading*len(lines)
 def image(self,path,b,label='photo',asset=None,**attrs):
  path=Path(path);Image.open(path).verify()
  self.source['commands'].append({'op':'image','path':str(path.resolve()),'bbox':list(b)})
  provenance={}
  for candidate in (Path(str(path)+'.provenance.json'),path.with_suffix('.provenance.json')):
   if candidate.exists():provenance={'generation_provenance':json.loads(candidate.read_text()),'generation_provenance_sha256':sha(candidate)};break
  self.region(label,b,None,asset={**(asset or {}),**provenance,'path':str(path.resolve()),'sha256':sha(path)},**attrs)
 def table(self,b,headers,rows,widths=None,row_height=35,border=False,continuation_id=None,row_offset=0,face='sans',size=17,header_fill='#dbe5df',ink='#263b35'):
  x0,y0,x1,y1=b;cols=len(headers);widths=widths or [1/cols]*cols
  if len(widths)!=cols or abs(sum(widths)-1)>1e-8:raise ValueError('Invalid table widths')
  cells=[]
  for ri,row in enumerate([headers]+rows):
   if len(row)!=cols:raise ValueError('Missing authored table cells')
   y=y0+ri*row_height;x=x0
   if ri==0:self.rectangle([x0,y,x1,y+row_height],header_fill)
   elif ri%2==0:self.rectangle([x0,y,x1,y+row_height],'#eff2eb')
   for ci,value in enumerate(row):
    cb=[x,y,x+(x1-x0)*widths[ci],y+row_height]
    self.text(str(value),x+7,y+7,cb[2]-x-14,size,face+'-bold' if ri==0 and face=='sans' else face,ink,label=None)
    if border:self.rectangle(cb,None,outline='#a4aea7')
    cells.append({'row':ri,'column':ci,'logical_row':0 if ri==0 else row_offset+ri,'text':str(value),'bbox':cb,'polygon':poly(cb),'is_header':ri==0});x=cb[2]
   self.line([x0,y+row_height,x1,y+row_height],'#b9c4bb',1)
  actual=[x0,y0,x1,y0+(len(rows)+1)*row_height]
  if actual[3]>y1:raise ValueError('Authored table overflow')
  return self.region('table',actual,None,cells=cells,columns=cols,rows=len(rows)+1,border=border,continuation_id=continuation_id,header_repeated=bool(continuation_id))
 def chart(self,b,kind,data,labels,title=None,colors=('#d45d3f','#759c9a','#264c59')):
  x0,y0,x1,y1=b;w=x1-x0;h=y1-y0
  self.rectangle(b,'#f0eee5')
  if title:self.text(title,x0+16,y0+10,w-32,18,'sans-bold',label=None)
  left,top=x0+70,y0+50;right,bottom=x1-20,y1-38
  if kind=='horizontal-bars':
   rh=(bottom-top)/len(data)
   for i,value in enumerate(data):
    yy=top+i*rh
    self.text(labels[i],x0+12,yy+7,80,14,'sans',label=None)
    self.rectangle([left+25,yy+6,left+25+(right-left-55)*value/max(data),yy+rh-6],colors[i%len(colors)])
    self.text(str(value),right-25,yy+7,35,14,'mono',label=None)
  elif kind=='line':
   for i in range(5):
    yy=top+(bottom-top)*i/4;self.line([left,yy,right,yy],'#c5cdc4',1)
    self.text(str(round(max(data)*(1-i/4))),x0+17,yy-6,45,13,'mono',label=None)
   points=[]
   for i,value in enumerate(data):
    xx=left+(right-left)*i/(len(data)-1);yy=bottom-(bottom-top)*value/max(data);points.extend([xx,yy]);self.ellipse([xx-4,yy-4,xx+4,yy+4],colors[0])
    self.text(labels[i],xx-18,bottom+9,50,13,'sans',label=None)
   self.line(points,colors[0],4)
  else:raise ValueError(kind)
  return self.region('chart',b,None,chart_kind=kind,data=data,axis_labels=labels,heading=title)
 def finalize(self,root):
  root=Path(root);fonts={c['face'] for c in self.source['commands'] if c['op']=='text'}
  self.source['font_provenance']={key:{'path':FONT_FILES[key],'sha256':sha(FONT_FILES[key])} for key in fonts}
  source=root/'sources'/f'{self.id}.json';reference=root/'references'/f'{self.id}.json'
  labels=('paragraph','title','list','table','chart','photo','logo','formula','caption','header','footer','form','mind_map','illustration','figure','footnote','code','seal','number','formula_number','unknown')
  composite={'table','chart','illustration','mind_map','logo','figure','form'}
  regions=self.source['regions']
  for index,r in enumerate(regions):r['id']=f'r{index:03d}'
  for block in self.source['text_blocks']:
   a=block['bbox'];candidates=[]
   for r in regions:
    b=r['bbox']
    if block['requested_layout_label'] is None and r['label'] not in composite:continue
    if a[0]>=b[0]-.01 and a[1]>=b[1]-.01 and a[2]<=b[2]+.01 and a[3]<=b[3]+.01:candidates.append(r)
   if not candidates:raise ValueError(f'Authored text block has no layout/composite label: {block["text"][:70]}')
   parent=min(candidates,key=lambda r:(r['bbox'][2]-r['bbox'][0])*(r['bbox'][3]-r['bbox'][1]))
   block['parent_region_id']=parent['id'];block['annotation_role']='internal-component-text-not-separate-layout-region' if block['requested_layout_label'] is None else 'authored-layout-prose'
  markdown=[];contracts=[]
  for r in regions:
   children=[b for b in self.source['text_blocks'] if b['parent_region_id']==r['id']]
   content=r['text'] or '\n'.join(b['text'] for b in children)
   cell_text=[cell['text'] for cell in r['attributes'].get('cells',[])]
   r['attributes']['prose_contract']={'scope':'authored-native-text-only; embedded AI-photo text is not annotated or eligible for prose evaluation','presence':'present' if content or cell_text else 'absent','text_block_ids':[b['id'] for b in children]}
   if r['label']=='table':
    cells=r['attributes'].get('cells')
    if not cells:raise ValueError('Table missing explicit cell ground truth')
    row_ids=sorted({c['row'] for c in cells});lines=[]
    for index,ri in enumerate(row_ids):
     vals=[str(c['text']).replace('|','\\|') for c in sorted((c for c in cells if c['row']==ri),key=lambda c:c['column'])]
     lines.append('| '+' | '.join(vals)+' |')
     if index==0:lines.append('| '+' | '.join('---' for _ in vals)+' |')
    markdown.append('\n'.join(lines))
   elif r['label']=='formula':
    expression=next((r['attributes'][key] for key in ('latex','source_expression','expected_math','expression') if r['attributes'].get(key)),r['text'])
    if not expression:raise ValueError('Formula missing explicit source expression')
    r['attributes']['source_math_expression']=expression;markdown.append('$$\n'+expression+'\n$$')
   elif content:markdown.append(('# ' if r['label']=='title' else '')+content)
   contracts.append({'region_id':r['id'],'label':r['label'],'prose_presence':r['attributes']['prose_contract']['presence'],'source_text':content,'text_block_ids':[b['id'] for b in children],'table_cells_applicability':'present' if r['label']=='table' else 'not_applicable','math_applicability':'present' if r['label']=='formula' else 'not_applicable'})
  ground={'status':'authored-source-derived-silver-awaiting-review','prose_presence':'present' if self.source['text_blocks'] else 'absent','reading_order':'not_validated-do-not-score','paragraph_boundaries':'explicit-authored-region-and-text-block-IDs','line_boundaries':'exact-line-texts-and-glyph-boxes','tables':'present' if any(r['label']=='table' for r in regions) else 'not_applicable','math':'present' if any(r['label']=='formula' for r in regions) else 'not_applicable','absent_layout_labels':sorted(set(labels)-{r['label'] for r in regions}),'embedded_asset_text':'not_annotated-not-eligible-for-prose-evaluation'}
  granularity={'policy':'Authored paragraph/list/title/caption blocks are layout regions. Text drawn inside a chart, table, logo or diagram with label=None is retained as component text inside its enclosing composite region, never separately scored as a paragraph.','internal_text_parent_rule':'smallest containing declared composite region; missing parent fails builder','regions':contracts,'text_blocks':self.source['text_blocks']}
  expected=root/'expected'/f'{self.id}.md';expected.parent.mkdir(exist_ok=True);write_atomic(expected,('\n\n'.join(markdown)+'\n').encode())
  contract=root/'contracts'/f'{self.id}.json';save_json(contract,{'schema':'layout-editorial-prose-contract-v2','ground_truth':ground,'annotation_granularity':granularity})
  self.source['ground_truth']=ground;self.source['expected_markdown']={'path':str(expected.relative_to(root)),'sha256':sha(expected)};self.source['prose_contract']={'path':str(contract.relative_to(root)),'sha256':sha(contract)}
  save_json(source,self.source)
  save_json(reference,{'schema':'layout-editorial-pilot-reference-v2','id':self.id,'image':{'width':self.width,'height':self.height},'regions':regions,'ground_truth':ground,'source_sha256':sha(source),'expected_markdown':self.source['expected_markdown'],'prose_contract':self.source['prose_contract']})
  image=Image.new('RGB',(self.width,self.height),self.source['paper']);d=ImageDraw.Draw(image)
  for c in self.source['commands']:
   if c['op']=='text':d.text(c['position'],c['text'],font=self.font(c['face'],c['size']),fill=c['fill'])
   elif c['op']=='rect':d.rectangle(c['bbox'],fill=c['fill'],outline=c['outline'],width=c['width'])
   elif c['op']=='line':d.line(c['xy'],fill=c['fill'],width=c['width'])
   elif c['op']=='ellipse':d.ellipse(c['bbox'],fill=c['fill'],outline=c['outline'],width=c['width'])
   elif c['op']=='image':
    b=c['bbox'];picture=ImageOps.fit(Image.open(c['path']).convert('RGB'),(round(b[2]-b[0]),round(b[3]-b[1])),Image.Resampling.LANCZOS);image.paste(picture,(round(b[0]),round(b[1])))
  path=root/'images'/f'{self.id}.png';path.parent.mkdir(exist_ok=True);temporary=path.with_name('.'+path.stem+'.render-'+uuid.uuid4().hex+'.png')
  try:image.save(temporary,format='PNG',optimize=True);os.replace(temporary,path)
  finally:temporary.unlink(missing_ok=True)
  return {'id':self.id,'image_path':str(path.relative_to(root)),'width':self.width,'height':self.height,'split':'pilot-review','regions':self.source['regions'],'metadata':{'source_path':str(source.relative_to(root)),'reference_path':str(reference.relative_to(root)),'source_id':self.id,'source_family':self.id,'document_id':self.source['document_id'],'page_number':self.source['page_number'],'image_sha256':sha(path),'source_sha256':sha(source),'expected_markdown':self.source['expected_markdown'],'prose_contract':self.source['prose_contract'],'review_status':'awaiting-visual-review-not-benchmark-admitted'}}
