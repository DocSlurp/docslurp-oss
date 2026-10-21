"""Five deliberately authored business/editorial pilots, awaiting visual review.

All names, addresses, prices and operational instructions are fictional. Technical
art is explicitly a source-authored vector illustration, never a surrogate photo.
No generation count loop or benchmark admission is provided here.
"""
try:
    from .page import Page
except ImportError:
    from page import Page


def menu():
    p=Page('business-nightjar-diner-menu',1000,1400,paper='#f7f0df')
    red='#9c352d'; ink='#252c29'; muted='#6b675c'
    p.rectangle([24,24,976,1376],None,outline=ink,width=3)
    p.text('OPEN EARLY. STAY A LITTLE.',70,63,860,17,'sans-bold',red,label='header')
    p.text('NIGHTJAR',66,98,870,107,'serif-bold',ink,label='title')
    p.line([73,232,927,232],ink,3)
    p.text('COFFEE & COUNTER',73,246,600,33,'narrow-bold',ink,label='title')
    p.text('EST. 2019  /  NORTH WINDOW',680,253,250,15,'mono',ink,label='caption')
    p.text('Good coffee, warm plates, and a seat by the window.',73,305,850,23,'serif-italic',muted)
    p.line([516,380,516,1080],'#b8ad97',1)
    def heading(text,x,y,w=385):
        p.text(text,x,y,w,32,'serif-bold',red,label='title');p.line([x,y+49,x+w,y+49],red,2)
    def item(name,price,description,x,y,w=385):
        p.text(name,x,y,w-66,23,'sans-bold',ink,label='paragraph',role='menu-item-name')
        p.text(price,x+w-60,y,60,22,'mono',ink,label='paragraph',role='menu-price')
        return p.text(description,x,y+32,w,18,'serif',muted,leading=22)+19
    heading('FROM THE GRIDDLE',73,378)
    y=450
    for name,price,desc in [
        ('Counter breakfast','14.50','Two eggs, crushed potatoes, sourdough toast. Choose mushrooms or smoked bacon.'),
        ('Ricotta hotcakes','13.00','Lemon ricotta, roasted pear, cultured cream and maple syrup.'),
        ('Green eggs on toast','12.50','Soft eggs, herb butter, spinach and pumpkin-seed crunch.'),
        ('The early sandwich','11.00','Folded egg, sharp cheddar and tomato relish in a toasted milk bun.'),
        ('Oat porridge','9.00','Steel-cut oats, poached plum, toasted almonds. Oat milk on request.')]:
        y=item(name,price,desc,73,y)
    heading('COFFEE, PROPERLY',560,378,365)
    p.text('House espresso · cacao / orange / caramel',560,438,365,18,'serif-italic',muted)
    # Borderless aligned data is one table, rather than independent price fragments.
    drinks=[('Espresso','3.50'),('Long black','4.00'),('Flat white','4.50'),('Cappuccino','4.50'),('Filter · rotating origin','4.00'),('Iced latte','5.00')]
    cells=[]
    for i,(name,price) in enumerate(drinks):
        yy=484+i*43
        p.text(name,560,yy,285,22,'sans',ink,label=None)
        p.text(price,858,yy,68,21,'mono',ink,label=None)
        for ci,(text,b) in enumerate([(name,[560,yy,842,yy+32]),(price,[855,yy,926,yy+32])]):
            cells.append({'row':i,'column':ci,'text':text,'bbox':b,'polygon':[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]],'is_header':False})
    p.region('table',[560,484,926,731],None,cells=cells,columns=2,rows=6,border=False,table_kind='menu-price-alignment')
    p.text('Oat +0.70  /  extra shot +1.00',560,758,365,16,'mono',muted)
    heading('SOMETHING COLD',560,830,365)
    item('House lemonade','5.00','Cloudy lemon, rosemary and soda.',560,899,365)
    item('Peach iced tea','5.50','Cold-brewed black tea. No added syrup.',560,992,365)
    p.rectangle([73,1121,927,1231],ink)
    p.text('AFTER 11: THE COUNTER MELT',96,1134,630,24,'narrow-bold','#f7f0df',label='title')
    p.text('Aged cheddar, onion jam, mustard. Pickle on the side.',96,1176,690,19,'serif','#f7f0df')
    p.text('12.50',803,1161,99,27,'mono','#f7f0df')
    p.text('Ask us about allergens before ordering. Shared preparation area; traces may remain.',73,1261,854,17,'sans',muted)
    p.text('MON–FRI 7–3   SAT–SUN 8–3     /     WALK INS ALWAYS WELCOME',73,1310,854,17,'narrow-bold',ink,label='footer')
    return p


