"""Two deliberately authored food-editorial review pages; no family expansion."""
import argparse
from pathlib import Path
from .page import Page,save_json,sha


def paired_item(page,marker,copy,x,y,body_x,width,marker_size,body_size,color,ink,leading,role):
 # Both differently styled pieces form one semantic list item. Keep every
 # measured glyph line, rather than using the surrounding layout slot as truth.
 page.text(marker,x,y+1,body_x-x-15,marker_size,'mono',color,label='list')
 end=page.text(copy,body_x,y,width,body_size,'serif',ink,leading=leading,label='paragraph')
 body=page.source['regions'].pop();number=page.source['regions'].pop()
 lines=number['attributes']['line_boxes']+body['attributes']['line_boxes']
 box=[min(b[0] for b in lines),min(b[1] for b in lines),max(b[2] for b in lines),max(b[3] for b in lines)]
 page.region('list',box,marker+' '+copy,line_boxes=lines,extent_policy='exact-rendered-glyph-union',editorial_role=role,granularity='one-authored-list-item')
 return end


def recipe_feature(assets):
 p=Page('food-feature-one-tray',1200,1700,paper='#fbf7ee',document_id='supper-journal-food-feature')
 green='#284339';ink='#252924';red='#a3412d'
 p.text('SUPPER JOURNAL   /   THE SEASONAL KITCHEN',64,33,880,18,'sans-bold',green,label='header')
 p.text('OCTOBER 2026',976,34,180,16,'mono',green,label='header')
 p.line([64,76,1136,76],green,2)
 p.text('One tray. A good evening.',60,104,1080,76,'book-bold',ink,label='title')
 p.text('Roast the tomatoes until they slump. Let the chickpeas catch\ntheir sweet, sharp juices. Supper can be this simple.',65,218,885,26,'serif-italic',ink,leading=33)
 p.text('15 MIN PREP\n35 MIN OVEN',983,223,165,16,'mono',green,leading=27)
 p.image(assets/'food-roasted-tray-v1.png',[64,315,1136,900],asset={'kind':'built-in-imagegen-editorial-asset'})
 p.text('A hot metal tray gives the chickpeas crisp edges; the tomato juices become the dressing.',64,914,1060,17,'serif-italic',green,label='caption')
 p.line([64,962,1136,962],green,1)
 p.text('ROAST TOMATOES\n& CHICKPEAS',64,988,320,25,'sans-bold',green,leading=31,label='title')
 p.text('Serves 4 with bread',64,1061,300,21,'serif-italic',ink)
 p.text('800 g ripe cherry tomatoes\n2 × 400 g tins chickpeas, drained\n4 tbsp extra-virgin olive oil\n4 garlic cloves, lightly crushed\n1 tsp smoked paprika\n½ tsp flaky salt, plus extra\n1 lemon, zest and juice\n20 g parsley, roughly chopped',64,1110,307,21,'serif',ink,leading=31,label='list',editorial_role='ingredient-list')
 p.image(assets/'food-tomato-preparation-v1.png',[64,1382,374,1589],asset={'kind':'built-in-imagegen-editorial-asset'})
 p.text('Wash, then dry the tomatoes well.\nExcess water delays the roasting.',64,1601,316,16,'serif-italic',green,leading=20,label='caption')
 p.line([408,994,408,1639],'#b4b5a5',1)
 p.text('Good food, without the choreography',451,993,685,32,'serif-bold',ink,label='title')
 y=p.text('This is the sort of supper that leaves room for conversation. Use tomatoes of mixed sizes if you have them; the smaller ones collapse into a sauce while the larger fruit keeps its shape.',451,1048,685,23,'serif',ink,leading=29)
 steps=[('01','Heat the oven to 220°C / 200°C fan. Put a large metal roasting tray inside while it heats. Pat the drained chickpeas dry with a clean tea towel.'),('02','Toss the tomatoes and chickpeas with the oil, garlic, paprika and salt. Tip onto the hot tray and spread into one layer. Roast for 30–35 minutes, turning once.'),('03','When the skins blister and the chickpeas begin to crisp, remove the tray. Squeeze over half the lemon and stir gently through the warm juices.'),('04','Finish with parsley and lemon zest. Taste before adding more salt or lemon. Serve straight from the tray with torn sourdough and a crisp green salad.')]
 y+=20
 for number,copy in steps:
  y=paired_item(p,number,copy,451,y,512,624,21,22,red,ink,28,'method-step')+20
 p.line([451,y+3,1136,y+3],green,1)
 p.text('THE NEXT DAY',451,y+18,685,16,'sans-bold',red,label='title')
 p.text('Spoon leftovers onto toast, or fold through warm couscous. Keep chilled and use within two days.',451,y+48,685,21,'serif-italic',ink,leading=27)
 p.text('FOOD & HOME',64,1660,400,14,'sans-bold',green,label='footer')
 p.text('42',1095,1655,40,24,'book',green,label='footer')
 p.source['editorial_brief']='Coherent home-cooking recipe feature: dominant food photograph, Bookman headline, Roman body, ingredient rail and sequential method.'
 return p


