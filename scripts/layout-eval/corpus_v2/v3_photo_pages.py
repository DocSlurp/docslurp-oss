"""V3 photo-bearing pages built around receipt-backed real public-domain/CC0 photographs.

Each real photo is used on exactly one page so no image content straddles splits.
Copy, prices, organisations and news stories are authored and fictional; photo
credits are factual and taken from the asset receipts. Any text visible inside a
photograph is not annotated (transcription axis stays unknown).
"""
import json

try:
    from .page_v3 import PageV3, REAL_ASSETS
except ImportError:
    from page_v3 import PageV3, REAL_ASSETS


def receipt(asset_id):
    return json.loads((REAL_ASSETS / f'{asset_id}.receipt.json').read_text())


CREDIT = {
    'photo-produce-stand': 'USDA photo by Hakim Fobia', 'photo-honeycrisp-apple': 'Photo: Evan-Amos (CC0)',
    'photo-sourdough-loaf': 'Photo: Nutrition, Food Safety & Health (CC0)', 'photo-radishes-in-field': 'USDA photo by Lance Cheung',
    'photo-can-opener': 'Photo: Evan-Amos (public domain)', 'photo-portsmouth-aerial': 'Carol M. Highsmith / Library of Congress',
    'photo-tractor-plowing': 'USDA NRCS Texas', 'photo-bald-eagle-juvenile': 'Courtney Celley / USFWS',
    'photo-elk-gibbon-river': 'NPS photo', 'photo-habs-faraway-ranch-barn': 'Richard Frear, HABS / National Park Service',
    'photo-grand-canyon-lookout-studio': 'Grand Canyon National Park', 'photo-loc-main-reading-room': 'Carol M. Highsmith / Library of Congress',
}


def check_credit(asset_id):
    r = receipt(asset_id)
    creator = (r.get('creator') or '') + ' ' + (r.get('institution_or_archive') or '')
    surname = CREDIT[asset_id].replace('/', ' ').split()
    if not any(token.lower() in creator.lower() for token in surname if len(token) > 2 and token.lower() not in ('photo', 'photo:', 'by')):
        raise ValueError(f'Credit for {asset_id} does not match its receipt')
    return CREDIT[asset_id]


