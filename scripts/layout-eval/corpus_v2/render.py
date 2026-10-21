#!/usr/bin/env python3
"""Render reviewed-composition pilots only, never automatic population expansion."""
import argparse,json,sys
from pathlib import Path
from PIL import Image,ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from corpus_v2 import editorial,business,lifestyle,educational,scientific,culture,instruments,chinese_menu

def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--editorial-only',action='store_true');args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
 pages=editorial.build()
 if not args.editorial_only:pages+=business.build()+lifestyle.build()+scientific.build()+culture.build()+educational.build(args.output)+instruments.build()+chinese_menu.build()
 rows=[page.finalize(args.output) for page in pages]
 with (args.output/'pilot-manifest.jsonl').open('w') as f:
  for row in rows:f.write(json.dumps(row,ensure_ascii=False)+'\n')
 cols=4;tw,th=330,520;sheet=Image.new('RGB',(cols*tw,((len(rows)+cols-1)//cols)*th),'#d9dfda');d=ImageDraw.Draw(sheet)
 for index,row in enumerate(rows):
  im=Image.open(args.output/row['image_path']);im.thumbnail((tw-20,th-55));x=index%cols*tw+10;y=index//cols*th+10;sheet.paste(im,(x,y));d.text((x,y+th-35),row['id'],fill='#20352d')
 sheet.save(args.output/('editorial-pilot-contact.jpg' if args.editorial_only else 'pilot-contact-sheet.jpg'),quality=92)
 print(json.dumps({'pilots':len(rows),'review_status':'awaiting-visual-review-not-benchmark-admitted','ids':[r['id'] for r in rows]},indent=2))
if __name__=='__main__':main()
