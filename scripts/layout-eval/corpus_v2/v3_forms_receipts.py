"""V3 forms (filled and unfilled) and point-of-sale receipts. All parties are fictional."""
try:
    from .page_v3 import PageV3
except ImportError:
    from page_v3 import PageV3


def insurance_claim_filled():
    p = PageV3('v3-form-filled-motor-claim', 1240, 1754, cluster='v3-form-filled-motor-claim',
               features=['form-filled', 'typed-entries', 'checkbox-checked', 'illustration', 'multiple-form-sections', 'header', 'footer', 'logo'],
               brief='Filled motor-insurance claim: three bordered form sections with typed entries, ticked boxes, a vehicle damage sketch and declaration.',
               paper='#fbfbf8')
    ink = '#1d2733'
    blue = '#1c3f94'
    p.rectangle([70, 48, 120, 98], '#c8102e')
    p.rectangle([82, 60, 108, 86], '#fbfbf8')
    p.rectangle([90, 68, 100, 78], '#c8102e')
    p.region('logo', [70, 48, 120, 98], None, kind='authored-square-mark')
    p.text('Fairway Mutual Insurance', 135, 52, 600, 26, 'sans-bold', ink, label='header')
    p.text('Claims line 0800 555 0199', 135, 84, 600, 14, 'sans', '#555555', label='header')
    p.text('Form MC-2', 1060, 60, 110, 16, 'sans-bold', '#555555', label='header')
    p.text('Motor accident claim form', 70, 135, 1100, 36, 'sans-bold', ink, label='title')
    p.text('Complete every section in capital letters. If there was more than one other vehicle, attach a separate sheet. Return the form within 30 days of the accident.', 70, 185, 1100, 16, 'sans', '#444444', leading=24)

    def section(top, bottom, number, heading):
        p.rectangle([70, top, 1170, top + 34], '#e6e9ef')
        p.text(f'{number}  {heading}', 84, top + 8, 900, 17, 'sans-bold', ink, label=None)
        p.rectangle([70, top, 1170, bottom], None, outline='#8a94a6', width=2)

    def entry(x, y, width, caption, value):
        p.text(caption, x, y, width, 13, 'sans', '#666666', label=None)
        p.line([x, y + 50, x + width, y + 50], '#9aa3b2', 1)
        p.text(value, x + 4, y + 22, width - 8, 19, 'mono-bold', blue, label=None)

    top = 250
    section(top, top + 300, '1', 'Policyholder and driver')
    entry(95, top + 50, 500, 'Policy number', 'FMI-MC-4471902')
    entry(640, top + 50, 505, 'Vehicle registration', 'KX19 TRL')
    entry(95, top + 120, 500, 'Policyholder name', 'ANNA MAREK')
    entry(640, top + 120, 505, 'Telephone', '07700 900418')
    p.text('Was the policyholder driving?', 95, top + 200, 300, 15, 'sans', '#333333', label=None)
    for i, (opt, ticked) in enumerate((('Yes', True), ('No', False))):
        p.checkbox(400 + i * 110, top + 198, checked=ticked)
        p.text(opt, 428 + i * 110, top + 200, 60, 15, 'sans', '#333333', label=None)
    entry(640, top + 190, 505, 'Driver name (if different)', '')
    p.region('form', [70, top, 1170, top + 300], None, form_state='filled-typed', section='policyholder-and-driver')
    top = 580
    section(top, top + 520, '2', 'The accident')
    entry(95, top + 50, 300, 'Date', '12/10/2026')
    entry(420, top + 50, 200, 'Time', '08:40')
    entry(640, top + 50, 505, 'Place', 'A6 ROUNDABOUT, BRIDGE ST')
    p.text('Road conditions', 95, top + 125, 300, 15, 'sans', '#333333', label=None)
    for i, (opt, ticked) in enumerate((('Dry', False), ('Wet', True), ('Ice', False), ('Fog', False))):
        p.checkbox(95 + i * 120, top + 155, checked=ticked)
        p.text(opt, 123 + i * 120, top + 157, 70, 15, 'sans', '#333333', label=None)
    p.text('Describe what happened', 95, top + 205, 500, 13, 'sans', '#666666', label=None)
    for k in range(5):
        p.line([95, top + 255 + k * 40, 600, top + 255 + k * 40], '#c3c9d3', 1)
    p.text('I WAS ON THE ROUNDABOUT IN THE LEFT LANE. THE OTHER CAR JOINED FROM BRIDGE ST WITHOUT STOPPING AND HIT MY NEAR-SIDE REAR DOOR. NOBODY WAS HURT.', 99, top + 228, 495, 17, 'mono-bold', blue, leading=40, label=None)
    p.text('Mark the damage on the sketch', 660, top + 125, 480, 15, 'sans', '#333333', label=None)
    sx0, sy0 = 700, top + 182
    p.rectangle([sx0 + 40, sy0, sx0 + 300, sy0 + 320], None, outline='#56607a', width=3)
    p.rectangle([sx0 + 70, sy0 + 40, sx0 + 270, sy0 + 110], None, outline='#56607a', width=2)
    p.rectangle([sx0 + 70, sy0 + 210, sx0 + 270, sy0 + 280], None, outline='#56607a', width=2)
    for wx, wy in ((sx0 + 15, sy0 + 40), (sx0 + 300, sy0 + 40), (sx0 + 15, sy0 + 220), (sx0 + 300, sy0 + 220)):
        p.rectangle([wx, wy, wx + 25, wy + 60], '#56607a')
    p.ellipse([sx0 - 5, sy0 + 190, sx0 + 85, sy0 + 270], None, outline='#c8102e', width=4)
    p.text('FRONT', sx0 + 140, sy0 - 28, 80, 14, 'sans-bold', '#56607a', label=None)
    p.region('illustration', [sx0 - 10, sy0 - 32, sx0 + 350, sy0 + 325], None, kind='authored-vehicle-damage-sketch', marked='near-side rear door circled')
    p.region('form', [70, top, 1170, top + 520], None, form_state='filled-typed', section='accident', nested_regions='damage sketch is a separate illustration region')
    top = 1130
    section(top, top + 280, '3', 'Declaration')
    p.text('I declare that the information given is true and complete. I understand that a false or incomplete answer may mean my claim is not paid.', 95, top + 50, 1050, 15, 'sans', '#333333', leading=23, label=None)
    entry(95, top + 120, 500, 'Signed', 'A. MAREK')
    entry(640, top + 120, 505, 'Date', '14/10/2026')
    p.checkbox(95, top + 205, checked=True)
    p.text('I agree that Fairway Mutual may contact the other driver’s insurer on my behalf.', 125, top + 207, 1000, 15, 'sans', '#333333', label=None)
    p.region('form', [70, top, 1170, top + 280], None, form_state='filled-typed', section='declaration',
             signature_policy='typed name in the signature field; no handwriting asset')
    p.text('For office use: claim reference ____________   handler ________', 70, 1450, 1100, 14, 'mono', '#777777', label='paragraph')
    p.line([70, 1650, 1170, 1650], '#c9ced8', 1)
    p.text('Fairway Mutual Insurance is fictional. Authored layout specimen.  MC-2 (09/26)', 70, 1665, 900, 13, 'sans', '#777777', label='footer')
    p.text('Page 1 of 1', 1080, 1665, 90, 13, 'sans', '#777777', label='footer')
    return p


