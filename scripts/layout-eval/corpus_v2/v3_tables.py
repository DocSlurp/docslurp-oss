"""V3 table-centred compositions: truly borderless multi-level tables and continued tables.

All entities and figures are fictional; totals are computed from the authored rows so
the arithmetic in every expected table is internally consistent.
"""
try:
    from .page_v3 import PageV3
except ImportError:
    from page_v3 import PageV3


def money(v):
    return f'({abs(v):,})' if v < 0 else f'{v:,}'


def annual_report_segments():
    p = PageV3('v3-borderless-segment-results', 1275, 1650, cluster='v3-borderless-segment-results',
               features=['table-borderless', 'multi-level-header', 'numeric-alignment', 'subtotal-rows', 'footnote', 'header', 'footer', 'two-column'],
               brief='Annual-report segment table with two header levels, indented stub, subtotals and footnotes; whitespace only, no rules or fills.',
               paper='#ffffff')
    ink = '#1d1d1b'
    p.text('LOWMOOR COOPERATIVE GROUP  ·  ANNUAL REPORT 2026', 80, 50, 800, 15, 'sans-bold', '#5b6770', label='header')
    p.text('Financial review', 1000, 50, 195, 15, 'sans', '#5b6770', label='header')
    p.text('Segment results', 80, 105, 1100, 40, 'palatino-bold', ink, label='title')
    p.text('Revenue grew in every trading segment, but the second half of 2026 shows the effect of higher input costs on food retail margins. Funeral services and the travel business were broadly stable. The table below restates 2025 for the transfer of pharmacy distribution into the wholesale segment.', 80, 170, 540, 18, 'palatino', '#333333', leading=27)
    p.text('Operating profit is shown before exceptional items and member dividend. Segment totals include central cost allocations; group totals also include unallocated property income, which is reported separately in note 9.', 655, 170, 540, 18, 'palatino', '#333333', leading=27)
    p.text('Table 3. Revenue and operating profit by segment, £000', 80, 345, 1100, 19, 'sans-bold', ink, label='caption')
    segments = [('Food retail', [(412_300, 418_950), (16_410, 13_880)]), ('Wholesale', [(96_120, 104_470), (3_905, 4_620)]),
                ('Funeral services', [(58_740, 60_215), (7_310, 7_090)]), ('Travel', [(22_015, 22_980), (1_120, 1_265)])]
    rows, roles, indent = [], [], []
    for heading, label in (('Revenue', 0), ('Operating profit', 1)):
        rows.append([heading, '', '', '', '']); roles.append('section'); indent.append(0)
        tot = [0, 0]
        for name, figures in segments:
            a, b = figures[label]
            tot[0] += a; tot[1] += b
            change = round((b - a) / a * 100, 1)
            rows.append([name, money(a), money(b), money(b - a), f'{change:+.1f}']); roles.append('data'); indent.append(18)
        rows.append([f'Total {heading.lower()}', money(tot[0]), money(tot[1]), money(tot[1] - tot[0]), f'{(tot[1] - tot[0]) / tot[0] * 100:+.1f}'])
        roles.append('subtotal'); indent.append(0)
    p.table_v3([80, 385, 1195, 385 + 2 * 34 + len(rows) * 33], [[('', 1), ('Year to 31 December', 2), ('Change', 2)], [('Segment', 1), ('2025¹', 1), ('2026', 1), ('£000²', 1), ('%', 1)]],
               rows, [.36, .16, .16, .17, .15], rules='none', row_height=33, header_height=34, face='sans', size=16, row_roles=roles, indent=indent)
    y = 385 + 2 * 34 + len(rows) * 33 + 22
    p.text('¹ Restated for the transfer of pharmacy distribution from food retail to wholesale (revenue £7,940k; operating profit £310k).\n² Negative amounts are shown in brackets. Percentages are calculated on unrounded figures.', 80, y, 1100, 14, 'sans', '#555555', leading=21, label='footnote')
    p.text('Food retail margin', 80, 1010, 540, 24, 'palatino-bold', ink, label='title')
    p.text('Food retail operating margin fell from 4.0% to 3.3%. Most of the reduction came in the third quarter, when price commitments on 400 everyday lines held shelf prices below the rise in supplier costs. Store energy costs fell for the first time in four years and partly offset the decline.', 80, 1055, 540, 18, 'palatino', '#333333', leading=27)
    p.text('Outlook', 655, 1010, 540, 24, 'palatino-bold', ink, label='title')
    p.text('We expect revenue growth to slow in 2027 as price inflation eases. Investment will concentrate on refitting 38 convenience stores and on the new chilled distribution centre, which is scheduled to open in the spring.', 655, 1055, 540, 18, 'palatino', '#333333', leading=27)
    margins = {name: [round(figs[1][i] / figs[0][i] * 100, 1) for i in (0, 1)] for name, figs in segments}
    p.chart_v3([80, 1230, 1195, 1520], 'grouped-bar', list(margins), {'2025': [v[0] for v in margins.values()], '2026': [v[1] for v in margins.values()]},
               title='Operating margin by segment, %', y_label='% of revenue', colors=['#9fb3c8', '#1f4e79'], value_labels=True, panel='#f6f7f8')
    p.text('Lowmoor Cooperative Group is a fictional organisation; this page is an authored layout specimen.', 80, 1560, 900, 13, 'sans', '#777777', label='footer')
    p.text('41', 1160, 1556, 35, 18, 'palatino', '#333333', label='footer')
    return p


