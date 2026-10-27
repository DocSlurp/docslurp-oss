"""Individually art-directed editorial pilots; no template-jitter expansion."""
from pathlib import Path
try:from .page import Page,poly
except ImportError:from page import Page,poly

ASSETS=Path('/home/dan/data/docslurp-evals/layout-synthetic-v2/assets')


def bicycle_ad():
 p=Page('rove-long-way-home-ad',1500,1000,paper='#ebe4d5')
 p.image(ASSETS/'bicycle-commuter-hero.png',[0,0,1500,1000],extent='full-bleed-advertising-photograph',composition='Text and wordmark overlay the photograph; opaque footer clips its visible extent.')
 image=p.source['regions'][-1];image['bbox']=[0,0,1500,870];image['polygon']=poly(image['bbox']);image['visibility']=.87
 p.text('ROVE',65,44,340,67,'narrow-bold','#f4ebd6',label=None)
 p.line([72,115,275,115],'#e3bd77',3);p.region('logo',[65,44,300,122],None,brand='ROVE',origin='authored-vector-wordmark')
 p.text('CITY BICYCLES / EVERYDAY EXPLORATION',69,135,600,15,'mono','#f4ebd6',label='caption')
 p.text('The long\nway home.',63,244,650,132,'serif','#fff8e9',leading=126,label='title')
 p.text('A quieter ride. A better kind of rush.',72,563,510,26,'sans-bold','#f7eddb',label='title')
 p.text('Take the river road. Stop for the good bread.\nWith a smooth steel frame and an enclosed\neight-speed hub, the city is yours again.',72,612,505,23,'sans','#f7eddb',leading=30)
 p.rectangle([0,870,1500,1000],'#e9e0cd')
 p.text('THE DAILY 08',70,897,350,27,'narrow-bold','#24372f',label='title')
 p.text('Chromoly steel  /  All-weather brakes\nIntegrated lights  /  Lifetime frame care',70,936,550,17,'sans','#304137',leading=23,label='list')
 p.line([680,897,680,971],'#8e998b',1)
 p.text('From $890',726,900,315,31,'serif-italic','#24372f',label='title')
 p.text('Find your local ride at rove.example',726,947,560,19,'sans','#304137',label='paragraph')
 p.text('MADE FOR THE WAY YOU LIVE.',1160,908,280,17,'narrow-bold','#334439',label='caption')
 p.text('Advertisement · fictional brand',1160,950,280,12,'sans','#596556',label='footer')
 return p


def investigation():
 p=Page('public-ledger-empty-block',1100,1540,paper='#f6f3ea')
 p.text('THE PUBLIC LEDGER',55,30,1000,55,'serif-bold','#202d32',label='header')
 p.text('INDEPENDENT CITY REPORTING',58,92,600,14,'mono','#5b6461',label='caption')
 p.text('ISSUE 18  /  MARCH 2026',780,93,280,13,'mono','#5b6461',label='header')
 p.line([55,125,1045,125],'#1e363d',3)
 p.text('SPECIAL REPORT  /  THE LOCAL ECONOMY',57,150,950,16,'sans-bold','#b44934',label='caption')
 p.text('The quiet cost\nof an empty block',52,188,1000,79,'serif-bold','#1c3038',leading=78,label='title')
 p.text('A promised shopping street has been waiting five years.\nOur review follows the public money — and the places it never reached.',57,369,990,25,'serif-italic','#445452',leading=31)
 p.text('BY MAYA REED  ·  DATA BY ELLIS TRAN  ·  9 MIN READ',58,458,980,14,'mono','#65716b',label='caption')
 p.line([55,495,1045,495],'#b5bcb3')
 body1='On a wet Tuesday morning, the lights are on in only three of the fourteen storefronts along Calder Street. A locksmith sets out his sign. Next door, paper has covered the same windows since the winter roadworks began.'
 body2='The council described the renewal fund as a bridge between construction and a new trading season. Yet the documents tell a slower story: money assigned to fit-outs was held back while landlords and contractors argued over the condition of the buildings.'
 body3='We compared the approved budget with invoices, meeting minutes and the latest spending return. The largest proportional gap sits in the smallest grants. Independent businesses received less than half of the support originally set aside for them.'
 y=p.text(body1,58,522,468,20,'serif',leading=25);y=p.text(body2,58,y+18,468,20,'serif',leading=25);p.text(body3,58,y+18,468,20,'serif',leading=25)
 p.rectangle([565,523,1045,805],'#193b45')
 p.text('$3.8m',590,543,430,86,'serif','#f8ecce',label='title')
 p.text('approved for the district\n$2.3m recorded as spent',592,650,415,26,'sans','#f8ecce',leading=33)
 p.text('“An allocation is not the same\nas a repaired shopfront.”',588,746,425,19,'serif-italic','#bfd2cb',leading=24,label='caption')
 p.text('THE GAP, BY PROGRAM',568,842,460,19,'sans-bold','#213b41',label='title')
 p.chart([565,885,1045,1135],'horizontal-bars',[92,63,45,29],['Roads','Lighting','Fit-outs','Grants'],title='Share of approved funds spent (%)')
 p.text('The missing middle',57,1108,480,30,'serif-bold','#253a3c',label='title')
 p.text('A year of invoices shows contractors moving ahead while small grants remain in review. The fund closes in September; unspent allocations may return to the central budget.',58,1154,470,20,'serif',leading=25)
 p.table([565,1170,1045,1390],['Program','Budget','Spent','Gap'],[['Streets','$1.2m','$1.1m','$0.1m'],['Lighting','$0.8m','$0.5m','$0.3m'],['Fit-outs','$1.1m','$0.5m','$0.6m'],['Grants','$0.7m','$0.2m','$0.5m']],widths=[.36,.21,.21,.22],row_height=36,border=False,size=16)
 p.text('METHOD / Amounts rounded. Spending returns through 31 January; approved budgets exclude later variations. All figures and names are authored for this synthetic editorial pilot.',58,1417,985,13,'sans','#65716b',leading=18,label='caption')
 p.line([55,1500,1045,1500],'#8b9891')
 p.text('THE PUBLIC LEDGER  ·  ILLUSTRATIVE EDITION',58,1510,850,12,'mono','#55645e',label='footer');p.text('06',1010,1508,35,17,'serif-bold','#253b3a',label='footer')
 return p