def grocery_flyer():
    p = PageV3('v3-ad-grocery-weekly-flyer', 1240, 1754, cluster='v3-ad-grocery-weekly-flyer',
               features=['advertisement-dense', 'photo-multiple', 'logo-multiple', 'coupon', 'price-badge', 'barcode', 'fine-print', 'text-over-photo'],
               brief='Dense weekly grocery flyer: hero photo with overlaid headline panel, product tiles with real photos and prices, three logos, dashed coupons with barcodes, fine print.',
               paper='#fffaf0')
    red, green, ink = '#c62828', '#2e7d32', '#1f1f1f'
    p.rectangle([0, 0, 1240, 110], green)
    p.ellipse([40, 18, 114, 92], '#fffaf0')
    p.ellipse([58, 36, 96, 74], green)
    p.line_text('FRESHFIELD', 130, 26, 44, 'sans-bold', '#fffaf0', label=None)
    p.region('logo', [40, 18, 412, 92], None, kind='authored-mark-and-wordmark')
    p.text('Weekly deals · Thu 22 – Wed 28 October', 720, 44, 480, 20, 'sans-bold', '#e8f5e9', label='header')
    p.real_asset('photo-produce-stand', [40, 130, 1200, 590], 'photo', overlaid_by='headline panel at lower left')
    p.rectangle([60, 430, 640, 570], '#ffffffdd' if False else '#fffaf0')
    p.text('Market week', 80, 444, 540, 46, 'serif-bold', red, label='title')
    p.text('Local veg from growers within 40 miles', 82, 512, 540, 22, 'sans', ink, label='paragraph')
    p.text(check_credit('photo-produce-stand'), 1000, 596, 200, 11, 'sans', '#777777', label='caption')
    tiles = [('photo-honeycrisp-apple', 'Honeycrisp apples', 'per kg', '£2.40', 'was £3.10'),
             ('photo-sourdough-loaf', 'Sourdough bloomer', '800 g, baked in store', '£2.25', ''),
             ('photo-radishes-in-field', 'Radishes', 'bunch', '65p', '2 for £1.10'),
             ('photo-can-opener', 'Classic can opener', 'stainless steel', '£4.99', 'was £6.50')]
    x0, y0, tw, th = 40, 630, 280, 520
    for i, (asset, name, unit, price, note) in enumerate(tiles):
        x = x0 + i * (tw + 13)
        p.rectangle([x, y0, x + tw, y0 + th], '#ffffff', outline='#e0d6c2', width=2)
        p.real_asset(asset, [x + 10, y0 + 10, x + tw - 10, y0 + 230], 'photo')
        p.text(check_credit(asset), x + 10, y0 + 236, tw - 20, 10, 'sans', '#8a8a8a', label='caption')
        p.text(name, x + 14, y0 + 262, tw - 28, 24, 'sans-bold', ink, label='title')
        p.text(unit, x + 14, y0 + 296, tw - 28, 16, 'sans', '#555555', label='paragraph')
        p.ellipse([x + tw - 140, y0 + 330, x + tw - 20, y0 + 450], red)
        p.line_text(price, x + tw - 80, y0 + 368, 34, 'sans-bold', '#ffffff', align='center', label=None)
        p.region('figure', [x + tw - 140, y0 + 330, x + tw - 20, y0 + 450], None, kind='price-badge')
        if note:
            p.text(note, x + 14, y0 + 380, 110, 16, 'sans', red, label='paragraph')
    # brand logos strip
    p.text('Also on offer this week from', 40, 1175, 400, 16, 'sans-bold', '#555555', label='paragraph')
    p.rectangle([450, 1165, 640, 1210], '#1a237e')
    p.line_text('NORDKAFFE', 545, 1175, 22, 'sans-bold', '#ffffff', align='center', label=None)
    p.region('logo', [450, 1165, 640, 1210], None, kind='authored-plate-wordmark')
    p.ellipse([665, 1163, 713, 1211], '#f9a825')
    p.line_text('Hollow Farm', 722, 1172, 24, 'serif-bold', '#5d4037', label=None)
    p.region('logo', [665, 1163, 870, 1211], None, kind='authored-sun-wordmark')
    # coupons
    cy = 1240
    coupons = [('£1 OFF', 'any two Hollow Farm yoghurts', '2049 1180 0071'), ('20% OFF', 'NORDKAFFE beans 1 kg', '2049 1180 0088'), ('FREE', 'reusable bag when you spend £30', '2049 1180 0095')]
    for i, (big, small, code) in enumerate(coupons):
        x = 40 + i * 393
        p.dashed_rect([x, cy, x + 370, cy + 300], '#333333')
        p.text('COUPON', x + 20, cy + 18, 200, 14, 'sans-bold', '#777777', label='paragraph')
        p.text(big, x + 20, cy + 44, 330, 48, 'sans-bold', red, label='title')
        p.text(small, x + 20, cy + 106, 330, 18, 'sans', ink, leading=24, label='paragraph')
        p.barcode([x + 40, cy + 165, x + 330, cy + 240], code.replace(' ', ''))
        p.text('Valid 22–28 Oct. One per customer.', x + 20, cy + 262, 330, 12, 'sans', '#666666', label='paragraph')
    p.text('Prices include VAT. Offers while stocks last, in Freshfield stores in Kelby, Upton and Marsh End only. Weights are approximate; loose produce is charged at the till price per kg. Freshfield and the brands shown are fictional; this flyer is an authored layout specimen.', 40, 1580, 1160, 12, 'sans', '#555555', leading=17, label='footer')
    return p