def statistical_abstract():
    p = PageV3('v3-borderless-household-tenure', 1240, 1754, cluster='v3-borderless-household-tenure',
               features=['table-borderless', 'multi-level-header', 'three-header-levels', 'stub-indent', 'empty-cells', 'notes', 'header', 'footer'],
               brief='Statistical-abstract page: three-level header (tenure/sector/year), indented regional stub, authored empty cells, notes and source line; no rules.',
               paper='#fdfdfb')
    ink = '#222222'
    p.text('REGIONAL STATISTICS DIGEST 2026', 70, 48, 700, 15, 'gothic-bold', '#555555', label='header')
    p.text('Chapter 4  Housing', 900, 48, 270, 15, 'gothic', '#555555', label='header')
    p.text('4.2  Households by tenure', 70, 110, 1100, 34, 'century-bold', ink, label='title')
    p.text('Households counted at the 2015 and 2025 censuses, thousands. Social renting covers housing association and council tenancies; private renting includes tenancies through a letting agent and rent-free arrangements.', 70, 165, 1100, 17, 'century', '#444444', leading=26)
    regions = [('North Vale', None, [(212.4, 219.8), (61.0, 58.7), (38.2, 51.6)]), ('Harwick city', 1, [(88.1, 87.4), (40.3, 39.9), (29.5, 41.0)]),
               ('Rural districts', 1, [(124.3, 132.4), (20.7, 18.8), (8.7, 10.6)]), ('South Coast', None, [(301.7, 312.0), (55.4, 56.1), (72.9, 90.3)]),
               ('Port Selby', 1, [(96.2, 98.9), (25.8, 26.3), (40.1, 51.7)]), ('Coastal towns', 1, [(205.5, 213.1), (29.6, 29.8), (32.8, 38.6)]),
               ('Eastern Fens', None, [(140.9, 149.2), (22.6, 22.0), (19.4, 24.9)]), ('Islands', None, [(9.8, 10.1), (2.1, 2.2), (None, 1.3)])]
    rows, indent = [], []
    for name, level, figs in regions:
        cells = [name]
        for a, b in figs:
            cells += ['' if a is None else f'{a:.1f}', f'{b:.1f}']
        rows.append(cells); indent.append(22 if level else 0)
    totals = ['All regions']
    for col in range(6):
        values = [r[1 + col] for r, (_, level, _) in zip(rows, regions) if level is None]
        totals.append(f'{sum(float(v) for v in values if v):.1f}')
    rows.append(totals); indent.append(0)
    roles = ['data'] * len(regions) + ['total']
    top = 260
    p.table_v3([70, top, 1170, top + 3 * 32 + len(rows) * 36],
               [[('', 1), ('Owner-occupied', 2), ('Rented', 4)], [('', 1), ('', 2), ('Social', 2), ('Private', 2)],
                [('Area', 1), ('2015', 1), ('2025', 1), ('2015', 1), ('2025', 1), ('2015', 1), ('2025', 1)]],
               rows, [.28, .12, .12, .12, .12, .12, .12], rules='none', row_height=36, header_height=32, face='century', size=17,
               header_face='century-bold', row_roles=roles, indent=indent)
    y = top + 3 * 32 + len(rows) * 36 + 30
    p.text('Notes', 70, y, 300, 17, 'century-bold', ink, label='title')
    p.text('1. Harwick city and Rural districts are components of North Vale; Port Selby and Coastal towns are components of South Coast. Totals sum the four regions only.\n2. Island private renting was not separately published in 2015 and is left blank; it is included in the owner-occupied figure for that year.\n3. Figures may not sum because of rounding.', 70, y + 34, 1100, 15, 'century', '#444444', leading=24, label='list')
    p.text('Source: fictional regional census tables, authored for a layout test.', 70, y + 170, 1100, 15, 'century-italic', '#555555', label='caption')
    p.text('Private renting grew in every area with published figures, fastest in Harwick city, where privately rented households rose by almost two fifths. Social renting was close to flat. Owner occupation still accounts for about two thirds of households in the digest area, but its share fell in each of the urban areas.', 70, y + 230, 1100, 18, 'century', '#333333', leading=28)
    growth = [(name, round((figs[2][1] - figs[2][0]) / figs[2][0] * 100, 1)) for name, _, figs in regions if figs[2][0]]
    p.text('Figure 4.2  Change in privately rented households, 2015 to 2025', 70, y + 345, 1100, 17, 'century-bold', ink, label='caption')
    p.chart_v3([70, y + 380, 1170, y + 380 + 36 * len(growth) + 40], 'hbar', [g[0] for g in growth], {'Change, %': [g[1] for g in growth]},
               unit='%', colors=['#7a5c3e'], panel='#f7f4ee', face='century', size=16)
    p.text('Regional Statistics Digest 2026', 70, 1680, 600, 14, 'gothic', '#666666', label='footer')
    p.text('57', 1130, 1676, 40, 17, 'century', '#333333', label='footer')
    return p