FIELD_ROWS=[
 ['B01','North jetty','06:10','12.4','18','0.32'],['B02','Old slipway','06:35','12.7','22','0.28'],['B03','Tidal creek','07:05','13.1','34','0.41'],['B04','Marsh gate','07:30','13.6','29','0.48'],['B05','Rail bridge','08:00','14.0','41','0.56'],['B06','Stone steps','08:25','14.2','37','0.52'],['B07','Willow bend','09:00','14.8','48','0.63'],['B08','East meadow','09:25','15.2','53','0.71'],['B09','Pump house','10:00','15.6','44','0.68'],['B10','Mill pond','10:30','16.1','61','0.76'],['B11','Upper ford','11:05','16.4','59','0.81'],['B12','School reach','11:40','16.8','66','0.88'],['B13','Footbridge','12:15','17.0','64','0.85'],['B14','River mouth','12:50','17.3','71','0.93'],['B15','South bank','13:30','17.5','68','0.90'],['B16','Sand bar','14:05','17.8','74','1.02'],['B17','Salt gate','14:40','18.0','79','1.08'],['B18','Reed island','15:20','17.7','73','0.99'],['B19','Outer wall','16:00','17.2','67','0.92'],['B20','Lifeboat pier','16:35','16.8','58','0.82']]