def repair_manual():
    p=Page('business-cirrus-repair-manual',1120,1500,paper='#fcfcf8'); blue='#164c66'; ink='#202b31'
    p.rectangle([0,0,1120,47],blue)
    p.text('CIRRUS  /  BENCH SERVICE SERIES',58,12,1000,18,'sans-bold','#ffffff',label='header')
    p.text('Flow pump assembly',60,82,990,58,'sans-bold',ink,label='title')
    p.text('Model C40 · Removal, inspection & reassembly',62,164,980,25,'serif',blue,label='title')
    p.rectangle([60,224,1060,322],'#fff0cf',outline='#b58c38',width=1)
    p.text('ISOLATE POWER AND WATER',80,239,950,21,'sans-bold','#694a10',label='title')
    p.text('Unplug the unit. Close the inlet valve and allow the circuit to cool. Release residual pressure before removing the cover.',80,272,950,18,'sans','#694a10')
    p.text('03  /  EXPLODED ASSEMBLY',60,355,690,22,'narrow-bold',blue,label='title')
    # Distinct source-authored engineering illustration: aligned exploded parts,
    # dashed centerline, flange screws, cutaways and keyed leader callouts.
    box=[61,405,760,875];p.rectangle(box,'#f2f5f4')
    p.line([125,655,700,655],'#91a0a6',2)
    p.ellipse([130,543,274,766],'#d5dde0',outline=ink,width=3)
    p.ellipse([150,565,254,745],'#f5f7f7',outline=ink,width=2)
    p.ellipse([176,602,231,709],'#b0bec3',outline=ink,width=2)
    p.rectangle([182,530,220,555],'#b0bec3',outline=ink,width=2)
    p.rectangle([182,756,220,781],'#b0bec3',outline=ink,width=2)
    p.ellipse([310,576,348,736],None,outline='#4c767d',width=7)
    p.rectangle([391,594,464,716],'#b8c7cb',outline=ink,width=2)
    p.ellipse([380,594,419,716],'#e4ebed',outline=ink,width=2)
    p.ellipse([441,594,480,716],'#a4b7bf',outline=ink,width=2)
    for yy in (611,639,667,695): p.line([395,yy,455,yy+10],'#6d868f',2)
    p.rectangle([535,558,647,751],'#a2b7c0',outline=ink,width=3)
    p.ellipse([519,558,559,751],'#dce4e7',outline=ink,width=3)
    p.ellipse([623,558,663,751],'#8ba3ad',outline=ink,width=3)
    for xx in (565,578,591,604):p.line([xx,580,xx,729],'#728c98',2)
    p.rectangle([644,611,690,683],'#a2b7c0',outline=ink,width=2)
    def callout(n,anchor,elbow,position):
        p.line([*anchor,*elbow,*position],blue,2)
        cx,cy=position;p.ellipse([cx-15,cy-15,cx+15,cy+15],'#ffffff',outline=blue,width=2)
        p.text(str(n),cx-6,cy-11,30,18,'sans-bold',blue,label=None)
    callout(1,(188,581),(188,474),(130,474))
    callout(2,(330,591),(330,475),(373,475))
    callout(3,(432,625),(464,805),(420,805))
    callout(4,(590,574),(647,472),(690,472))
    p.region('illustration',box,None,illustration_kind='source-authored-exploded-technical-diagram',callouts={'1':'volute housing','2':'seal ring','3':'rotor cartridge','4':'drive motor'},not_a_photo=True)
    p.text('Fig. 3 · Parts separated along the shaft axis. Not to scale.',66,892,694,18,'serif-italic',ink,label='caption')
    p.text('PARTS KEY',806,407,250,22,'sans-bold',blue,label='title')
    y=459
    for n,name,desc in [('1','Volute housing','Inspect the inlet lip for chips and deposits.'),('2','Seal ring','Replace if flattened, cut or permanently stretched.'),('3','Rotor cartridge','Shaft should turn freely without binding.'),('4','Drive motor','Keep electrical connections dry during cleaning.')]:
        p.text(n,806,y,30,24,'mono',blue)
        p.text(name,843,y,211,20,'sans-bold',ink)
        y=p.text(desc,843,y+31,211,18,'serif',ink,leading=22)+32
    p.text('PROCEDURE',61,962,650,25,'sans-bold',blue,label='title')
    for n,title,body,yy in [
        ('1','Release the housing','Loosen the three captive screws evenly. Support the housing while separating it from the motor face.',1019),
        ('2','Clean and inspect','Rinse the removable parts with clean water. Use a soft brush; do not scrape the sealing surface.',1137),
        ('3','Refit and leak-check','Seat the seal without twisting. Tighten screws in stages, then restore water and check for leaks before power.',1255)]:
        p.text(n,62,yy,45,36,'serif-bold',blue)
        p.text(title,119,yy+2,600,23,'sans-bold',ink,label='title')
        p.text(body,119,yy+40,600,21,'serif',ink,leading=25)
    p.rectangle([800,983,1060,1353],'#e5edef')
    p.text('BENCH NOTES',821,1002,220,21,'narrow-bold',blue,label='title')
    p.text('Fasteners: M4 captive\nTorque: 1.8 N·m\nSeal: replace as a set\nTools: T20 driver\nand soft brush',821,1054,212,18,'sans',ink,leading=29)
    p.text('Log replaced parts and the leak-check result on the service record.',821,1228,213,18,'serif',ink)
    p.line([60,1420,1060,1420],blue,2)
    p.text('SERVICE DOCUMENT C40–03   /   REV. B',61,1438,800,16,'mono',blue,label='footer')
    p.text('07',1000,1430,60,30,'sans-bold',blue,label='footer')
    return p