MANIFEST_ITEMS = [
    ('C-2207', 'Pallet', 'Ceramic floor tiles, 600 × 600 mm', 42, 1_260.0), ('C-2208', 'Pallet', 'Tile adhesive, 20 kg bags', 30, 615.0),
    ('C-2209', 'Crate', 'Stainless sink units', 12, 384.5), ('C-2210', 'Carton', 'Mixer taps, chrome', 96, 211.2),
    ('C-2211', 'Pallet', 'Plasterboard 12.5 mm', 60, 1_530.0), ('C-2212', 'Bundle', 'Timber battens 38 × 50 mm', 25, 470.0),
    ('C-2213', 'Carton', 'LED panel lights 600 mm', 80, 248.0), ('C-2214', 'Drum', 'Primer, water-based, 25 L', 16, 432.0),
    ('C-2215', 'Pallet', 'Insulation rolls 100 mm', 36, 396.0), ('C-2216', 'Crate', 'Shower trays, stone resin', 10, 520.0),
    ('C-2217', 'Carton', 'Door handles, satin', 140, 168.0), ('C-2218', 'Pallet', 'Cement, 25 kg bags', 48, 1_212.0),
    ('C-2219', 'Bundle', 'Copper pipe 15 mm × 3 m', 40, 214.4), ('C-2220', 'Carton', 'Pipe fittings, assorted', 64, 153.6),
    ('C-2221', 'Pallet', 'Floor screed, 25 kg bags', 40, 1_010.0), ('C-2222', 'Crate', 'Radiators, double panel', 14, 588.0),
    ('C-2223', 'Carton', 'Thermostatic valves', 120, 108.0), ('C-2224', 'Pallet', 'Paving slabs 450 × 450', 30, 1_620.0),
    ('C-2225', 'Drum', 'Wood stain, 5 L', 24, 132.0), ('C-2226', 'Carton', 'Extractor fans', 18, 99.0),
    ('C-2227', 'Pallet', 'Roof tiles, clay', 28, 1_456.0), ('C-2228', 'Bundle', 'Skirting board 2.4 m', 50, 360.0),
    ('C-2229', 'Carton', 'Smoke alarms', 60, 42.0), ('C-2230', 'Crate', 'Kitchen worktops 3 m', 8, 344.0),
    ('C-2231', 'Pallet', 'Sand, bulk bags', 6, 5_100.0), ('C-2232', 'Carton', 'Silicone sealant', 200, 64.0),
    ('C-2233', 'Pallet', 'Engineering bricks', 20, 2_680.0), ('C-2234', 'Carton', 'Wall anchors, assorted', 75, 90.0),
    ('C-2235', 'Crate', 'Cast iron bath', 3, 381.0), ('C-2236', 'Bundle', 'Steel lintels 1.2 m', 18, 342.0),
    ('C-2237', 'Carton', 'Light switches, white', 150, 75.0), ('C-2238', 'Pallet', 'Breeze blocks', 24, 2_496.0),
    ('C-2239', 'Drum', 'Damp-proof liquid, 20 L', 12, 264.0), ('C-2240', 'Carton', 'Cable, twin and earth 100 m', 30, 330.0),
    ('C-2241', 'Pallet', 'Gravel, bulk bags', 4, 3_400.0), ('C-2242', 'Crate', 'Toilet pans, close-coupled', 16, 432.0),
    ('C-2243', 'Carton', 'Grout, grey, 5 kg', 64, 332.8), ('C-2244', 'Bundle', 'Decking boards 3.6 m', 40, 640.0),
]


