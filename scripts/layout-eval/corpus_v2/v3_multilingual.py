"""V3 non-Latin and RTL compositions. Real fonts, logical Unicode, libraqm shaping.

All organisations, people, phone numbers and figures are fictional. Copy is newly
authored for layout evaluation; no publication is reproduced.
"""
try:
    from .page_v3 import PageV3
except ImportError:
    from page_v3 import PageV3

TYPO = {'shaping': 'Pillow with libraqm; logical-order Unicode text with explicit direction/language; no manual glyph reversal',
        'glyph_guard': 'page_v3.missing_glyphs checks every text block against the font cmap before raster',
        'font_binaries_bundled': False, 'font_license': 'Noto fonts SIL OFL 1.1 (/usr/share/licenses/noto-fonts, noto-fonts-cjk); Liberation fonts SIL OFL 1.1 (/usr/share/licenses/ttf-liberation)'}


def hebrew_clinic_newsletter():
    p = PageV3('v3-he-clinic-newsletter', 1240, 1754, cluster='v3-he-clinic-newsletter',
               features=['rtl', 'hebrew', 'two-column', 'rtl-table', 'logo', 'list', 'footer', 'sidebar'],
               brief='Hebrew community-clinic newsletter: RTL masthead, two RTL prose columns, RTL hours table, list, footer.',
               paper='#fbfaf6')
    p.source['provenance']['typography'] = TYPO
    he = dict(direction='rtl', language='he')
    teal = '#13606b'
    # logo (right side for RTL masthead)
    p.ellipse([1080, 46, 1170, 136], teal)
    p.rectangle([1117, 66, 1133, 116], '#ffffff')
    p.rectangle([1100, 83, 1150, 99], '#ffffff')
    p.region('logo', [1080, 46, 1170, 136], None, kind='authored-cross-mark', wordmark=None)
    p.text('מרפאת השכונה – גבעת הזיתים', 560, 58, 500, 34, 'lib-sans-bold', teal, label='header', **he)
    p.text('עלון קהילתי · גיליון 14 · סתיו', 560, 108, 500, 20, 'lib-sans', '#4c5a58', label='header', **he)
    p.line([70, 160, 1170, 160], teal, 3)
    p.text('חיסוני שפעת לכל המשפחה', 70, 190, 1100, 54, 'lib-serif-bold', '#1d2b2a', label='title', **he)
    p.text('השנה נפתח את עונת החיסונים מוקדם יותר, עם שעות קבלה מורחבות בערב ובימי שישי.', 70, 268, 1100, 25, 'lib-serif', '#3c4a48', leading=36, **he)
    # two RTL columns: the right column is read first
    col_w = 520
    right_x, left_x = 650, 70
    y = 360
    p.text('למה עכשיו?', right_x, y, col_w, 26, 'lib-sans-bold', teal, label='title', **he)
    y = p.text('נגיף השפעת מתחיל להתפשט בדרך כלל עם הירידה בטמפרטורות. החיסון מגיע ליעילות מלאה כשבועיים לאחר מתן הזריקה, ולכן מומלץ להתחסן לפני שהמחלה נפוצה בגנים ובבתי הספר. החיסון מתאים לרוב האנשים מגיל חצי שנה ומעלה.', right_x, y + 46, col_w, 21, 'lib-serif', '#273332', leading=33, **he)
    y = p.text('מי צריך להקדים?', right_x, y + 26, col_w, 26, 'lib-sans-bold', teal, label='title', **he)
    y = p.text('• בני 65 ומעלה\n• נשים בהריון\n• ילדים עם אסתמה או מחלה כרונית\n• צוותי חינוך ובריאות', right_x, y + 18, col_w, 21, 'lib-sans', '#273332', leading=36, label='list', **he)
    y = p.text('אין צורך להגיע בצום ואין צורך במכתב מהרופא. כדאי להביא כרטיס קופה ולהגיע בבגד עם שרוול קצר.', right_x, y + 22, col_w, 21, 'lib-serif', '#273332', leading=33, **he)
    p.line([620, 360, 620, 1180], '#b9c6c3', 1)
    ly = 360
    ly = p.text('תורים והגעה', left_x, ly, col_w, 26, 'lib-sans-bold', teal, label='title', **he)
    ly = p.text('אפשר לקבוע תור באפליקציה, בטלפון או בדלפק הקבלה. בימי שישי תתקיים קבלה ללא תור עד השעה 12:30, כל עוד יש מנות זמינות.', left_x, ly + 18, col_w, 21, 'lib-serif', '#273332', leading=33, **he)
    p.table_v3([left_x, ly + 30, left_x + col_w, ly + 30 + 6 * 40], [[('יום', 1), ('בוקר', 1), ('ערב', 1)]],
               [['ראשון', '08:00–12:00', '16:00–19:00'], ['שני', '08:00–12:00', '—'], ['שלישי', '08:00–12:00', '16:00–20:00'],
                ['רביעי', '08:00–12:00', '—'], ['שישי', '08:00–12:30', '—']],
               [.3, .35, .35], rules='horizontal', align=['left', 'center', 'center'], row_height=40, face='lib-sans', size=19,
               header_face='lib-sans-bold', direction='rtl', language='he', rule_color='#8aa29e')
    ty = ly + 30 + 6 * 40 + 18
    p.text('השעות נכונות לחודשים תשרי–כסלו ועשויות להשתנות בחגים.', left_x, ty, col_w, 17, 'lib-sans', '#5b6866', label='caption', **he)
    p.rectangle([left_x, ty + 60, left_x + col_w, ty + 330], '#fdf3e1')
    p.text('דרושים מתנדבים', left_x + 20, ty + 80, col_w - 40, 24, 'lib-sans-bold', '#8a5a12', label='title', **he)
    p.text('אנחנו מחפשים מתנדבים לעזרה בקבלת הקהל בימי שישי: הכוונה בתור, חלוקת מספרים ועזרה לקשישים. אפשר להתנדב לשעתיים בלבד.', left_x + 20, ty + 125, col_w - 40, 20, 'lib-serif', '#3a2c12', leading=31, **he)
    p.text('לפרטים: רונית, בטלפון 03-5550152', left_x + 20, ty + 260, col_w - 40, 19, 'lib-sans-bold', '#3a2c12', label='paragraph', **he)
    p.rectangle([70, 1220, 1170, 1460], '#e6f0ee')
    p.text('שאלות נפוצות', 100, 1245, 1040, 24, 'lib-sans-bold', teal, label='title', **he)
    p.text('האם אפשר לקבל חיסון שפעת וחיסון קורונה באותו ביקור? כן, ברוב המקרים אפשר לקבל את שניהם באותו יום, בשתי זרועות שונות. אם הייתה לכם תגובה חריפה לחיסון בעבר, ספרו על כך לאחות לפני מתן הזריקה.', 100, 1290, 1040, 20, 'lib-serif', '#273332', leading=32, **he)
    p.line([70, 1600, 1170, 1600], teal, 1)
    p.text('מרפאת השכונה · רחוב הזית 7 · טלפון 03-5550147 · העלון מופץ לתושבי השכונה בלבד', 70, 1620, 1100, 17, 'lib-sans', '#4c5a58', label='footer', **he)
    p.text('2', 70, 1660, 30, 18, 'sans', '#4c5a58', label='footer')
    return p