def field_reports():
 pages=[]
 for number,rows in [(1,FIELD_ROWS[:10]),(2,FIELD_ROWS[10:])]:
  p=Page(f'estuary-field-notes-{number:02d}',1000,1414,paper='#fbfaf5',document_id='estuary-spring-transect',page_number=number)
  p.rectangle([0,0,34,1414],'#385a53');p.text('ESTUARY OBSERVATORY',70,42,830,24,'sans-bold','#365a53',label='header')
  p.text('FIELD NOTE 27  /  WATER QUALITY  /  SPRING TRANSECT',71,86,850,12,'mono','#6d7970',label='caption')
  p.line([70,117,940,117],'#83988b')
  p.text('Following the tide' if number==1 else 'A changing afternoon',66,150,880,61,'book-bold','#2b4841',label='title')
  p.text('A day of measurements along the Calder estuary' if number==1 else 'Transect observations · table continued',71,236,865,23,'serif-italic','#667166',label='caption')
  if number==1:
   p.text('The team walked a twenty-stop route from the north jetty to the lifeboat pier, sampling at roughly half-hour intervals as the incoming tide reached the reed beds. This note records the raw observations, including the warm shallow sites that are easily lost in a daily average.',71,294,850,22,'serif',leading=28)
   p.chart([70,440,940,665],'line',[12.4,13.6,14.8,16.1,17.0,18.0,16.8],['B01','B04','B07','B10','B13','B17','B20'],title='Water temperature (°C), selected stations',colors=('#ab593e','#759c9a','#264c59'))
   y=715
  else:
   p.text('The afternoon stations were warmer, but the final three readings declined as deeper tidal water arrived. Turbidity and temperature both peaked near the salt gate. This single transect cannot distinguish the effects of tide, shallow water and sediment disturbance.',71,294,850,22,'serif',leading=28)
   p.rectangle([70,440,940,575],'#e5ecdf');p.text('READ THE DISTRIBUTION',90,456,800,15,'sans-bold','#3c5e4e',label='title');p.text('First route stops 12.4–16.1°C  ·  Later-route stops 16.4–18.0°C\nDo not interpret these route observations as a continuous time series at one station.',90,495,800,19,'sans','#3f574b',leading=25)
   y=628
  p.text('TABLE 2  /  RAW STATION OBSERVATIONS'+(' — CONTINUED' if number==2 else ''),71,y,850,15,'sans-bold','#33564a',label='caption')
  p.table([70,y+40,940,y+550],['ID','Station','Time','°C','NTU','Depth m'],rows,widths=[.075,.32,.14,.13,.13,.205],row_height=37,border=number==1,continuation_id='calder-transect-table-2',row_offset=0 if number==1 else 10,size=18,header_fill='#d7e3d2')
  p.text('Protocol: grab sample at 20cm below the surface; handheld probe equilibrated for 60 seconds. NTU values are optical turbidity readings. Depth is the local water column at the sampling point.',72,y+466,855,16,'serif',leading=21,label='caption')
  if number==2:
   p.text('What to check next',70,1160,850,26,'book-bold','#3a5b4c',label='title')
   p.text('Repeat B06–B10 on a falling tide. Recheck the salt-gate sensor against the reference standard. Preserve the full station record before comparing route-level summaries.',72,1204,850,20,'serif',leading=26)
  p.line([70,1345,940,1345],'#9aab9a');p.text(f'CALDER ESTUARY / SOURCE-AUTHORED SYNTHETIC FIELD NOTE                                      {number:02d}',71,1360,865,12,'mono','#60745e',label='footer')
  pages.append(p)
 return pages