def allotment_application_unfilled():
    p = PageV3('v3-form-unfilled-allotment', 1240, 1754, cluster='v3-form-unfilled-allotment',
               features=['form-unfilled', 'comb-fields', 'checkbox', 'empty-grid-table', 'notes', 'header', 'footer'],
               brief='Unfilled allotment application: character-comb boxes, checkboxes, an empty household grid with authored empty cells, guidance notes.',
               paper='#ffffff')
    ink = '#21301f'
    green = '#3b6b2f'
    p.text('Ashby Vale Parish Council', 70, 50, 700, 22, 'serif-bold', green, label='header')
    p.text('Allotments  ·  Application A1', 870, 56, 300, 15, 'sans', '#5a6b57', label='header')
    p.line([70, 92, 1170, 92], green, 2)
    p.text('Application for an allotment plot', 70, 120, 1100, 38, 'serif-bold', ink, label='title')
    p.text('Plots are offered in order of application to residents of the parish. Please write one letter in each box.', 70, 178, 1100, 17, 'serif', '#3b4739', leading=26)
    top = 230
    p.rectangle([70, top, 1170, 1180], None, outline='#7c8f78', width=2)

    def comb(x, y, caption, boxes, size=34):
        p.text(caption, x, y, 600, 15, 'sans', '#4a5547', label=None)
        for i in range(boxes):
            p.rectangle([x + i * size, y + 26, x + (i + 1) * size, y + 26 + size], None, outline='#7c8f78', width=1)
        return y + 26 + size

    comb(95, top + 25, 'Surname', 26)
    comb(95, top + 110, 'First names', 26)
    comb(95, top + 195, 'Address line 1', 26)
    comb(95, top + 280, 'Address line 2', 26)
    comb(95, top + 365, 'Postcode', 8)
    comb(500, top + 365, 'Telephone', 12)
    p.text('Plot size wanted', 95, top + 460, 400, 15, 'sans', '#4a5547', label=None)
    for i, opt in enumerate(('Quarter plot (63 m²)', 'Half plot (125 m²)', 'Full plot (250 m²)', 'No preference')):
        p.checkbox(95 + i * 265, top + 490)
        p.text(opt, 123 + i * 265, top + 491, 230, 15, 'sans', '#333333', label=None)
    p.text('Do you need a raised bed or step-free access?', 95, top + 545, 600, 15, 'sans', '#4a5547', label=None)
    for i, opt in enumerate(('Yes', 'No')):
        p.checkbox(700 + i * 110, top + 543)
        p.text(opt, 728 + i * 110, top + 545, 60, 15, 'sans', '#333333', label=None)
    p.text('Other people who will work the plot', 95, top + 600, 600, 15, 'sans-bold', '#4a5547', label=None)
    p.table_v3([95, top + 630, 1145, top + 630 + 5 * 44], [[('Name', 1), ('Relationship', 1), ('Age if under 16', 1), ('Telephone', 1)]],
               [['', '', '', ''] for _ in range(4)], [.36, .22, .17, .25], rules='grid', align=['left'] * 4, row_height=44, face='sans', size=15,
               rule_color='#7c8f78', header_fill='#eef2ec')
    p.text('Signature', 95, top + 885, 300, 15, 'sans', '#4a5547', label=None)
    p.line([95, top + 930, 600, top + 930], '#333333', 1)
    p.text('Date', 700, top + 885, 300, 15, 'sans', '#4a5547', label=None)
    for i in range(8):
        p.rectangle([700 + i * 34, top + 905, 734 + i * 34, top + 939], None, outline='#7c8f78', width=1)
    p.region('form', [70, top, 1170, 1180], None, form_state='unfilled', field_policy='comb boxes, checkboxes and captions are internal form components; the household grid is a nested table region with authored empty cells')
    p.text('Notes', 70, 1220, 300, 22, 'serif-bold', ink, label='title')
    p.text('1. The annual rent is £38 for a half plot, payable each October.\n2. Bonfires are not permitted between April and September.\n3. Sheds need written permission and may not exceed 1.8 m × 1.2 m.\n4. We will write to you when a plot becomes available; the waiting list is reviewed every March.', 70, 1260, 1100, 17, 'serif', '#3b4739', leading=30, label='list')
    p.text('Return to: The Clerk, Ashby Vale Parish Council, The Old School, Mill Lane.', 70, 1420, 1100, 16, 'serif-italic', '#3b4739', label='paragraph')
    p.line([70, 1650, 1170, 1650], '#c5cec2', 1)
    p.text('Ashby Vale Parish Council is fictional. Authored layout specimen.', 70, 1665, 900, 13, 'sans', '#7a8577', label='footer')
    return p