def hindi_bank_deposit_form():
    p = PageV3('v3-hi-en-bank-deposit-form', 1240, 1754, cluster='v3-hi-en-bank-deposit-form',
               features=['devanagari', 'bilingual', 'form-unfilled', 'checkbox', 'logo', 'table-grid', 'footer'],
               brief='Unfilled bilingual Hindi/English deposit slip: stacked Hindi-over-English captions, checkboxes, grid denomination table.',
               paper='#fdfcf7')
    p.source['provenance']['typography'] = {**TYPO, 'bilingual_policy': 'Hindi (Noto Devanagari) and English (Nimbus Sans) are separate text blocks; no single block mixes scripts because the Devanagari face has no Latin glyphs.'}
    hi = dict(language='hi')
    navy = '#1f3a68'
    grey = '#555555'

    def caption(x, y, hindi, english, width=480):
        p.text(hindi, x, y, width, 17, 'deva', grey, label=None, **hi)
        p.text(english, x, y + 27, width, 13, 'sans', '#777777', label=None)
        return y + 27 + 13

    def blank(x, y, width, hindi, english):
        bottom = caption(x, y, hindi, english, width)
        p.line([x, bottom + 34, x + width, bottom + 34], '#444444', 1)
        return bottom + 34

    p.rectangle([70, 50, 150, 130], navy)
    p.ellipse([88, 68, 132, 112], '#f2b134')
    p.region('logo', [70, 50, 150, 130], None, kind='authored-sun-mark')
    p.text('सहकारी ग्रामीण बैंक', 170, 52, 600, 34, 'deva-bold', navy, label='header', **hi)
    p.text('SAHKARI GRAMIN BANK  ·  Branch: Navapur Road', 170, 104, 700, 18, 'sans-bold', '#4d5b70', label='header')
    p.text('जमा पर्ची', 70, 165, 600, 42, 'deva-bold', '#18263f', label='title', **hi)
    p.text('DEPOSIT SLIP', 70, 228, 600, 24, 'sans-bold', '#18263f', label='title')
    p.text('कृपया बड़े अक्षरों में भरें। नकद और चेक के लिए अलग-अलग पर्ची का प्रयोग करें।', 70, 272, 1100, 19, 'deva', '#3c475a', leading=30, **hi)
    p.text('Please complete in block letters. Use separate slips for cash and cheques.', 70, 306, 1100, 16, 'sans', '#3c475a')
    form_top = 350
    y = form_top + 24
    blank(100, y, 480, 'दिनांक', 'Date')
    blank(640, y, 500, 'शाखा कोड', 'Branch code')
    y += 112
    blank(100, y, 1040, 'खाताधारक का नाम', 'Account holder name')
    y += 112
    blank(100, y, 640, 'खाता संख्या', 'Account number')
    blank(800, y, 340, 'मोबाइल नंबर', 'Mobile number')
    y += 118
    caption(100, y, 'खाते का प्रकार', 'Account type')
    x = 100
    for hindi, english in (('बचत', 'Savings'), ('चालू', 'Current'), ('आवर्ती जमा', 'Recurring deposit'), ('ऋण', 'Loan')):
        p.checkbox(x, y + 64)
        p.text(hindi, x + 28, y + 60, 200, 17, 'deva', '#333333', label=None, **hi)
        p.text(english, x + 28, y + 88, 200, 13, 'sans', '#777777', label=None)
        x += 255
    y += 130
    p.text('नकद विवरण', 100, y, 400, 19, 'deva-bold', navy, label=None, **hi)
    p.text('Cash denomination', 240, y + 6, 300, 15, 'sans-bold', navy, label=None)
    rows = [['2000', '×', '', ''], ['500', '×', '', ''], ['200', '×', '', ''], ['100', '×', '', ''], ['50', '×', '', ''], ['सिक्के', '', '', ''], ['कुल', '', '', '']]
    table_top = y + 44
    p.table_v3([100, table_top, 760, table_top + 8 * 42], [[('मूल्य (₹)', 1), ('', 1), ('संख्या', 1), ('राशि (₹)', 1)]],
               rows, [.30, .10, .26, .34], rules='grid', align=['left', 'center', 'right', 'right'], row_height=42, face='deva', size=17,
               header_face='deva-bold', row_roles=['data'] * 6 + ['total'], language='hi', rule_color='#7d8ba3')
    p.rectangle([800, table_top, 1140, table_top + 336], '#f1f4f9')
    caption(820, table_top + 16, 'राशि शब्दों में', 'Amount in words', 300)
    p.line([820, table_top + 120, 1120, table_top + 120], '#444444', 1)
    p.line([820, table_top + 170, 1120, table_top + 170], '#444444', 1)
    caption(820, table_top + 210, 'जमाकर्ता के हस्ताक्षर', 'Depositor signature', 300)
    p.line([820, table_top + 316, 1120, table_top + 316], '#444444', 1)
    y = table_top + 370
    p.text('केवल बैंक उपयोग हेतु', 100, y, 400, 17, 'deva-bold', grey, label=None, **hi)
    p.text('For bank use only', 290, y + 4, 300, 14, 'sans-bold', grey, label=None)
    p.rectangle([100, y + 36, 1140, y + 136], None, outline='#9aa6ba', width=1)
    caption(120, y + 50, 'कैशियर', 'Cashier', 300)
    caption(470, y + 50, 'स्क्रॉल संख्या', 'Scroll no.', 300)
    caption(840, y + 50, 'मुहर', 'Stamp', 250)
    form_bottom = y + 160
    p.rectangle([70, form_top, 1170, form_bottom], None, outline='#7d8ba3', width=2)
    p.region('form', [70, form_top, 1170, form_bottom], None, form_state='unfilled', field_policy='captions/rules/checkboxes are internal form components; the denomination grid is also a nested table region')
    y = form_bottom + 36
    p.text('निर्देश', 70, y, 300, 22, 'deva-bold', navy, label='title', **hi)
    p.text('1. ₹50,000 से अधिक नकद जमा करने पर पैन कार्ड की प्रति आवश्यक है।\n2. पर्ची में काट-छाँट होने पर नई पर्ची भरें।\n3. पासबुक में राशि दर्ज होने तक प्रतिपर्ण सँभालकर रखें।', 70, y + 44, 1100, 18, 'deva', '#3c475a', leading=32, label='list', **hi)
    p.text('SGB/F-07 (Rev. 03)  ·  Fictional sample form for layout testing', 70, 1680, 700, 14, 'sans', '#6b7485', label='footer')
    p.text('काल्पनिक नमूना प्रपत्र', 900, 1676, 270, 16, 'deva', '#6b7485', label='footer', **hi)
    return p


