"""Deliberately authored cultural and natural-history pilot compositions."""
from pathlib import Path
try:
 from .page import Page
except ImportError:
 from page import Page

ASSETS=Path('/home/dan/data/docslurp-evals/layout-synthetic-v2/assets')


def exhibition():
 p=Page('south-room-wind-and-colour',1200,1600,paper='#f5f0e5')
 p.source['provenance']['design_inspiration']=[{'url':'https://www.nga.gov/exhibitions/jmw-turner-0','observed':'2026-10-20','used_for':'Chronological exhibition interpretation, collection credits and visitor information; no copied layout or prose.'},{'url':'https://www.metmuseum.org/art/collection/search/436535','used_for':'Verified CC0 artwork and factual object credit.'}]
 p.rectangle([0,0,1200,130],'#244c52')
 p.text('SOUTH ROOM',50,33,750,58,'narrow-bold','#fcf7e9',label='header')
 p.text('COLLECTION STUDIES  /  04',825,73,320,15,'mono','#d8e3d8',label='header')
 p.text('Wind & colour',46,164,1110,104,'serif','#24434a',label='title')
 p.text('Looking at a landscape that refuses to stand still',51,293,1080,29,'serif-italic','#6b746b',label='paragraph')
 p.image(ASSETS/'met-wheat-field-cypresses.jpg',[50,365,1150,1138],label='illustration',reproduction='Centre-fitted reproduction in the declared frame; no text labels embedded in artwork.',asset={'license':'CC0','source_url':'https://www.metmuseum.org/art/collection/search/436535'})
 p.text('Vincent van Gogh  /  Wheat Field with Cypresses  /  1889',52,1160,1080,18,'sans-bold','#304e51',label='caption')
 p.text('Oil on canvas. The Metropolitan Museum of Art, Purchase, The Annenberg Foundation Gift, 1993. 1993.132. Open Access / CC0.',52,1190,1080,15,'sans','#68726a',leading=20,label='caption')
 p.text('A moving surface',50,1254,640,31,'serif-bold','#24434a',label='title')
 p.text('Start with the sky, then follow the direction of the wheat. The marks do not simply describe objects: they make the whole surface feel restless. The dark trees hold the scene together while pale clouds seem to roll beyond its edges.',52,1304,646,23,'serif','#303d3b',leading=29)
 p.line([753,1254,753,1499],'#aeb4a3',1)
 p.text('LOOKING ROUTE',786,1258,355,17,'sans-bold','#a55337',label='title')
 p.text('01  Sky: broad turns\n02  Hills: repeated curves\n03  Wheat: short broken strokes\n04  Trees: an upright anchor',786,1305,355,18,'sans','#3b514e',leading=30,label='list')
 p.text('Allow five minutes. Compare the painted movements with the stillness of your own viewpoint.',786,1436,355,17,'serif-italic','#637269',leading=22)
 p.line([50,1532,1150,1532],'#244c52',2)
 p.text('SOUTH ROOM / AN AUTHORED EXHIBITION LEAFLET · NOT A REAL EXHIBITION',52,1551,1040,13,'mono','#5a6c66',label='footer')
 p.text('07',1100,1545,50,24,'serif','#244c52',label='footer')
 return p