def classified():
 p=Page('northside-exchange-classifieds',1350,1900,paper='#ece8dc')
 p.text('THE NORTHSIDE EXCHANGE',38,27,1280,75,'serif-bold','#242622',label='header')
 p.line([39,119,1310,119],'#282b24',4)
 p.text('SATURDAY, 14 MARCH 2026  ·  VOL 42 / No. 11',42,134,850,15,'mono','#44473e',label='caption')
 p.text('THE LOCAL PAPER WITH ROOM FOR EVERYONE',845,134,470,15,'narrow-bold','#34392e',label='caption')
 p.text('SMALL ADS. BIG POSSIBILITIES.',40,175,1280,46,'narrow-bold','#222a23',label='title')
 p.text('Homes, help, second chances and the odd very good bicycle. Place your notice by Wednesday at noon: notices@northside.example',43,231,1255,19,'serif-italic','#424c3e')
 categories=[
 ('HOMES & ROOMS',[
 ('ROOM BY THE PARK','Sunny upstairs room in a quiet shared house. Furnished, own desk, garden access. Fifteen minutes to the station on foot. £620 monthly including bills. Viewings Sunday after 2; ask for Elena, 555-0142.'),
 ('WORKSHOP TO LET','Dry 32m² workshop behind the old dairy. Power, sink and wide double doors; suitable for repairs or small-scale making. No overnight use. Flexible six-month lease. Contact the caretaker at 555-0186.'),
 ('LOOKING FOR A HOME','Retired library worker and one elderly cat seek a ground-floor flat near a bus route. Excellent references; can care for a small garden. Budget £850. Please leave a message for Moira on 555-0171.'),
 ('FLAT SWAP','Two-bedroom top-floor flat near the river available for a summer exchange, 3–24 August. Looking for somewhere near the coast. Two adults, no smoking. Write to exchange@northside.example with dates.'),
 ('GARDEN STUDIO','Light studio with north-facing windows. Shared kettle, secure bicycle storage and access until 9pm. One desk available from April. Visit the open evening on Tuesday, Unit 6, Foundry Court.'),
 ('NEIGHBOUR NEEDED','Small housing co-op has one family-sized home becoming available. Shared maintenance days and community meals are part of the arrangement. Information meeting at the hall, Thursday 6:30pm. All welcome.')]),
 ('WORK & SKILLS',[
 ('BAKER, EARLY SHIFT','Independent bakery seeks an experienced pair of hands for Tuesday–Saturday mornings. Dough mixing, shaping and a little counter work. Paid trial, proper breaks, no split shifts. Call Ruth before noon: 555-0117.'),
 ('MENDING DONE WELL','Zips, hems, school uniforms and favourite coats repaired. Bring the garment so we can agree the work and price. Collection Fridays; urgent jobs considered. The Blue Door, 17 Market Lane, 10am–4pm.'),
 ('BOOKKEEPING HELP','Clear records for sole traders and small clubs. Monthly reconciliations, invoice chasing and a patient explanation of the numbers. First meeting without charge. References available. Helen, 555-0108.'),
 ('APPRENTICE JOINER','Learn bench skills in a small restoration workshop. Reliability and curiosity matter more than experience. Four days on site, one college day. Applications with a short letter by 27 March: jobs@cedar.example.'),
 ('LOCAL TRANSLATION','French and Spanish letters, menus and visitor material translated with care. Printed and accessible digital formats available. Please allow five working days; ask about community-group rates. Amira, 555-0125.'),
 ('COMPUTER CLINIC','Slow laptop? Bring it to the library desk Saturday 10–1. Volunteer help with updates, backups and everyday questions. We explain each step and never keep your passwords. Booking recommended at the front desk.')]),
 ('MARKETPLACE',[
 ('SOLID OAK TABLE','Round dining table, 110cm across, with a folding leaf and four chairs. Honest wear, no loose joints. £145 for the set; bring two people to collect. Near the swimming baths. Text photographs requested to 555-0163.'),
 ('CAMERA FOR SALE','35mm camera with 50mm lens, leather case and instruction book. Meter checked last month; shutter sounds even at every speed. £85, inspection welcome at the Saturday market. Look for the green camera stall.'),
 ('FREE TO A MAKER','Offcuts of ash, beech and birch plywood. Mostly short lengths, dry and clean, useful for boxes or small repairs. Bring a bag and take only what you need. Workshop yard open 9–11 Saturday; no delivery.'),
 ('RECORDS, NOT RARITIES','A well-loved collection of jazz, folk and early soul records. Covers worn, discs played carefully. From £2 each. Browse at 8 Willow Street on Sunday, 11–3. Proceeds support the school music cupboard.'),
 ('OLD SEWING MACHINE','Hand-cranked machine in a wooden case. Straight stitch only, runs smoothly and comes with three spare bobbins. A good machine for learning repairs. £40 or swap for a small workbench. Call Jess, 555-0138.'),
 ('SECOND-HAND BOOKS','History, gardening and a surprising number of railway timetables. The Friends of the Library sale is Friday 4–7 and Saturday 10–2. Cash or card. Donations accepted at the side entrance until Thursday.')]),
 ('MUSIC & LEARNING',[
 ('PIANO LESSONS','Patient lessons for adults returning to music, as well as complete beginners. Borrow a keyboard while deciding whether to continue. Daytime appointments near the health centre. Ring Lin on 555-0159 for a chat.'),
 ('CHOIR, NO AUDITION','Sing on Wednesday evenings in the old school hall. We learn by ear and from scores; you do not need to read music. First two sessions free. Arrive at 7:15 for tea and a seat. Bass voices especially welcome.'),
 ('FIX YOUR BICYCLE','A practical class covering punctures, brake adjustment and keeping a chain happy. Bring your own bicycle if possible. Six places, Saturday 21 March, 10–12. £12 including materials. Book with the repair café.'),
 ('READING TOGETHER','Friendly one-to-one reading practice for adults. Confidential, free and arranged around your hours. Sessions take place in a quiet room at the library. Ask for the learning coordinator or call 555-0194.'),
 ('DRAW THE TOWN','Sketch walks start at the fountain on the first Sunday of each month. We stop often and compare notes over coffee. Bring any paper and a pencil; no special equipment or ability needed. Rain does not cancel us.'),
 ('SPANISH CONVERSATION','An informal lunchtime table for intermediate speakers. We talk about the week, share useful phrases and occasionally get the grammar right. Thursdays at the café upstairs, 12:30–1:30. Buy your own lunch.')]),
 ('CARS & BICYCLES',[
 ('TOURING BICYCLE','Steel touring frame, 54cm, mudguards and rear rack. New tyres, brake cables and bar tape; gears set up last week. Ready for the long way home. £210. Test ride with identification, evenings after 6. Sam, 555-0112.'),
 ('GARAGE SPACE','Secure single garage near West Road available for storage from April. Dry roof, no electricity. Vehicle or household storage only; not a workshop. £85 per month, one-month deposit. Enquiries to 555-0180.'),
 ('CAR SHARE SOUGHT','Travelling to the hospital campus Monday, Tuesday and Friday, arriving around 8:15. Happy to share driving or fuel costs. Starting near the post office. Contact Priya at rides@northside.example.'),
 ('TRAILER TO BORROW','Do you have a small covered trailer we could borrow for the school costume move on 4 April? Two trips across town, careful driver, fully insured. Collection and return the same day. School office: 555-0131.'),
 ('CHILD SEAT WANTED','Rear-mounted bicycle seat for a three-year-old. Must include the fitting bracket and foot straps. We can collect and would prefer to try the fit before buying. Please text the make and price to 555-0155.'),
 ('WEEKEND REPAIRS','Mobile bicycle maintenance at your front door. Punctures, cables and simple servicing, with a clear quote before work begins. Covering the north and east wards. Weekend slots booked online: pedalcare.example.')]),
 ('GARDEN & COMMUNITY',[
 ('SEEDS TO SWAP','Bring spare packets and saved seed to the community greenhouse, Sunday 10–12. Label the variety and year if known. Beginners can take a starter selection without bringing anything. Tea provided; please bring a mug.'),
 ('ALLOTMENT PARTNER','Established half-plot needs another pair of hands. Fruit bushes, compost bays and a small shed already in place. Share the work and harvest; no money changes hands. Meet at plot 18 on Saturday morning.'),
 ('TWO HENS NEED A HOME','Healthy, friendly laying hens seeking a secure garden run. Their keeper is moving and cannot take them. They must stay together. Feed bin and small house included if useful. Advice happily given. 555-0168.'),
 ('RIVER CLEAN-UP','Meet by the footbridge at 9:30 on 28 March. Gloves, bags and litter pickers supplied. Wear sturdy shoes and bring water. Children welcome with an adult; we finish with soup at the scout hut around noon.'),
 ('LOST: BLUE SCARF','Long wool scarf, dark blue with a narrow rust stripe, lost between the cinema and the bus station on Tuesday evening. A much-loved handmade gift. If found, please leave at the library desk. Thank you, Daniel.'),
 ('COMMUNITY SUPPER','A warm meal and good company at the parish hall every second Friday, 6–8pm. Pay what you can, no booking and no questions. Vegetarian and gluten-free dishes available. Volunteers for washing-up are always welcome.')])]
 x0=42;colw=211;gap=0;top=294;bottom=1815
 def lines(text,width,size,face):return len(p.wrap_lines(text,width,size,face))
 for ci,(category,ads) in enumerate(categories):
  x=x0+ci*colw
  if ci:p.line([x-8,top,x-8,bottom],'#71796a',1)
  p.rectangle([x,top,x+colw-18,top+36],'#313d31');p.text(category,x+7,top+7,colw-30,18,'narrow-bold','#f2ecd9',label='title')
  size=20
  while size>12:
   required=sum(lines(title,colw-27,size+1,'narrow-bold')*(size+1)*1.02+lines(body,colw-27,size,'serif')*size*1.06+24 for title,body in ads)
   if required<bottom-top-60:break
   size-=1
  y=top+52;extra=max(0,(bottom-y-required)/len(ads))
  for index,(title,body) in enumerate(ads):
   y=p.text(title,x+1,y,colw-27,size+1,'narrow-bold','#252c22',leading=(size+1)*1.02,label='title')+4
   y=p.text(body,x+1,y,colw-27,size,'serif','#2d3329',leading=size*1.06)+12
   if index<len(ads)-1:p.line([x+1,y,x+colw-28,y],'#969e8b',1)
   y+=12+extra
  if y>1840:raise ValueError('Classified column overflow')
 p.line([42,1845,1308,1845],'#384434',2);p.text('NOTICES CLOSE WEDNESDAY NOON  /  555-0100  /  NORTHSIDE.EXAMPLE',43,1860,1250,15,'mono','#4d5b43',label='footer')
 return p


def build():return [bicycle_ad(),classified(),investigation(),*field_reports()]