def japanese_station_notice():
    p = PageV3('v3-ja-station-service-notice', 1240, 1754, cluster='v3-ja-station-service-notice',
               features=['cjk', 'japanese', 'table-grid', 'illustration-map', 'notice', 'footer', 'logo'],
               brief='Japanese railway engineering-works notice: banner title, prose, replacement-bus timetable grid, schematic route map.',
               paper='#ffffff')
    p.source['provenance']['typography'] = TYPO
    ja = dict(language='ja')
    green = '#0a7a45'
    p.rectangle([0, 0, 1240, 120], green)
    p.ellipse([60, 28, 124, 92], '#ffffff')
    p.ellipse([74, 42, 110, 78], green)
    p.region('logo', [60, 28, 124, 92], None, kind='authored-ring-mark')
    p.text('みどり川鉄道', 145, 36, 500, 40, 'cjk-jp-bold', '#ffffff', label='header', **ja)
    p.text('お知らせ　No.2026-38', 860, 52, 330, 22, 'cjk-jp', '#e6f4ec', label='header', **ja)
    p.text('線路工事に伴う運休と代行バスのご案内', 60, 160, 1120, 46, 'cjk-jp-bold', '#13261c', label='title', **ja)
    p.text('11月8日（土）・9日（日）', 60, 236, 1120, 30, 'cjk-jp-bold', '#c0392b', **ja)
    p.text('いつもみどり川鉄道をご利用いただき、ありがとうございます。橋りょうの補修工事のため、下記の日程で北浜駅から山口駅までの区間を終日運休いたします。運休区間では代行バスを運転しますので、ご利用のお客さまはご注意ください。', 60, 300, 1120, 22, 'cjk-jp', '#222222', leading=40, **ja)
    p.text('代行バス時刻表（主な時刻）', 60, 460, 600, 25, 'cjk-jp-bold', green, label='title', **ja)
    p.table_v3([60, 505, 700, 505 + 9 * 40], [[('北浜 発', 1), ('中町 発', 1), ('山口 着', 1), ('備考', 1)]],
               [['6:10', '6:32', '6:55', '始発'], ['7:05', '7:27', '7:50', ''], ['7:40', '8:02', '8:25', ''], ['8:30', '8:52', '9:15', ''],
                ['12:00', '12:22', '12:45', ''], ['17:20', '17:42', '18:05', '増発'], ['18:10', '18:32', '18:55', ''], ['22:40', '23:02', '23:25', '最終']],
               [.25, .25, .25, .25], rules='grid', align=['center'] * 4, row_height=40, face='cjk-jp', size=19, header_face='cjk-jp-bold',
               header_fill='#e3f1e8', language='ja', rule_color='#8fb59f')
    p.text('所要時間は道路状況により前後します。', 60, 880, 640, 17, 'cjk-jp', '#555555', label='caption', **ja)
    # schematic map: native lines/ellipses with station names as component text
    mx0, my0, mx1, my1 = 760, 505, 1180, 865
    p.rectangle([mx0, my0, mx1, my1], '#f4f7f5', outline='#c6d6cc')
    stations = [('北浜', 560), ('中町', 680), ('山口', 800)]
    p.line([860, 540, 860, 830], green, 6)
    p.line([905, 560, 905, 820], '#d9822b', 4)
    for name, sy in stations:
        p.ellipse([848, sy - 12, 872, sy + 12], '#ffffff', outline=green, width=4)
        p.text(name + '駅', 940, sy - 14, 140, 21, 'cjk-jp', '#222222', label=None, **ja)
    p.text('運休区間', 780, 515, 100, 15, 'cjk-jp', green, label=None, **ja)
    p.text('代行バス', 960, 515, 140, 15, 'cjk-jp', '#d9822b', label=None, **ja)
    p.region('illustration', [mx0, my0, mx1, my1], None, kind='authored-route-schematic')
    p.text('ご注意', 60, 940, 300, 25, 'cjk-jp-bold', '#c0392b', label='title', **ja)
    p.text('・代行バスは車いすスペースが限られます。事前に駅係員へお申し出ください。\n・定期券、乗車券はそのまま代行バスでご利用いただけます。\n・自転車の持ち込みはできません。\n・工事の進み具合により、運転再開の時刻が早まる場合があります。', 60, 985, 1120, 21, 'cjk-jp', '#222222', leading=40, label='list', **ja)
    p.rectangle([60, 1200, 1180, 1380], '#fdf3e4')
    p.text('工事の内容', 90, 1222, 400, 23, 'cjk-jp-bold', '#8a4b10', label='title', **ja)
    p.text('昭和初期に架けられた川口橋りょうの支承を交換し、耐震補強を行います。夜間だけでは作業が終わらないため、二日間の終日運休となります。ご不便をおかけしますが、ご理解とご協力をお願いいたします。', 90, 1262, 1060, 20, 'cjk-jp', '#3b2a14', leading=36, **ja)
    p.line([60, 1640, 1180, 1640], '#cccccc', 1)
    p.text('みどり川鉄道 お客さまセンター　電話 0120-555-018（8:00〜20:00）　※本お知らせは架空の鉄道会社による見本です。', 60, 1658, 1120, 16, 'cjk-jp', '#666666', label='footer', **ja)
    return p