def freight_manifest(page):
    first = MANIFEST_ITEMS[:29]
    rest = MANIFEST_ITEMS[29:]
    p = PageV3(f'v3-cargo-manifest-0{page}', 1240, 1754, cluster='v3-cargo-manifest', document_id='v3-cargo-manifest', page_number=page,
               features=['continued-table', 'repeated-header', 'carried-forward-total', 'table-horizontal-rules', 'key-value-block', 'header', 'footer'],
               brief='Two-page cargo manifest: page 1 ends with carried-forward totals, page 2 repeats the header and opens with brought-forward totals.',
               paper='#fcfcf9')
    ink = '#1f2328'
    p.text('NORTHSEA SHORT-SEA LINES', 70, 46, 700, 22, 'sans-bold', '#0e4a6b', label='header')
    p.text(f'Cargo manifest  ·  Voyage NS-118  ·  Page {page} of 2', 760, 52, 410, 15, 'sans', '#444444', label='header')
    p.line([70, 90, 1170, 90], '#0e4a6b', 2)
    if page == 1:
        p.text('Cargo manifest', 70, 115, 800, 38, 'sans-bold', ink, label='title')
        kv = [('Vessel', 'MV Selby Trader'), ('Port of loading', 'Grimsby, Berth 4'), ('Port of discharge', 'Rotterdam, Waalhaven'),
              ('Sailing date', '14 October 2026'), ('Shipper', 'Harland Building Supplies Ltd'), ('Consignee', 'Van Dijk Bouwmaterialen BV')]
        y = 185
        for i, (k, v) in enumerate(kv):
            x = 70 if i % 2 == 0 else 640
            p.text(k, x, y, 200, 14, 'sans', '#666666', label=None)
            p.text(v, x + 200, y - 1, 320, 16, 'sans-bold', ink, label=None)
            if i % 2:
                y += 34
        p.region('form', [70, 183, 1170, y - 4], None, form_state='filled-printed', kind='key-value-shipment-block')
        table_top = y + 30
    else:
        p.text('Cargo manifest (continued)', 70, 115, 800, 30, 'sans-bold', ink, label='title')
        table_top = 180
    header = [[('Mark', 1), ('Package', 1), ('Description of goods', 1), ('Qty', 1), ('Gross kg', 1)]]
    widths = [.13, .13, .46, .12, .16]
    align = ['left', 'left', 'left', 'right', 'right']
    rows, roles = [], []
    if page == 1:
        items, offset = first, 0
    else:
        items, offset = rest, len(first)
        bf_qty = sum(i[3] for i in first); bf_kg = sum(i[4] for i in first)
        rows.append(['', '', 'Brought forward from page 1', f'{bf_qty:,}', f'{bf_kg:,.1f}']); roles.append('brought-forward')
    for mark, pkg, desc, qty, kg in items:
        rows.append([mark, pkg, desc, f'{qty:,}', f'{kg:,.1f}']); roles.append('data')
    if page == 1:
        rows.append(['', '', 'Carried forward to page 2', f'{sum(i[3] for i in first):,}', f'{sum(i[4] for i in first):,.1f}']); roles.append('carried-forward')
    else:
        rows.append(['', '', 'Manifest total', f'{sum(i[3] for i in MANIFEST_ITEMS):,}', f'{sum(i[4] for i in MANIFEST_ITEMS):,.1f}']); roles.append('total')
    row_h = 40
    p.table_v3([70, table_top, 1170, table_top + row_h * (len(rows) + 1)], header, rows, widths, rules='horizontal', align=align, row_height=row_h,
               face='sans', size=16, row_roles=roles, continuation_id='v3-cargo-manifest-items', row_offset=offset, rule_color='#9aa5ad',
               header_fill='#e4edf2')
    y = table_top + row_h * (len(rows) + 1) + 30
    if page == 1:
        p.text('Package marks are stencilled on two sides. Quantities are counts of packages, not units inside each package.', 70, y, 1100, 15, 'sans', '#555555', label='footnote')
    else:
        p.text('Declarations', 70, y, 400, 20, 'sans-bold', ink, label='title')
        p.text('We certify that the goods listed are correctly described, packed and marked, and are in proper condition for carriage. No dangerous goods are included in this consignment.', 70, y + 36, 1100, 17, 'sans', '#333333', leading=26)
        sy = y + 130
        for x, cap in ((70, 'For the shipper'), (640, 'For the carrier')):
            p.line([x, sy + 50, x + 460, sy + 50], '#333333', 1)
            p.text(cap, x, sy + 60, 460, 14, 'sans', '#555555', label=None)
            p.text('Name, signature and date', x, sy + 82, 460, 12, 'sans', '#888888', label=None)
        p.region('form', [70, sy, 1170, sy + 100], None, form_state='unfilled', kind='signature-block')
    p.line([70, 1660, 1170, 1660], '#bbbbbb', 1)
    p.text('Northsea Short-Sea Lines is fictional. Authored layout specimen; not a transport document.', 70, 1675, 900, 13, 'sans', '#777777', label='footer')
    return p