def fern_archive():
 p=Page('living-archive-fern-study',1600,1120,paper='#f1eadb')
 p.source['provenance']['design_inspiration']=[{'url':'https://www.biodiversitylibrary.org/page/51651662','used_for':'Public-domain historical plate and close visual reading; new interpretive prose.'},{'url':'https://www.biodiversitylibrary.org/item/210854','used_for':'Bibliographic provenance, institutional credit and explicit public-domain status.'}]
 p.rectangle([0,0,1600,15],'#53624b')
 p.text('THE LIVING ARCHIVE',45,41,800,33,'narrow-bold','#3e4d38',label='header')
 p.text('NATURAL HISTORY / PLATE STUDIES',1090,53,450,16,'mono','#65715b',label='header')
 p.line([45,99,1550,99],'#7d896f',1)
 p.text('A forest in miniature',43,127,960,66,'serif','#35462f',label='title')
 p.text('How to look closely at a nineteenth-century fern illustration',48,216,1300,24,'serif-italic','#6b715d',label='paragraph')
 p.image(ASSETS/'bhl-fern-plate.webp',[505,284,950,1034],label='illustration',asset={'license':'Public domain','source_url':'https://www.biodiversitylibrary.org/page/51651662'},extent='Complete historical plate with printed historical caption; embedded text excluded from native prose scoring.')
 p.text('01 / BEGIN WITH THE OUTLINE',48,298,405,16,'sans-bold','#a65e39',label='title')
 p.text('Before tracing individual divisions, let your eye follow the entire specimen. The winding stem makes a loose S across the sheet. Its repeated branches make a rhythm that is easier to see from a little distance.',48,343,395,23,'serif','#3e4737',leading=29)
 p.text('02 / CHANGE YOUR SCALE',48,560,405,16,'sans-bold','#a65e39',label='title')
 p.text('Now move closer. Each small branch repeats part of the larger pattern, but the divisions are not identical. Some are crowded together; others leave enough paper between them to make their edges clear.',48,605,395,23,'serif','#3e4737',leading=29)
 p.line([445,449,546,449],'#a65e39',2)
 p.ellipse([542,445,550,453],'#a65e39')
 p.line([446,716,625,716],'#a65e39',2)
 p.ellipse([621,712,629,720],'#a65e39')
 p.text('Draw what changes.',48,854,400,34,'serif-italic','#52664b',label='title')
 p.text('Try a thirty-second outline, then spend two minutes on one branch. Put both sketches beside one another. What did the slower drawing reveal?',48,912,395,20,'sans','#5d6751',leading=26)
 p.rectangle([1000,285,1550,507],'#dce0ca')
 p.text('A PLATE IS AN ARGUMENT',1024,305,495,18,'sans-bold','#425537',label='title')
 p.text('The illustrator chooses what to separate, enlarge and simplify. A printed specimen can be exceptionally precise while still being a carefully arranged interpretation of a living plant.',1024,352,495,23,'serif','#3f5038',leading=29)
 p.text('Reading the evidence',1000,555,540,34,'serif-bold','#405237',label='title')
 p.text('The fine ink lines preserve branching and edge detail. They do not record the colour, thickness or translucency of the fresh plant. The aged paper and small surface marks belong to the surviving book, not to the fern.',1000,614,540,23,'serif','#3e4939',leading=29)
 p.text('ARCHIVE NOTE',1000,818,530,16,'sans-bold','#a65e39',label='title')
 p.text('Reproduction from The ferns of South Africa (1892), plate V. Digitised by the New York Botanical Garden library; made available through the Biodiversity Heritage Library. Public domain.',1000,859,540,18,'sans','#59634f',leading=24,label='caption')
 p.text('The historical species caption remains part of the reproduced image. No modern identification is implied by this exercise.',1000,971,540,16,'serif-italic','#6c735d',leading=21,label='caption')
 p.line([45,1064,1550,1064],'#7d896f',1)
 p.text('LEARNING SHEET 08 / ORIGINAL INTERPRETIVE TEXT · HISTORICAL PUBLIC-DOMAIN IMAGE',48,1083,1420,13,'mono','#68765b',label='footer')
 return p