def arabic_pharmacy_leaflet():
    p = PageV3('v3-ar-medicine-leaflet', 1240, 1754, cluster='v3-ar-medicine-leaflet',
               features=['rtl', 'arabic', 'naskh', 'rtl-table', 'list', 'warning-box', 'footer', 'title'],
               brief='Arabic patient information leaflet: RTL headings, dosage table, side-effect lists, boxed warning, Latin drug name inline.',
               paper='#fefefb')
    p.source['provenance']['typography'] = TYPO
    ar = dict(direction='rtl', language='ar')
    red = '#9e2a2b'
    p.text('نشرة معلومات المريض', 70, 50, 1100, 22, 'naskh-bold', '#555555', label='header', **ar)
    p.line([70, 95, 1170, 95], '#333333', 2)
    p.text('أقراص سيترافين ٥٠٠ ملغ', 70, 120, 1100, 50, 'naskh-bold', '#1b1b1b', label='title', **ar)
    p.text('Citrafen 500 mg film-coated tablets', 70, 200, 1100, 22, 'serif-italic', '#444444', label='paragraph')
    p.text('اقرأ هذه النشرة بالكامل قبل البدء في تناول الدواء، واحتفظ بها فقد تحتاج إلى قراءتها مرة أخرى. إذا كانت لديك أي أسئلة إضافية، فاسأل الطبيب أو الصيدلي.', 70, 250, 1100, 23, 'naskh', '#222222', leading=44, **ar)
    p.text('١. ما هو هذا الدواء وفيم يستخدم؟', 70, 370, 1100, 28, 'naskh-bold', red, label='title', **ar)
    p.text('يحتوي هذا الدواء على مادة مسكنة للألم وخافضة للحرارة. يستخدم لتخفيف الصداع وآلام الأسنان وآلام العضلات، ولخفض الحرارة المصاحبة لنزلات البرد.', 70, 420, 1100, 23, 'naskh', '#222222', leading=44, **ar)
    p.text('٢. الجرعة المعتادة', 70, 530, 1100, 28, 'naskh-bold', red, label='title', **ar)
    p.table_v3([70, 580, 1170, 580 + 5 * 50], [[('الفئة العمرية', 1), ('الجرعة الواحدة', 1), ('الفاصل الزمني', 1), ('الحد الأقصى يوميًا', 1)]],
               [['البالغون', 'قرص أو قرصان', 'كل ٦ ساعات', '٨ أقراص'], ['من ١٢ إلى ١٥ سنة', 'قرص واحد', 'كل ٦ ساعات', '٤ أقراص'],
                ['من ٦ إلى ١١ سنة', 'نصف قرص', 'كل ٨ ساعات', 'قرصان'], ['أقل من ٦ سنوات', 'لا يستخدم', 'لا ينطبق', 'لا ينطبق']],
               [.28, .26, .22, .24], rules='booktabs', align=['left', 'center', 'center', 'center'], row_height=50, face='naskh', size=21,
               header_face='naskh-bold', direction='rtl', language='ar')
    p.text('لا تتجاوز الجرعة الموصى بها. يجب ألا تقل المدة بين الجرعتين عن أربع ساعات.', 70, 850, 1100, 19, 'naskh', '#555555', leading=36, label='caption', **ar)
    p.text('٣. الآثار الجانبية المحتملة', 70, 920, 1100, 28, 'naskh-bold', red, label='title', **ar)
    p.text('آثار شائعة:', 640, 975, 530, 22, 'naskh-bold', '#333333', label='paragraph', **ar)
    p.text('١. غثيان خفيف\n٢. ألم في المعدة\n٣. نعاس', 640, 1020, 530, 22, 'naskh', '#222222', leading=42, label='list', **ar)
    p.text('آثار نادرة تستدعي مراجعة الطبيب:', 70, 975, 530, 22, 'naskh-bold', '#333333', label='paragraph', **ar)
    p.text('١. طفح جلدي أو حكة\n٢. اصفرار الجلد أو العينين\n٣. صعوبة في التنفس', 70, 1020, 530, 22, 'naskh', '#222222', leading=42, label='list', **ar)
    p.rectangle([70, 1190, 1170, 1400], '#fbeaea', outline=red, width=3)
    p.text('تحذير', 90, 1210, 1060, 28, 'naskh-bold', red, label='title', **ar)
    p.text('لا تتناول هذا الدواء مع أدوية أخرى تحتوي على المادة الفعالة نفسها. تناول جرعة زائدة قد يسبب ضررًا خطيرًا للكبد حتى لو شعرت بأنك بخير. في حالة تناول جرعة زائدة، اتصل بالطبيب فورًا.', 90, 1260, 1060, 22, 'naskh', '#3a1414', leading=42, **ar)
    p.text('٤. كيفية التخزين', 70, 1440, 1100, 28, 'naskh-bold', red, label='title', **ar)
    p.text('يحفظ في درجة حرارة أقل من ٢٥ درجة مئوية وبعيدًا عن متناول الأطفال.', 70, 1490, 1100, 22, 'naskh', '#222222', leading=42, **ar)
    p.line([70, 1640, 1170, 1640], '#333333', 1)
    p.text('آخر مراجعة لهذه النشرة: أيلول ٢٠٢٦، منتج وهمي لأغراض الاختبار فقط', 70, 1660, 1100, 17, 'naskh', '#666666', label='footer', **ar)
    return p