RESULTS = [
    ('pH', '—', (7.4, 7.9), (7.1, 7.6), '6.5–9.5'), ('Conductivity', 'µS/cm', (412, 455), (388, 430), '2500'),
    ('Turbidity', 'NTU', (0.21, 0.48), (0.35, 0.92), '1.0'), ('Colour', 'mg/L Pt/Co', (2, 4), (3, 6), '15'),
    ('Total hardness', 'mg/L CaCO₃', (188, 205), (171, 190), 'no limit'), ('Nitrate', 'mg/L NO₃', (14.2, 18.9), (22.6, 31.4), '50'),
    ('Nitrite', 'mg/L NO₂', (0.01, 0.02), (0.02, 0.05), '0.5'), ('Ammonium', 'mg/L NH₄', (0.03, 0.06), (0.05, 0.11), '0.5'),
    ('Chloride', 'mg/L', (38, 44), (41, 52), '250'), ('Sulphate', 'mg/L', (52, 61), (47, 58), '250'),
    ('Sodium', 'mg/L', (21, 26), (24, 30), '200'), ('Iron', 'µg/L', (18, 42), (35, 96), '200'),
    ('Manganese', 'µg/L', (2, 5), (6, 21), '50'), ('Aluminium', 'µg/L', (11, 19), (14, 28), '200'),
    ('Copper', 'mg/L', (0.04, 0.09), (0.06, 0.18), '2.0'), ('Lead', 'µg/L', (0.6, 1.4), (1.1, 3.8), '10'),
    ('Fluoride', 'mg/L', (0.11, 0.14), (0.09, 0.12), '1.5'), ('Free chlorine', 'mg/L', (0.32, 0.51), (0.18, 0.40), 'no limit'),
    ('Coliform bacteria', 'per 100 mL', (0, 0), (0, 1), '0'), ('E. coli', 'per 100 mL', (0, 0), (0, 0), '0'),
    ('Enterococci', 'per 100 mL', (0, 0), (0, 0), '0'), ('Colony count 22 °C', 'per mL', (3, 12), (5, 31), 'no abnormal change'),
    ('Trihalomethanes', 'µg/L', (18, 27), (22, 39), '100'), ('Bromate', 'µg/L', (1.2, 2.0), (0.9, 1.6), '10'),
    ('Odour', 'dilution no.', (0, 1), (0, 1), '3'), ('Taste', 'dilution no.', (0, 1), (0, 1), '3'),
    ('Clostridium perfringens', 'per 100 mL', (0, 0), (0, 0), '0'), ('Total organic carbon', 'mg/L C', (1.9, 2.6), (0.8, 1.3), 'no abnormal change'),
    ('Antimony', 'µg/L', (0.2, 0.4), (0.3, 0.6), '5'), ('Arsenic', 'µg/L', (0.5, 0.9), (1.4, 2.7), '10'),
    ('Boron', 'mg/L', (0.02, 0.03), (0.04, 0.06), '1.0'), ('Cadmium', 'µg/L', (0.03, 0.05), (0.04, 0.08), '5'),
    ('Chromium', 'µg/L', (0.4, 0.8), (0.6, 1.1), '50'), ('Mercury', 'µg/L', (0.01, 0.02), (0.01, 0.02), '1.0'),
    ('Nickel', 'µg/L', (1.1, 2.4), (1.8, 4.9), '20'), ('Selenium', 'µg/L', (0.2, 0.3), (0.5, 0.9), '10'),
    ('Benzene', 'µg/L', (0.05, 0.05), (0.05, 0.06), '1.0'), ('Benzo(a)pyrene', 'µg/L', (0.001, 0.002), (0.001, 0.001), '0.010'),
    ('Pesticides, total', 'µg/L', (0.02, 0.07), (0.03, 0.11), '0.50'), ('Tetrachloroethene', 'µg/L', (0.1, 0.2), (0.3, 0.6), '10'),
    ('Vinyl chloride', 'µg/L', (0.02, 0.03), (0.02, 0.03), '0.50'), ('Gross alpha', 'Bq/L', (0.02, 0.04), (0.05, 0.08), '0.1'),
]


