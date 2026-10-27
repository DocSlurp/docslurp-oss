"""Training-only visual checkpoint. Never sample heldout inputs during tuning."""
import argparse
from pathlib import Path
from datetime import datetime,timezone
import fitz
from PIL import Image,ImageDraw,ImageFont
p=argparse.ArgumentParser();p.add_argument("--dataset",type=Path,required=True);a=p.parse_args()
out=a.dataset/"previews";out.mkdir(exist_ok=True)
samples=[(0,0,0,"Native text + technical section"),(6,0,1,"Columns + discussed screenshot"),(12,0,3,"Outlined text + text-free picture"),(0,80,0,"80% hard-page document"),(10,20,1,"80% region-raster mix"),(17,100,3,"100% hard-page document")]
canvas=Image.new("RGB",(1260,1230),"#ededed");draw=ImageDraw.Draw(canvas);font=ImageFont.load_default(size=16)
for i,(family,hard,page,label) in enumerate(samples):
    path=a.dataset/"inputs/train"/f"mixed-source-{family:04d}-hard-{hard:03d}.pdf"
    doc=fitz.open(path);pix=doc[page].get_pixmap(dpi=95,alpha=False)
    image=Image.frombytes("RGB",(pix.width,pix.height),pix.samples);image.thumbnail((400,525))
    x=(i%3)*420;y=(i//3)*600
    canvas.paste(image,(x+10,y+55));draw.text((x+10,y+5),label,font=font,fill="black")
    draw.text((x+10,y+28),f"family {family} / hard {hard}% / p{page+1}",font=font,fill="black");doc.close()
draw.text((10,1204),f"Training only | rendered {datetime.now(timezone.utc).isoformat()}",font=font,fill="black")
canvas.save(out/"training-contact-sheet.png")
doc=fitz.open(a.dataset/"inputs/train/mixed-source-0006-hard-000.pdf")
doc[1].get_pixmap(dpi=150,clip=fitz.Rect(25,105,590,710),alpha=False).save(out/"columns-and-screenshot-closeup.png")