def grocery_receipt():
    p = PageV3('v3-receipt-grocery-thermal', 600, 1230, cluster='v3-receipt-grocery-thermal',
               features=['receipt', 'narrow-page', 'monospace', 'table-borderless', 'barcode', 'logo', 'totals'],
               brief='Narrow thermal grocery receipt: logo, store header, borderless item table, totals table, payment block, barcode and footer.',
               paper='#f7f6f2')
    ink = '#262626'
    p.ellipse([255, 30, 345, 120], '#262626')
    p.line_text('OM', 300, 56, 36, 'sans-bold', '#f7f6f2', align='center')
    p.region('logo', [255, 30, 345, 120], None, kind='authored-circle-monogram')
    p.line_text('ORCHARD MARKET', 300, 140, 30, 'mono-bold', ink, align='center', label='header')
    p.text('14 Station Parade, Kelby\nTel 01632 960 233\nVAT No. 284 5512 07', 120, 186, 360, 17, 'mono', ink, leading=24, label='header')
    p.line([30, 270, 570, 270], ink, 1)
    p.text('21/10/2026  17:42   Till 3   Op 118', 30, 285, 540, 16, 'mono', ink, label='paragraph')
    items = [('BANANAS LOOSE 0.86kg', '1', '1.03'), ('SEMI SKIMMED MILK 2L', '1', '1.65'), ('SOURDOUGH LOAF', '1', '2.80'),
             ('FREE RANGE EGGS x6', '2', '4.10'), ('CHEDDAR MATURE 400G', '1', '3.95'), ('TINNED TOMATOES', '4', '2.36'),
             ('PASTA FUSILLI 500G', '2', '1.90'), ('ONIONS RED NET', '1', '0.95'), ('WASHING UP LIQUID', '1', '1.75'),
             ('APPLES BRAEBURN x6', '1', '2.40'), ('COFFEE BEANS 227G', '1', '4.60'), ('YOGHURT GREEK 500G', '1', '2.15')]
    total = round(sum(float(i[2]) for i in items), 2)
    rows = [[d, q, v] for d, q, v in items]
    p.table_v3([30, 320, 570, 320 + 26 * (len(rows) + 1)], [[('ITEM', 1), ('QTY', 1), ('GBP', 1)]], rows, [.7, .1, .2], rules='none',
               align=['left', 'right', 'right'], row_height=26, face='mono', size=15, header_face='mono-bold', pad=2)
    y = 320 + 26 * (len(rows) + 1) + 14
    for dx in range(30, 570, 16):
        p.line([dx, y + 9, dx + 8, y + 9], ink, 2)
    saving = 0.60
    tot_rows = [['SUBTOTAL', f'{total:.2f}'], ['PRICE MATCH SAVING', f'-{saving:.2f}'], ['TOTAL', f'{total - saving:.2f}'], ['CARD (CONTACTLESS)', f'{total - saving:.2f}'], ['CHANGE', '0.00']]
    p.table_v3([30, y + 30, 570, y + 30 + 30 * len(tot_rows)], [], tot_rows, [.7, .3], rules='none', align=['left', 'right'], row_height=30,
               face='mono', size=17, header_face='mono-bold', pad=2, row_roles=['data', 'data', 'total', 'data', 'data'])
    y = y + 30 + 30 * len(tot_rows) + 10
    for dx in range(30, 570, 16):
        p.line([dx, y + 9, dx + 8, y + 9], ink, 2)
    p.text(f'ITEMS {sum(int(i[1]) for i in items)}    VAT INCLUDED 0.29\nVISA DEBIT ************4417\nAUTH 09341C   AID A0000000031010\nPLEASE KEEP FOR YOUR RECORDS', 30, y + 26, 540, 15, 'mono', ink, leading=23, label='paragraph')
    y += 26 + 4 * 23 + 30
    p.barcode([120, y, 480, y + 90], '0030114211017423')
    y += 120
    p.text('Thank you for shopping locally.\nReturns accepted within 28 days with receipt.', 30, y, 540, 15, 'mono', ink, leading=23, label='footer')
    return p