def invoices():
    pages=[]; teal='#176065'; ink='#24353a'
    rows=[
        ['BR-104','Burr assembly · 64 mm','2','148.00','296.00'],
        ['GS-018','Food-safe gasket kit','6','12.50','75.00'],
        ['FT-220','In-line water filter cartridge','4','39.00','156.00'],
        ['VL-032','Steam valve service set','3','46.00','138.00'],
        ['HS-112','Reinforced inlet hose · 1.2 m','2','24.00','48.00'],
        ['SW-008','Sealed rocker switch','5','8.40','42.00'],
        ['LB-001','Workshop labour · bench hours','3.5','85.00','297.50'],
        ['CL-014','Descaling solution · 1 litre','8','11.75','94.00'],
        ['TB-065','Silicone tubing · per metre','5','6.80','34.00'],
        ['PK-017','Protective return packing','1','18.00','18.00'],
        ['FR-002','Regional freight · tracked','1','32.00','32.00']]
    for number,part in [(1,rows[:7]),(2,rows[7:])]:
        p=Page(f'business-meridian-invoice-{number}',1100,1460,paper='#ffffff',document_id='business-meridian-invoice',page_number=number)
        p.rectangle([0,0,28,1460],teal)
        p.text('MERIDIAN',70,66,650,60,'sans-bold',teal,label='title')
        p.text('WORKSHOP SUPPLY',72,143,650,21,'narrow',ink,label='header')
        p.text('INVOICE',816,73,225,37,'serif-bold',ink,label='title')
        p.text('INV–20481',819,126,220,24,'mono',ink)
        p.text('Meridian Workshop Supply\n17 Foundry Lane\nRiverton RV 4020',72,213,460,21,'sans',ink,leading=29)
        p.text('Issued  14 October 2026\nDue     13 November 2026\nTerms   Net 30',704,213,340,20,'mono',ink,leading=31)
        p.line([72,327,1035,327],teal,2)
        p.text('BILL TO',72,354,430,16,'sans-bold',teal,label='title')
        p.text('Northbank Coffee Cooperative\nAccounts payable\n82 Market Street\nRiverton RV 4022',72,393,440,22,'serif',ink,leading=29)
        p.text('DELIVER TO',622,354,410,16,'sans-bold',teal,label='title')
        p.text('Northbank service workshop\nReceiving bay B, rear entrance\n82 Market Street\nContact: receiving team',622,393,410,22,'serif',ink,leading=29)
        p.rectangle([72,548,1035,609],'#eef5f4')
        p.text('YOUR ORDER  NB–6128',86,567,440,18,'mono',ink)
        p.text('OUR REF  WS–1063  /  SHIP  13 OCT',559,567,463,18,'mono',ink)
        p.table([72,653,1035,1060],['CODE','DESCRIPTION','QTY','UNIT','AMOUNT'],part,
                widths=[.12,.46,.08,.16,.18],row_height=49,border=False,size=17,
                continuation_id='meridian-inv20481-items',row_offset=0 if number==1 else 7,header_fill=teal,ink=ink)
        # Header fill must retain readable text contrast; overlay pale header strip
        # is deliberately avoided: framework's ink applies to all rows.
        for command in p.source['commands']:
            if command.get('op')=='text' and 660<=command.get('position',[0,0])[1]<=662:
                command['fill']='#ffffff'
        if number==1:
            p.text('SUBTOTAL CARRIED FORWARD',600,1090,325,18,'sans-bold',teal)
            p.text('1,052.50',895,1121,140,23,'mono',ink)
            p.text('Line items continue on page 2. Please include both pages when matching this invoice to your purchase order.',73,1216,919,22,'serif',ink,leading=28)
            p.text('No payment is due against this page alone.',73,1290,920,18,'sans',teal)
        else:
            p.text('Continued from page 1 · brought forward 1,052.50',73,943,960,18,'serif-italic',ink,label='caption')
            labels=[('Subtotal','1,330.50'),('Tax · 10%','133.05'),('AMOUNT DUE','1,463.55')]
            for i,(label,value) in enumerate(labels):
                yy=1015+i*57
                if i==2:p.rectangle([592,yy-9,1035,yy+42],'#e5f1ef')
                p.text(label,608,yy,260,20,'sans-bold' if i==2 else 'sans',ink)
                p.text(value,896,yy,139,22,'mono',ink)
            p.text('PAYMENT & REMITTANCE',73,1184,930,19,'sans-bold',teal,label='title')
            p.text('Reference INV–20481 with your payment. Send remittance advice to your usual account contact. Inspect goods on receipt and report shortages within seven days.',73,1224,910,20,'serif',ink,leading=27)
        p.line([73,1382,1035,1382],teal,1)
        p.text('MERIDIAN  /  COMMERCIAL ACCOUNT DOCUMENT',73,1403,780,16,'narrow',teal,label='footer')
        p.text(f'{number} / 2',961,1397,80,22,'mono',teal,label='footer')
        pages.append(p)
    return pages


