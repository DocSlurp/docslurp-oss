"""Individually authored elementary science editorial pilot; no count expansion."""
from pathlib import Path
from .page import Page


def water_cycle(root):
 root=Path(root);p=Page('water-cycle-field-notebook',1200,1600,paper='#fff9e9')
 ink='#173e50';teal='#008b91';orange='#de623e'
 p.rectangle([0,0,1200,25],teal)
 p.text('EARTH EXPLORERS  /  CHAPTER 4',58,53,900,19,'sans-bold',teal,label='header')
 p.text('A raindrop’s\nround trip',55,100,810,66,'book-bold',ink,leading=65,label='title')
 p.ellipse([1010,67,1138,195],'#ffe49b')
 p.text('LOOK\nCLOSER',1030,97,110,22,'sans-bold',ink,leading=25,label='title')
 p.text('The water in your glass may once have been a snowflake. Follow one drop from the ocean to the mountains—and back again.',58,245,1080,25,'serif',ink,leading=30)
 p.image(root/'assets/water-cycle-landscape.png',[48,331,1152,1067],label='illustration',role='continuous-water-cycle-cutaway',internal_labels='source-authored figure labels, not separate layout regions')
 # Figure-internal callouts are source text, kept inside the illustration target.
 for n,text,x,y,w in [('1','Sun warms the sea',88,572,265),('2','Clouds gather',470,386,245),('3','Rain and snow fall',817,435,270),('4','Rivers return water',702,801,300)]:
  p.rectangle([x-8,y-8,x+w,y+35],'#fff9e9',outline='#173e50',width=2)
  p.text(n+'  '+text,x,y,w,20,'sans-bold',ink,label=None,figure_internal=True)
 p.text('Not to scale. Water also travels underground through spaces between rocks.',57,1082,1090,17,'sans',ink,label='caption')
 p.text('ONE DROP, MANY PLACES',58,1145,560,23,'sans-bold',teal,label='title')
 p.text('Evaporation happens when liquid water becomes an invisible gas called water vapour. Cooling vapour forms tiny droplets in clouds: this is condensation. When droplets grow heavy enough, they fall as precipitation.',58,1190,614,22,'serif',ink,leading=28)
 p.rectangle([718,1143,1145,1451],'#e0f0e8')
 p.text('TRY IT: A CLOUD IN A JAR',742,1165,380,21,'sans-bold',teal,label='title')
 p.text('Ask an adult to help. Put warm water in a clear jar. Rest a cold metal lid on top. Watch for tiny drops beneath the lid. Where did the drops come from?',742,1208,370,21,'serif',ink,leading=27)
 p.text('Talk together',58,1386,590,23,'book-bold',orange,label='title')
 p.text('Why does a puddle disappear after a sunny day? Draw arrows to show where its water might go next.',58,1423,614,21,'serif',ink,leading=27)
 p.line([58,1510,1142,1510],teal,2)
 p.text('WORDS TO KNOW: evaporation • condensation • precipitation',58,1526,990,17,'sans-bold',ink,label='footer')
 p.text('47',1090,1526,55,21,'book-bold',ink,label='footer')
 return p

def build(root):
 return [water_cycle(root)]

if __name__=='__main__':
 import argparse,json
 a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args()
 print(json.dumps(water_cycle(args.output).finalize(args.output)))