def newspaper_front():
    p = PageV3('v3-news-front-harbour-courier', 1240, 1754, cluster='v3-news-front-harbour-courier',
               features=['newspaper', 'multi-column', 'column-rules', 'photo-with-caption', 'masthead', 'headline-spanning', 'index-box', 'jump-line'],
               brief='Five-column modern broadsheet front: masthead, spanning headline, lead aerial photo with caption and credit, column rules, second story with photo, index and weather boxes.',
               paper='#f6f4ee')
    ink = '#151515'
    p.text('THE HARBOUR COURIER', 40, 30, 1160, 70, 'century-bold', ink, label='header', kind='masthead')
    p.line([40, 120, 1200, 120], ink, 3)
    p.text('Tuesday 20 October 2026   ·   Vol. 141 No. 233   ·   £1.80', 40, 128, 800, 15, 'sans', ink, label='header')
    p.text('harbourcourier.example', 1000, 128, 200, 15, 'sans', ink, label='header')
    p.line([40, 152, 1200, 152], ink, 1)
    y = p.text('Council backs plan to rebuild the north quay', 40, 166, 1160, 48, 'century-bold', ink, label='title')
    y = p.text('Ten-year scheme would raise the harbour wall and add 400 homes on former rail sidings', 40, y + 6, 1160, 22, 'century-italic', '#333333', label='paragraph', kind='standfirst')
    top = y + 18
    col_w, gap = 216, 20
    xs = [40 + i * (col_w + gap) for i in range(5)]
    photo_right = xs[2] + col_w
    p.real_asset('photo-portsmouth-aerial', [xs[0], top, photo_right, top + 380], 'photo')
    p.text('The north quay and the rail sidings beyond it, seen from the air. The plan would keep the historic warehouses on the waterfront.', xs[0], top + 390, photo_right - xs[0] - 190, 14, 'century-italic', '#333333', leading=19, label='caption')
    p.text(check_credit('photo-portsmouth-aerial'), photo_right - 175, top + 390, 175, 11, 'sans', '#666666', label='caption')
    body = ['Councillors last night approved the outline of a ten-year plan to rebuild the north quay, ending a dispute that has run since the 2019 floods. The vote was 31 to 9, with two abstentions.',
            'The scheme raises the harbour wall by 1.2 metres along its full length and replaces the timber jetty, which engineers say has reached the end of its life. A new public walkway would run from the ferry terminal to the lighthouse.',
            'On the former rail sidings behind the quay, a developer would build up to 400 homes, a third of them for social rent. Opponents say the site should be kept for port uses.',
            '“We cannot keep patching a wall that was built for a different sea,” said the council leader, Ruth Okoro. The harbour board will publish detailed designs in the spring.']
    y = p.text('By MAYA PRICE, Political Correspondent', xs[3], top, col_w, 13, 'sans-bold', ink, label='paragraph', kind='byline')
    for para in body[:2]:
        y = p.text(para, xs[3], y + 8, col_w, 15, 'century', ink, leading=21)
    y3_end = y
    y = top
    for para in body[2:]:
        y = p.text(para, xs[4], y, col_w, 15, 'century', ink, leading=21) + 8
    y = p.text('Continued on page 4', xs[4], y, col_w, 13, 'sans-bold', ink, label='paragraph', kind='jump-line')
    p.line([xs[4] - 6, y + 14, xs[4] + col_w, y + 14], ink, 2)
    y = p.text('IN BRIEF', xs[4], y + 26, col_w, 15, 'sans-bold', '#8a1c1c', label='title')
    briefs = [('Ferry fares frozen', 'The island ferry will keep its winter fares at last year’s level, the operator confirmed on Monday.'),
              ('Library hours', 'Branch libraries will open until 8pm on Thursdays from November.'),
              ('Lifeboat call-outs', 'The station launched 14 times in September, its busiest month since 2018.'),
              ('Market moves', 'The Saturday market moves to Quay Square while the high street is resurfaced.')]
    for head, text in briefs:
        y = p.text(head, xs[4], y + 12, col_w, 15, 'century-bold', ink, label='title')
        y = p.text(text, xs[4], y + 4, col_w, 14, 'century', ink, leading=19)
    lower = max(top + 440, y3_end) + 20
    p.line([xs[3] - gap / 2, top, xs[3] - gap / 2, lower - 10], '#999999', 1)
    p.line([xs[4] - gap / 2, top, xs[4] - gap / 2, 1520], '#999999', 1)
    p.line([40, lower, xs[4] - gap / 2 - 4, lower], ink, 2)
    p.text('Ploughing starts early as dry autumn helps farmers', 40, lower + 14, xs[4] - 60, 30, 'century-bold', ink, label='title')
    second = lower + 66
    p.real_asset('photo-tractor-plowing', [xs[0], second, xs[1] + col_w, second + 300], 'photo')
    p.text('A tractor turns over stubble on a farm east of the town. Contractors say bookings are three weeks ahead of last year.', xs[0], second + 308, 2 * col_w + gap, 14, 'century-italic', '#333333', leading=19, label='caption')
    p.text(check_credit('photo-tractor-plowing'), xs[0], second + 350, 2 * col_w + gap, 11, 'sans', '#666666', label='caption')
    story = ['The driest October in a decade has let farmers on the coastal plain start autumn cultivation weeks earlier than usual. Several said they had finished drilling winter wheat before the middle of the month, something that last happened in 2016.',
             'Agricultural contractors report bookings about three weeks ahead of last year, and machinery dealers say demand for spare parts has risen accordingly.',
             'The dry spell has a downside. Grass growth has slowed, and some livestock farmers have begun feeding winter forage in early autumn.',
             'Water companies have not yet proposed restrictions. Reservoir levels stand at 71 per cent of capacity, close to the seasonal average, and forecasters expect rain to return by the end of the month.',
             'The farmers’ union said members should keep records of any losses in case the dry weather continues into the new year.']
    y = p.text('By TOM ASHE', xs[2], second, col_w, 13, 'sans-bold', ink, label='paragraph', kind='byline')
    for para in story[:2]:
        y = p.text(para, xs[2], y + 8, col_w, 15, 'century', ink, leading=21)
    y = second - 8
    for para in story[2:]:
        y = p.text(para, xs[3], y + 8, col_w, 15, 'century', ink, leading=21)
    p.line([xs[2] - gap / 2, second, xs[2] - gap / 2, 1520], '#999999', 1)
    p.line([xs[3] - gap / 2, second, xs[3] - gap / 2, 1520], '#999999', 1)
    # index and weather
    p.rectangle([xs[4], 1330, xs[4] + col_w, 1520], '#e7e3d8')
    p.text('INSIDE', xs[4] + 12, 1340, col_w - 24, 15, 'sans-bold', ink, label='title')
    p.text('Letters  12\nBusiness  18–21\nObituaries  27\nPuzzles  34\nSport  40–48\nTV and radio  51', xs[4] + 12, 1366, col_w - 24, 15, 'sans', ink, leading=24, label='list', kind='index')
    p.rectangle([40, 1300, xs[2] - gap, 1520], '#ffffff', outline='#bbbbbb')
    p.text('WEATHER', 55, 1310, 300, 15, 'sans-bold', ink, label='title')
    p.table_v3([55, 1336, xs[2] - gap - 15, 1336 + 5 * 34], [[('', 1), ('Today', 1), ('Wed', 1), ('Thu', 1)]],
               [['High °C', '16', '15', '13'], ['Low °C', '9', '8', '6'], ['Rain', '10%', '30%', '80%'], ['Wind mph', 'W 12', 'SW 18', 'S 25']],
               [.31, .23, .23, .23], rules='horizontal', align=['left', 'right', 'right', 'right'], row_height=34, face='sans', size=15, rule_color='#cccccc')
    p.line([40, 1560, 1200, 1560], ink, 1)
    p.text('The Harbour Courier is a fictional newspaper; stories are authored for a layout test. Photographs are public-domain works credited on the page.', 40, 1572, 1160, 12, 'sans', '#555555', label='footer')
    return p