def chinese_product_datasheet():
    p = PageV3('v3-zh-air-purifier-datasheet', 1240, 1754, cluster='v3-zh-air-purifier-datasheet',
               features=['cjk', 'simplified-chinese', 'table-booktabs', 'illustration', 'list', 'footer', 'two-column', 'logo'],
               brief='Simplified-Chinese product datasheet: product line drawing, feature list, booktabs specification table, two-column notes.',
               paper='#ffffff')
    p.source['provenance']['typography'] = TYPO
    zh = dict(language='zh-Hans')
    blue = '#1d4e89'
    p.rectangle([60, 50, 112, 102], blue)
    p.rectangle([74, 64, 98, 88], '#ffffff')
    p.region('logo', [60, 50, 112, 102], None, kind='authored-square-mark')
    p.text('清风电器', 128, 54, 300, 36, 'cjk-sc-bold', blue, label='header', **zh)
    p.text('产品技术规格书', 900, 66, 280, 22, 'cjk-sc', '#555555', label='header', **zh)
    p.line([60, 125, 1180, 125], blue, 3)
    p.text('QF-360 家用空气净化器', 60, 155, 1120, 44, 'cjk-sc-bold', '#111111', label='title', **zh)
    p.text('适用面积 20–42 平方米 · 三层过滤 · 低噪音睡眠模式', 60, 220, 1120, 24, 'cjk-sc', '#444444', **zh)
    # line drawing of the device (native shapes)
    ix0, iy0, ix1, iy1 = 60, 290, 520, 860
    p.rectangle([ix0, iy0, ix1, iy1], '#f3f6fa')
    p.rectangle([180, 340, 400, 800], '#ffffff', outline='#333333', width=3)
    p.rectangle([200, 360, 380, 420], '#e6edf5', outline='#333333', width=2)
    for i in range(14):
        p.line([205, 450 + i * 22, 375, 450 + i * 22], '#7a8899', 2)
    p.ellipse([270, 372, 310, 408], None, outline='#333333', width=2)
    p.line([400, 380, 450, 380], '#333333', 1)
    p.text('触控面板', 455, 368, 60, 15, 'cjk-sc', '#333333', label=None, **zh)
    p.line([400, 600, 450, 600], '#333333', 1)
    p.text('进风格栅', 455, 588, 60, 15, 'cjk-sc', '#333333', label=None, **zh)
    p.line([100, 820, 480, 820], '#999999', 1)
    p.text('高 620 mm', 410, 828, 100, 15, 'cjk-sc', '#333333', label=None, **zh)
    p.region('illustration', [ix0, iy0, ix1, iy1], None, kind='authored-product-line-drawing')
    p.text('图 1　产品外观与主要部件', 60, 875, 460, 18, 'cjk-sc', '#555555', label='caption', **zh)
    p.text('主要特点', 580, 290, 600, 26, 'cjk-sc-bold', blue, label='title', **zh)
    p.text('1. 初效滤网、HEPA 13 级滤网与活性炭层组合，可去除细颗粒物和常见异味。\n2. 激光颗粒物传感器每 3 秒更新一次读数，并自动调节风速。\n3. 睡眠模式下运行噪声约 22 分贝，指示灯自动熄灭。\n4. 滤网寿命提醒，可通过手机应用查看剩余时间。', 580, 340, 600, 20, 'cjk-sc', '#222222', leading=36, label='list', **zh)
    p.text('技术参数', 580, 640, 600, 26, 'cjk-sc-bold', blue, label='title', **zh)
    p.table_v3([580, 690, 1180, 690 + 9 * 38], [[('项目', 1), ('参数', 1)]],
               [['额定电压', '220 V ~ 50 Hz'], ['额定功率', '45 W'], ['颗粒物 CADR', '360 m³/h'], ['甲醛 CADR', '120 m³/h'],
                ['噪声（最低档）', '22 dB(A)'], ['净重', '7.8 kg'], ['外形尺寸', '320 × 320 × 620 mm'], ['滤网更换周期', '约 6–12 个月']],
               [.45, .55], rules='booktabs', align=['left', 'left'], row_height=38, face='cjk-sc', size=18, header_face='cjk-sc-bold', language='zh-Hans')
    p.text('使用注意事项', 60, 1080, 1120, 26, 'cjk-sc-bold', blue, label='title', **zh)
    p.text('请将净化器放置在平稳的地面上，四周至少留出 30 厘米空间，以保证进风和出风顺畅。不要在浴室等潮湿环境中使用，也不要用湿手触摸电源插头。', 60, 1130, 540, 19, 'cjk-sc', '#222222', leading=34, **zh)
    p.text('清洁外壳时请先拔下电源，用干的软布擦拭。初效滤网可用吸尘器清理，HEPA 滤网和活性炭层不可水洗。长期不用时，请将滤网取出密封保存。', 640, 1130, 540, 19, 'cjk-sc', '#222222', leading=34, **zh)
    p.line([60, 1300, 1180, 1300], '#cfd8e3', 1)
    p.text('包装清单', 60, 1330, 540, 24, 'cjk-sc-bold', blue, label='title', **zh)
    p.text('· 净化器主机 1 台\n· 复合滤网 1 套（已装入机内）\n· 遥控器 1 个（不含电池）\n· 使用说明书与保修卡各 1 份', 60, 1376, 540, 19, 'cjk-sc', '#222222', leading=34, label='list', **zh)
    p.text('保修说明', 640, 1330, 540, 24, 'cjk-sc-bold', blue, label='title', **zh)
    p.text('整机保修一年，电机保修三年。滤网属于消耗品，不在保修范围内。请保留购买凭证，维修时需出示。', 640, 1376, 540, 19, 'cjk-sc', '#222222', leading=34, **zh)
    p.line([60, 1650, 1180, 1650], '#cccccc', 1)
    p.text('清风电器有限公司（虚构企业）· 文件编号 QF-360-DS-02 · 第 1 页 / 共 1 页', 60, 1668, 1120, 16, 'cjk-sc', '#777777', label='footer', **zh)
    return p


def build():
    return [hebrew_clinic_newsletter(), hindi_bank_deposit_form(), japanese_station_notice(), arabic_pharmacy_leaflet(), chinese_product_datasheet()]