def tasting_story(assets):
 p=Page('food-tasting-counter',1200,1700,paper='#f5f0e5',document_id='supper-journal-counter-story')
 dark='#24342c';orange='#af472d';ink='#2b2c28'
 p.rectangle([0,0,1200,86],dark)
 p.text('AT THE COUNTER',58,26,790,31,'narrow-bold','#fbf5e9',label='header')
 p.text('THE NEIGHBOURHOOD ISSUE   /   07',802,37,350,16,'sans','#fbf5e9',label='header')
 p.text('A small menu,\na long evening',58,113,694,83,'serif',dark,leading=84,label='title')
 p.text('Inside an imagined twelve-seat supper room,\nthe best course is the one nobody rushes.',64,310,660,27,'serif-italic',orange,leading=34,editorial_role='standfirst')
 p.image(assets/'food-plated-dish-v1.png',[778,122,1140,516],asset={'kind':'built-in-imagegen-editorial-asset'})
 p.text('Roast tomatoes, chickpeas and parsley:\na generous plate for the middle of the table.',778,532,362,17,'serif-italic',dark,leading=22,label='caption')
 p.text('WORDS BY ELENA MARCH  •  FOOD NOTES BY TOM REED',64,412,690,15,'sans-bold',dark,editorial_role='fictional-byline')
 p.text('At seven, the first bowl arrives without ceremony: warm white beans, rosemary oil and a spoon for each guest. The room is small enough that the cook can hear the conversation. Nothing on this fictional menu is designed to interrupt it.',64,460,646,25,'serif',ink,leading=32)
 p.line([64,633,1140,633],dark,2)
 p.text('THE EVENING MENU',64,662,1010,31,'narrow-bold',dark,label='title')
 p.text('A five-course seasonal supper · £48 per person · bread included',64,707,1040,20,'serif-italic',orange)
 p.table([64,754,1140,1114],['COURSE','ON THE PLATE','IN THE KITCHEN','IN THE GLASS'],[
  ['01 / TO BEGIN','White beans; rosemary oil','Beans soaked overnight','Dry apple cordial'],
  ['02 / FIRST PLATE','Beetroot; labneh; dill','Beetroot roasted in salt','Pear & ginger shrub'],
  ['03 / THE CENTRE','Tomatoes; chickpeas; parsley','Hot tray, 35 minutes','Light red, served cool'],
  ['04 / A LITTLE CHEESE','Young goat cheese; walnuts','Cheese at room temperature','Pressed apple juice'],
  ['05 / SOMETHING SWEET','Baked plums; oat crumble','Fruit baked before service','Lemon verbena tea'],
 ],widths=[.15,.31,.29,.25],row_height=52,size=17,face='sans',header_fill='#d8e0d5',ink=dark)
 y=1117
 p.text('Why the middle matters',64,y,508,31,'serif-bold',dark,label='title')
 p.text('The tomato plate is the hinge of the meal. It is warm rather than piping hot, full of juices rather than arranged into neat towers. A single dish travels down the counter, and everybody takes a little more than they intended.',64,y+51,500,23,'serif',ink,leading=29)
 p.text('That generosity shapes the cooking. There is no last-minute sauce to split and no garnish that wilts while the room waits. The oven does the hard work; the cook has time to notice an empty water glass.',64,y+229,500,23,'serif',ink,leading=29)
 p.line([606,1124,606,1586],'#b2b7aa',1)
 p.text('A cook’s margin notes',651,y,486,31,'serif-bold',dark,label='title')
 notes=[('16:00','Drain the chickpeas. Wash herbs and spin completely dry.'),('18:15','Set the table. Bring the cheese out of the fridge.'),('19:05','Heat the roasting tray; slice the bread while the oven rises.'),('19:40','Finish the tomatoes with lemon. Taste the juices, not just the fruit.')]
 yy=y+55
 for time,copy in notes:
  yy=paired_item(p,time,copy,651,yy,752,386,17,21,orange,ink,27,'prep-timeline-item')+20
 p.line([64,1610,1140,1610],dark,1)
 p.text('This is an authored editorial scenario, not a restaurant listing. Menu and names are fictional.',64,1629,1040,16,'serif-italic',dark,label='caption')
 p.text('SUPPER JOURNAL / TABLE TALK',64,1665,850,14,'sans-bold',dark,label='footer')
 p.text('43',1096,1659,40,24,'serif',dark,label='footer')
 p.source['editorial_brief']='Dense food magazine counter story with oversized Roman headline, narrow masthead, inset portrait crop, structured tasting menu, prose column and timed preparation notes.'
 return p


def build(asset_dir=None):
 assets=Path(asset_dir or '/home/dan/data/docslurp-evals/layout-synthetic-v2/assets')
 pages=[recipe_feature(assets),tasting_story(assets)]
 decorate(pages)
 return pages


def decorate(pages):
 import json
 for page in pages:
  page.source['pilot_review']={'status':'awaiting-user-visual-review','not_benchmark_admitted':True,'asset_scope':'AI-generated photorealistic editorial assets, not documentary photographs.'}
  for region in page.source['regions']:
   if region['label']=='photo':
    asset=region['attributes']['asset'];provenance=Path(asset['path']+'.provenance.json')
    asset['provenance_path']=str(provenance);asset['generation_provenance']=json.loads(provenance.read_text())
 return pages


def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True);parser.add_argument('--assets',type=Path)
 parser.add_argument('--page',choices=['recipe','tasting','both'],default='both');args=parser.parse_args();assets=args.assets or args.root/'assets'
 pages=[]
 if args.page in ('recipe','both'):pages.append(recipe_feature(assets))
 if args.page in ('tasting','both'):pages.append(tasting_story(assets))
 rows=[page.finalize(args.root) for page in decorate(pages)]
 save_json(args.root/'lifestyle-pilot-review.json',{'schema':'layout-v2-editorial-review@v1','pages':rows,'authoring_source_sha256':sha(__file__),'status':'visual-review-only-no-benchmark-admission','count':len(rows)})
 print('\n'.join(str(args.root/row['image_path']) for row in rows))


if __name__=='__main__':main()