def field_guide():
    p = PageV3('v3-field-guide-river-valley', 1240, 1754, cluster='v3-field-guide-river-valley',
               features=['photo-with-caption', 'photo-multiple', 'species-accounts', 'table-borderless', 'sidebar', 'two-column', 'header', 'footer'],
               brief='Field-guide page with two species accounts: photographs with captions and credits, identification lists, borderless measurement tables and a sidebar.',
               paper='#f7f6f1')
    ink, accent = '#22301f', '#5b7f3a'
    p.text('RIVER VALLEY WILDLIFE  ·  A POCKET GUIDE', 60, 40, 800, 15, 'gothic-bold', accent, label='header')
    p.text('Birds and mammals', 960, 40, 220, 15, 'gothic', '#666666', label='header')
    p.line([60, 68, 1180, 68], accent, 2)
    accounts = [('photo-bald-eagle-juvenile', 'Bald eagle (juvenile)', 'Haliaeetus leucocephalus',
                 'Young birds are mottled brown and white and lack the white head of adults until their fifth year. Watch for them along open water in winter, often perched in tall riverside trees.',
                 '• Wingspan up to 2.3 m\n• Bill dark in first year, yellowing with age\n• Flies on flat, plank-like wings',
                 [('Length', '71–96 cm'), ('Weight', '3.0–6.3 kg'), ('Seen', 'Nov–Mar')], 'A juvenile bald eagle perched in a bare riverside tree.'),
                ('photo-elk-gibbon-river', 'Elk (wapiti)', 'Cervus canadensis',
                 'Large deer that gather in herds on valley floors in winter. Bulls carry wide, branching antlers from late summer until they drop in early spring.',
                 '• Pale rump patch\n• Dark brown neck mane\n• Bugling call in autumn',
                 [('Shoulder', '1.3–1.5 m'), ('Weight', '225–330 kg'), ('Seen', 'all year')], 'Elk standing and feeding in a river in winter.')]
    y = 95
    for asset, name, latin, prose, marks, table, caption in accounts:
        p.real_asset(asset, [60, y, 640, y + 400], 'photo')
        p.text(caption + '  ' + check_credit(asset), 60, y + 408, 580, 14, 'gothic', '#555555', leading=19, label='caption')
        p.text(name, 680, y, 500, 32, 'palatino-bold', ink, label='title')
        p.text(latin, 680, y + 44, 500, 19, 'palatino-italic', '#555555', label='paragraph', kind='scientific-name')
        ty = p.text(prose, 680, y + 84, 500, 17, 'palatino', ink, leading=25)
        ty = p.text(marks, 680, ty + 10, 500, 16, 'gothic', ink, leading=25, label='list')
        p.table_v3([680, ty + 16, 1000, ty + 16 + 3 * 30], [], [list(r) for r in table], [.45, .55], rules='none', align=['left', 'left'],
                   row_height=30, face='gothic', size=15, pad=0)
        y += 520
    p.rectangle([60, 1150, 1180, 1340], '#e9eedf')
    p.text('Watching without disturbing', 85, 1172, 600, 24, 'palatino-bold', ink, label='title')
    p.text('Keep at least 25 metres from elk and 100 metres from nesting eagles. Use binoculars rather than approaching for a closer look, and stay on marked paths in winter, when animals have little energy to spare.', 85, 1214, 520, 17, 'palatino', ink, leading=25)
    p.text('If an animal changes its behaviour because of you, you are too close. Back away slowly and give it room to move off.', 650, 1214, 505, 17, 'palatino', ink, leading=25)
    p.line([60, 1650, 1180, 1650], '#c7cdb8', 1)
    p.text('River Valley Wildlife is an authored guide for a layout test; photographs are public-domain U.S. government works.', 60, 1665, 1000, 13, 'gothic', '#6b6f62', label='footer')
    p.text('17', 1150, 1662, 30, 15, 'gothic', '#6b6f62', label='footer')
    return p