def concert():
 p=Page('riverside-hall-evening-songs',1150,1600,paper='#f8f6ec')
 p.source['provenance']['design_inspiration']=[{'url':'https://media.wigmore-hall.org.uk/documents/Programme_9_March_2026_100pm.pdf','observed':'2026-10-20','used_for':'Programme hierarchy: artist roles, work/movement listings, concise venue notices. All names, works and prose here are authored and fictional.'}]
 p.rectangle([0,0,26,1600],'#832c45')
 p.text('RIVERSIDE\nHALL',62,39,690,65,'narrow-bold','#782d43',leading=58,label='header')
 p.text('THURSDAY 16 APRIL\n19:30 / RECITAL ROOM',807,62,290,18,'sans-bold','#4b4c42',leading=27,label='header')
 p.line([64,189,1090,189],'#832c45',3)
 p.text('When the light\nbegins to change',58,228,1055,78,'serif','#353c35',leading=78,label='title')
 p.text('SONGS FOR A SMALL ROOM',64,411,1000,20,'sans-bold','#832c45',label='caption')
 p.text('Mara Bell, mezzo-soprano\nÉtienne Morel, piano',63,466,1000,31,'serif-italic','#4f594b',leading=40,label='paragraph')
 p.text('TONIGHT’S PROGRAMME',65,587,665,18,'sans-bold','#832c45',label='title')
 programme=[('LENA ASH (b. 1982)','Three window songs (2019)','I. The room • II. Rain at noon • III. Still warm'),('ÉMILE VAUTRIN (1874–1938)','Deux jardins (1912)','Le mur • Après la pluie'),('NOOR SALIM (b. 1976)','Letters from the harbour (2024)','I. Departure • II. A blue envelope • III. Home')]
 y=635
 for name,work,movements in programme:
  p.text(name,65,y,665,19,'sans-bold','#3b473a',label='title')
  p.text(work,65,y+33,665,27,'serif','#373f36',label='paragraph')
  p.text(movements,66,y+75,665,19,'serif-italic','#67705e',leading=24,label='list')
  y+=141
 p.text('No interval · approximately 65 minutes',65,1082,665,20,'sans-bold','#832c45',label='caption')
 p.line([759,588,759,1131],'#c2c3b2',1)
 p.text('LISTENING NOTE',792,590,290,16,'sans-bold','#832c45',label='title')
 p.text('These songs begin indoors and gradually open onto the street, a garden and the sea. Listen for the moments when the piano carries a thought that the singer has left unfinished.',791,632,300,22,'serif','#4d5847',leading=28)
 p.text('Please keep the quiet',791,889,300,25,'serif-italic','#832c45',label='title')
 p.text('Phones on silent. Photography and recording are not permitted during the performance. Latecomers will be seated at a suitable pause.',792,970,300,18,'sans','#626b59',leading=25)
 p.line([64,1160,1090,1160],'#a8ae99',1)
 p.text('SONG TEXT / TEXTE CHANTÉ',65,1186,995,16,'sans-bold','#832c45',label='title')
 p.text('Après la pluie',65,1235,465,29,'serif-italic','#3b4939',label='title')
 p.text('Le jardin garde un peu de jour.\nUne fenêtre attend le vent.\nJe laisse la porte entrouverte\npour le retour du printemps.',65,1285,465,23,'serif','#4b5845',leading=32,label='paragraph',language='fr')
 p.text('After the rain',605,1235,480,29,'serif-italic','#3b4939',label='title')
 p.text('The garden keeps a little daylight.\nA window waits to feel the wind.\nI leave the door a little open\nfor spring to find its way back in.',605,1285,480,23,'serif','#4b5845',leading=32,label='paragraph',language='en',translation_of='Après la pluie')
 p.text('Original fictional song text and translation for this synthetic programme.',65,1432,1025,15,'sans','#7a806f',label='caption')
 p.rectangle([64,1490,1090,1492],'#832c45')
 p.text('RIVERSIDE FRIENDS',65,1514,440,25,'narrow-bold','#832c45',label=None)
 p.region('logo',[64,1508,505,1554],None,origin='authored-typographic-sponsor-mark')
 p.text('Thank you for helping small concerts happen.\nProgramme £2 / All events and artists on this sheet are fictional.',568,1515,520,15,'sans','#67735c',leading=22,label='footer')
 return p


def build():
 return [exhibition(),fern_archive(),concert()]