def water_quality(page):
    split = 32
    p = PageV3(f'v3-water-quality-annex-0{page}', 1240, 1754, cluster='v3-water-quality-annex', document_id='v3-water-quality-annex', page_number=page,
               features=['continued-table', 'repeated-header', 'multi-level-header', 'table-booktabs', 'units-column', 'header', 'footer'],
               brief='Two-page technical annex: booktabs table with two-level site/statistic header, continued with repeated header and "(continued)" caption.',
               paper='#ffffff')
    ink = '#1c2321'
    p.text('Annual drinking water quality report 2026', 70, 48, 700, 14, 'noto-sans', '#5d6b68', label='header')
    p.text(f'Annex B  ·  {page + 23}', 1000, 48, 170, 14, 'noto-sans', '#5d6b68', label='header')
    if page == 1:
        p.text('Annex B  Treated water results by supply zone', 70, 100, 1100, 30, 'noto-serif-bold', ink, label='title')
        p.text('Samples were taken at customer taps in each zone between 1 January and 31 December 2026. The table gives the mean and maximum of all samples for each parameter, alongside the regulatory limit. Results above a limit would be highlighted; none occurred in 2026.', 70, 155, 1100, 17, 'noto-serif', '#333333', leading=27)
        p.text('Table B1  Results for Hollins Reservoir zone (A) and Brookside wells zone (B)', 70, 265, 1100, 17, 'noto-sans-bold', ink, label='caption')
        top = 300
        items = RESULTS[:split]
        offset = 0
    else:
        p.text('Table B1 (continued)', 70, 100, 1100, 17, 'noto-sans-bold', ink, label='caption')
        top = 135
        items = RESULTS[split:]
        offset = split
    header = [[('', 1), ('', 1), ('Zone A', 2), ('Zone B', 2), ('', 1)], [('Parameter', 1), ('Units', 1), ('Mean', 1), ('Max', 1), ('Mean', 1), ('Max', 1), ('Limit', 1)]]
    rows = [[name, unit, f'{a[0]}', f'{a[1]}', f'{b[0]}', f'{b[1]}', limit] for name, unit, a, b, limit in items]
    row_h = 38
    p.table_v3([70, top, 1170, top + 2 * 34 + len(rows) * row_h], header, rows, [.24, .17, .1, .1, .1, .1, .19], rules='booktabs',
               align=['left', 'left', 'right', 'right', 'right', 'right', 'right'], row_height=row_h, header_height=34, face='noto-sans', size=16,
               header_face='noto-sans-bold', continuation_id='v3-water-quality-B1', row_offset=offset, rule_color='#2b2b2b')
    y = top + 2 * 34 + len(rows) * row_h + 26
    if page == 1:
        p.text('Table continues on the next page.', 870, y, 300, 14, 'noto-serif-italic', '#555555', label='footnote')
    else:
        p.text('Microbiological limits are zero per 100 mL; a single positive coliform sample in zone B on 3 August was investigated, resampled and found clear. "no limit" means no numerical standard applies; the parameter is monitored as an indicator.', 70, y, 1100, 15, 'noto-serif', '#444444', leading=24, label='footnote')
        p.text('What the results mean', 70, y + 110, 1100, 22, 'noto-serif-bold', ink, label='title')
        p.text('Water in both zones met every standard throughout the year. Zone B, supplied from groundwater, has higher nitrate and manganese than the upland reservoir zone, which is typical of its geology. Nitrate remained well below the limit; we continue to blend water from the two sources during late summer, when groundwater nitrate peaks.', 70, y + 150, 1100, 17, 'noto-serif', '#333333', leading=27)
    p.line([70, 1660, 1170, 1660], '#cccccc', 1)
    p.text('Fictional water company; authored layout specimen. Values are illustrative and not measurements.', 70, 1675, 900, 13, 'noto-sans', '#777777', label='footer')
    return p


def build():
    return [annual_report_segments(), statistical_abstract(), freight_manifest(1), freight_manifest(2), water_quality(1), water_quality(2)]