def heritage_brochure():
    p = PageV3('v3-brochure-heritage-open-days', 1754, 1240, cluster='v3-brochure-heritage-open-days',
               features=['landscape', 'three-panel', 'photo-with-caption', 'photo-multiple', 'table-booktabs', 'illustration-map', 'title', 'footer'],
               brief='Landscape three-panel brochure: three real heritage photographs with captions, panel prose, booktabs opening-times table and an authored schematic map.',
               paper='#fbf8f2')
    ink, accent = '#2a2420', '#8c3b2a'
    pw, gap = 530, 40
    xs = [40, 40 + pw + gap, 40 + 2 * (pw + gap)]
    for x in xs[1:]:
        p.line([x - gap / 2, 40, x - gap / 2, 1200], '#d5cbbd', 1)
    p.text('HERITAGE OPEN DAYS', xs[0], 50, pw, 18, 'gothic-bold', accent, label='header')
    p.text('Doors open on places that are usually closed', xs[0], 85, pw, 40, 'palatino-bold', ink, leading=46, label='title')
    p.real_asset('photo-loc-main-reading-room', [xs[0], 200, xs[0] + pw, 560], 'photo')
    p.text('A domed reading room of the kind visited on the library tour. ' + check_credit('photo-loc-main-reading-room'), xs[0], 568, pw, 14, 'gothic', '#5a524b', leading=19, label='caption')
    p.text('For one weekend each autumn, owners and volunteers open buildings that are normally private or rarely staffed. Entry is free; some tours need booking because space is limited.', xs[0], 625, pw, 18, 'palatino', ink, leading=27)
    p.text('This leaflet lists three of this year’s visits. Each has step-free access to the ground floor; ask a steward for help with upper floors.', xs[0], 760, pw, 18, 'palatino', ink, leading=27)
    p.text('THE FARM BARN', xs[1], 50, pw, 18, 'gothic-bold', accent, label='title')
    p.real_asset('photo-habs-faraway-ranch-barn', [xs[1], 90, xs[1] + pw, 520], 'photo')
    p.text('Timber barn and tool shed, photographed for a historic buildings survey. ' + check_credit('photo-habs-faraway-ranch-barn'), xs[1], 528, pw, 14, 'gothic', '#5a524b', leading=19, label='caption')
    p.text('A working barn whose frame has stood for more than a century. Volunteers will show the hand-cut joints, the hay loft and the tools kept in the shed alongside.', xs[1], 600, pw, 18, 'palatino', ink, leading=27)
    p.text('THE CANYON STUDIO', xs[1], 760, pw, 18, 'gothic-bold', accent, label='title')
    p.real_asset('photo-grand-canyon-lookout-studio', [xs[1], 800, xs[1] + pw, 1080], 'photo')
    p.text('Stone studio on the canyon rim at sunrise. ' + check_credit('photo-grand-canyon-lookout-studio'), xs[1], 1088, pw, 14, 'gothic', '#5a524b', leading=19, label='caption')
    p.text('Opening times', xs[2], 50, pw, 26, 'palatino-bold', ink, label='title')
    p.table_v3([xs[2], 100, xs[2] + pw, 100 + 4 * 40], [[('Visit', 1), ('Saturday', 1), ('Sunday', 1)]],
               [['Library tour', '10:00–16:00', '11:00–15:00'], ['Farm barn', '09:30–17:00', '09:30–17:00'], ['Canyon studio', 'by booking', 'closed']],
               [.4, .3, .3], rules='booktabs', align=['left', 'left', 'left'], row_height=40, face='gothic', size=16, header_face='gothic-bold')
    p.text('Tours last about 45 minutes. Booking opens two weeks before the weekend.', xs[2], 280, pw, 15, 'gothic', '#5a524b', leading=21, label='caption')
    mx0, my0 = xs[2], 350
    p.rectangle([mx0, my0, mx0 + pw, my0 + 480], '#efe7da')
    p.line([mx0 + 30, my0 + 400, mx0 + 200, my0 + 250, mx0 + 380, my0 + 230, mx0 + 520, my0 + 80], '#b9a68e', 8)
    p.line([mx0 + 60, my0 + 60, mx0 + 260, my0 + 450], '#7d9bb3', 6)
    for (dx, dy, label) in ((200, 250, '1  Library'), (380, 230, '2  Barn'), (500, 95, '3  Studio')):
        p.ellipse([mx0 + dx - 11, my0 + dy - 11, mx0 + dx + 11, my0 + dy + 11], accent)
        p.text(label, mx0 + min(dx + 16, pw - 110), my0 + dy + 14, 110, 15, 'gothic-bold', ink, label=None)
    p.text('River', mx0 + 250, my0 + 380, 80, 14, 'gothic', '#4f6d85', label=None)
    p.text('N ↑', mx0 + pw - 60, my0 + 440, 50, 16, 'gothic-bold', ink, label=None)
    p.region('illustration', [mx0, my0, mx0 + pw, my0 + 480], None, kind='authored-schematic-map', not_to_scale=True)
    p.text('Map not to scale. A free shuttle runs between the three sites every 30 minutes.', xs[2], 840, pw, 15, 'gothic', '#5a524b', leading=21, label='caption')
    p.text('Heritage Open Days in this leaflet are fictional; photographs are public-domain works from U.S. government collections, credited beside each image.', xs[2], 1130, pw, 12, 'gothic', '#7a7068', leading=17, label='footer')
    return p


def build():
    return [grocery_flyer(), newspaper_front(), field_guide(), heritage_brochure()]