def cafe_card_slip():
    p = PageV3('v3-receipt-cafe-card-slip', 560, 1010, cluster='v3-receipt-cafe-card-slip',
               features=['receipt', 'narrow-page', 'card-terminal-slip', 'qr-code', 'table-borderless', 'logo'],
               brief='Café bill with a printed card-terminal merchant copy: borderless order table, service line, terminal block, QR feedback code.',
               paper='#fbfaf6')
    ink = '#2b2b2b'
    p.rectangle([230, 28, 330, 88], '#5b3a29')
    p.text('LUMEN', 240, 46, 80, 22, 'sans-bold', '#fbfaf6', label=None)
    p.region('logo', [230, 28, 330, 88], None, kind='authored-wordmark-plate')
    p.line_text('Lumen Coffee Bar', 280, 104, 22, 'sans-bold', ink, align='center', label='header')
    p.line_text('2 Quay Street · Table 6 · Covers 2', 280, 138, 14, 'sans', ink, align='center', label='header')
    order = [('Flat white', '2', '6.80'), ('Oat cortado', '1', '3.20'), ('Almond croissant', '2', '7.00'), ('Shakshuka', '1', '9.50'), ('Sparkling water', '1', '2.20')]
    subtotal = sum(float(o[2]) for o in order)
    service = round(subtotal * .10, 2)
    p.table_v3([30, 180, 530, 180 + 30 * (len(order) + 1)], [[('Item', 1), ('Qty', 1), ('£', 1)]], [list(o) for o in order], [.66, .12, .22],
               rules='none', row_height=30, face='sans', size=16, pad=2)
    y = 180 + 30 * (len(order) + 1) + 10
    p.table_v3([30, y, 530, y + 3 * 30], [], [['Subtotal', f'{subtotal:.2f}'], ['Service 10% (optional)', f'{service:.2f}'], ['Total', f'{subtotal + service:.2f}']],
               [.7, .3], rules='none', row_height=30, face='sans', size=16, pad=2, row_roles=['data', 'data', 'total'])
    y += 3 * 30 + 26
    p.text('* * *  MERCHANT COPY  * * *', 30, y, 500, 15, 'mono', ink, label='paragraph')
    p.text(f'LUMEN COFFEE BAR\nMID ****2290  TID 7781\nSALE  CONTACTLESS\nMASTERCARD  ************0062\nAMOUNT          GBP {subtotal + service:.2f}\nNO CARDHOLDER VERIFICATION\nAUTH CODE 774120\n21/10/26  10:18:44', 30, y + 32, 500, 15, 'mono', ink, leading=24, label='paragraph', kind='card-terminal-block')
    y += 32 + 8 * 24 + 24
    qx, qy, cell = 200, y, 7
    import hashlib
    bits = bin(int(hashlib.sha256(b'lumen-feedback').hexdigest(), 16))[2:].zfill(256)
    n = 23
    for r in range(n):
        for c in range(n):
            origin = next(((r0, c0) for r0, c0 in ((0, 0), (0, n - 7), (n - 7, 0)) if r0 <= r < r0 + 7 and c0 <= c < c0 + 7), None)
            if origin:
                rr, cc = r - origin[0], c - origin[1]
                on = rr in (0, 6) or cc in (0, 6) or (2 <= rr <= 4 and 2 <= cc <= 4)
            else:
                on = bits[(r * n + c) % 256] == '1'
            if on:
                p.rectangle([qx + c * cell, qy + r * cell, qx + (c + 1) * cell, qy + (r + 1) * cell], '#111111')
    p.region('figure', [qx, qy, qx + n * cell, qy + n * cell], None, kind='qr-like-pattern', decodable=False, note='Authored QR-style pattern; not a decodable code.')
    p.text('Tell us how we did: scan the code', 30, qy + n * cell + 16, 500, 15, 'sans', ink, label='caption')
    p.text('VAT reg 401 7720 15 · Thank you!', 30, qy + n * cell + 60, 500, 13, 'sans', '#666666', label='footer')
    return p


def build():
    return [insurance_claim_filled(), allotment_application_unfilled(), grocery_receipt(), cafe_card_slip()]