def transit_leaflet():
    p=Page('business-river-loop-timetable',1050,1485,paper='#f7f5ef');navy='#173c4b';orange='#c7522c'
    p.rectangle([0,0,1050,342],navy)
    p.text('NEIGHBOURHOOD CONNECTIONS',62,49,930,19,'narrow-bold','#f7f5ef',label='header')
    p.text('THE RIVER LOOP',56,105,940,73,'sans-bold','#f7f5ef',label='title')
    p.text('A small bus. A useful way around.',63,215,920,29,'serif-italic','#c2d9d7')
    p.text('ROUTE 06  /  WEEKDAYS  /  FROM 2 NOVEMBER',63,287,920,20,'mono','#f4bf9f')
    p.text('Every 30 minutes, from the station to the market and back.',63,382,921,29,'serif-bold',navy,label='title')
    p.text('Leave the car at home for short trips. Low-floor buses serve the library, clinic and riverside market. The timetable below lists selected departures; allow extra time when changing trains.',63,467,566,23,'serif',navy,leading=29)
    p.rectangle([691,466,989,635],'#e3ebe6')
    p.text('SIMPLE FARES',710,480,261,23,'narrow-bold',navy,label='title')
    p.text('Adult single     2.00\nConcession       1.00\nUnder 12         free',710,526,258,19,'mono',navy,leading=28)
    p.text('06  /  OUTBOUND STOPS',63,670,925,23,'sans-bold',navy,label='title')
    p.line([104,771,938,771],orange,9)
    stops=[('Station','Interchange'),('Library','Civic square'),('Clinic','East entrance'),('Market','Riverside')]
    for i,(name,sub) in enumerate(stops):
        x=104+i*278;p.ellipse([x-13,758,x+13,784],'#f7f5ef',outline=orange,width=5)
        p.text(name,x-44,714,180,23,'sans-bold',navy,label=None)
        p.text(sub,x-44,803,175,17,'sans',navy,label=None)
    p.region('illustration',[60,710,995,840],None,illustration_kind='schematic-transit-route',not_a_geographic_map=True,stops=[x[0] for x in stops])
    p.text('SELECTED DEPARTURES',63,890,925,24,'sans-bold',navy,label='title')
    p.table([63,943,990,1235],['STATION','LIBRARY','CLINIC','MARKET'],
            [['06:35','06:42','06:48','06:56'],['07:05','07:12','07:18','07:26'],['07:35','07:42','07:48','07:56'],['08:05','08:12','08:18','08:26'],['then every 30 min','until 18:42','until 18:48','until 18:56']],
            row_height=44,border=False,size=20,header_fill='#d8e6df',ink=navy)
    p.text('RETURN TRIPS',63,1253,430,21,'sans-bold',orange,label='title')
    p.text('Leave Market at :10 and :40 past each hour. The final return departs at 19:10.',63,1292,430,19,'serif',navy,leading=24)
    p.text('BEFORE YOU TRAVEL',560,1253,430,21,'sans-bold',orange,label='title')
    p.text('Public holidays use the Sunday service. Fold pushchairs where space is needed; mobility aids have priority.',560,1292,430,19,'serif',navy,leading=24)
    p.line([63,1400,990,1400],navy,1)
    p.text('RIVER LOOP  /  COMMUNITY TRANSPORT INFORMATION',63,1418,927,17,'narrow-bold',navy,label='footer')
    return p


def build():
    return [menu(),repair_manual(),*invoices(),transit_leaflet()]
