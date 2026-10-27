"""V3 authored period-style print pages built around real public-domain engravings.

The page compositions, newspaper name, stories and advertisements are newly
authored and fictional. Engravings are real 1887-1889 public-domain plates with
receipts; captions state only what the receipt and the image establish. These are
native renders in a historic style, not scans: acquisition stays `digital`.
"""
try:
    from .page_v3 import PageV3
except ImportError:
    from page_v3 import PageV3


def gazette():
    p = PageV3('v3-historic-millbrook-gazette', 1240, 1754, cluster='v3-historic-millbrook-gazette',
               features=['historic-print-style', 'column-rules', 'engraving', 'masthead', 'boxed-advertisements', 'dense-columns', 'caption'],
               brief='Authored 1889-style weekly: double-ruled masthead, four columns with vertical rules, three real engravings with captions, boxed small advertisements.',
               paper='#f2ead6')
    ink = '#231f1a'
    p.line([40, 36, 1200, 36], ink, 3)
    p.line([40, 42, 1200, 42], ink, 1)
    p.text('THE MILLBROOK GAZETTE', 40, 54, 1160, 66, 'century-bold', ink, label='header', kind='masthead')
    p.line([40, 140, 1200, 140], ink, 1)
    p.text('VOL. XXIII.        MILLBROOK, SATURDAY, NOVEMBER 16, 1889.        PRICE TWO CENTS.', 40, 147, 1160, 15, 'century', ink, label='header', kind='dateline')
    p.line([40, 172, 1200, 172], ink, 1)
    p.line([40, 177, 1200, 177], ink, 3)
    cw, gap = 275, 20
    xs = [40 + i * (cw + gap) for i in range(4)]
    p.line([xs[1] - gap / 2, 190, xs[1] - gap / 2, 1690], ink, 1)
    p.line([xs[3] - gap / 2, 190, xs[3] - gap / 2, 1690], ink, 1)
    # column 1: local news
    y = p.text('THE NEW MILL ENGINE.', xs[0], 195, cw, 17, 'century-bold', ink, label='title')
    y = p.text('Work Begins on the Foundations at the Lower Dam.', xs[0], y + 4, cw, 14, 'century-italic', ink, leading=18, label='paragraph', kind='deck')
    y = p.text('The directors of the Millbrook Woollen Company have contracted for a new engine of the latest pattern, and the masons began on Monday to lay the foundations beside the lower dam. The old wheel, which has served the mill for thirty-one years, will be kept for use in seasons of high water.', xs[0], y + 8, cw, 14, 'century', ink, leading=19)
    y = p.text('The engine is to be built in sections and brought up by rail. Mr. Harlan, the superintendent, expects that the mill will run without interruption while the work proceeds, and that some forty additional hands will be employed when it is complete.', xs[0], y + 6, cw, 14, 'century', ink, leading=19)
    p.real_asset('engraving-machinery-railroad-journal-1887', [xs[0], y + 14, xs[0] + cw, y + 14 + 206], 'illustration')
    y = p.text('An engine with twin fan housings, as engraved for The Railroad and Engineering Journal, 1887.', xs[0], y + 228, cw, 12, 'century-italic', ink, leading=16, label='caption')
    y = p.text('TOWN COUNCIL.', xs[0], y + 16, cw, 15, 'century-bold', ink, label='title')
    y = p.text('At the regular meeting on Tuesday evening the council voted to light Main street with four additional lamps, and referred the petition for a sidewalk on Elm street to the committee on streets. The treasurer reported a balance of $1,214.60.', xs[0], y + 6, cw, 14, 'century', ink, leading=19)
    y = p.text('The marshal reported two arrests for the month, both for drunkenness, and asked for a new lock for the town lockup.', xs[0], y + 6, cw, 14, 'century', ink, leading=19)
    y = p.text('PERSONAL MENTION.', xs[0], y + 16, cw, 15, 'century-bold', ink, label='title')
    y = p.text('— Miss Ella Barnard has returned from a visit to friends in Columbus.\n— Mr. and Mrs. T. J. Greer are the parents of a fine boy, born Wednesday.\n— Rev. W. H. Lyle will preach at the Union church on Sabbath morning.\n— George Moffat is building an addition to his blacksmith shop on Mill street.', xs[0], y + 6, cw, 14, 'century', ink, leading=19, label='list')
    if y > 1685:
        raise ValueError('Column 1 overflow')
    # columns 2-3: science feature with spanning engraving
    y2 = p.text('CURIOSITIES OF THE DEEP.', xs[1], 195, 2 * cw + gap, 20, 'century-bold', ink, label='title')
    y2 = p.text('How the Flying Fish Escapes its Pursuers.', xs[1], y2 + 4, 2 * cw + gap, 15, 'century-italic', ink, label='paragraph', kind='deck')
    p.real_asset('engraving-natural-history-flying-fish', [xs[1], y2 + 12, xs[2] + cw, y2 + 12 + 470], 'illustration')
    y2 = p.text('FLYING FISH PURSUED BY A DOLPHIN.—From the Popular Science Monthly.', xs[1], y2 + 492, 2 * cw + gap, 12, 'century', ink, label='caption')
    left = p.text('Travellers in the warmer seas have long remarked the flying fish, which rises from the water in companies and skims for a considerable distance before dropping back beneath the waves. The broad fins, spread like the wings of a bird, do not beat as wings do, but bear the fish along as a kite is borne by the wind.', xs[1], y2 + 14, cw, 14, 'century', ink, leading=19)
    left = p.text('Sailors say that the fish leap most often when they are chased, and the engraving shows such a pursuit, the dolphin following close behind the leaping school. Whether the flight is of much use as an escape our correspondent leaves to the naturalists.', xs[1], left + 6, cw, 14, 'century', ink, leading=19)
    right = p.text('It is a common thing for the fish to fall upon the decks of vessels at night, being attracted, it is supposed, by the lights. Their flesh is said to be delicate, and a breakfast of flying fish is a favourite treat among those who have made the voyage to the Indies.', xs[2], y2 + 14, cw, 14, 'century', ink, leading=19)
    right = p.text('The naturalist who wishes to examine the fins should spread them upon a board while they are fresh; when dry they become brittle and are easily broken.', xs[2], right + 6, cw, 14, 'century', ink, leading=19)
    yy = max(left, right) + 18
    p.line([xs[1], yy, xs[2] + cw, yy], ink, 1)
    yy = p.text('THE LATE MR. FERGUSSON.', xs[1], yy + 12, cw, 15, 'century-bold', ink, label='title')
    p.real_asset('engraving-portrait-james-fergusson', [xs[1] + 40, yy + 10, xs[1] + cw - 40, yy + 10 + 250], 'illustration')
    yy = p.text('JAMES FERGUSSON.—Frontispiece portrait, Popular Science Monthly, 1887.', xs[1], yy + 268, cw, 12, 'century-italic', ink, leading=16, label='caption')
    p.line([xs[2] - gap / 2, y2 + 510, xs[2] - gap / 2, 1690], ink, 1)
    y3 = p.text('Students of the history of building will regret the passing of Mr. James Fergusson, whose volumes on the architecture of all countries are known to every reader of the subject. A sketch of his life appears in the monthly from which the portrait is taken.', xs[2], max(left, right) + 30, cw, 14, 'century', ink, leading=19)
    y3 = p.text('MILLBROOK MARKETS.', xs[2], y3 + 22, cw, 15, 'century-bold', ink, label='title')
    y3 = p.text('Corrected every Friday by Hartwell & Son.', xs[2], y3 + 2, cw, 12, 'century-italic', ink, label='paragraph')
    prices = [['Wheat, per bu.', '82c'], ['Corn, per bu.', '34c'], ['Oats, per bu.', '26c'], ['Potatoes, per bu.', '40c'], ['Butter, per lb.', '22c'],
              ['Eggs, per doz.', '18c'], ['Lard, per lb.', '8c'], ['Hay, per ton', '$9.00']]
    p.table_v3([xs[2], y3 + 8, xs[2] + cw, y3 + 8 + 24 * len(prices)], [], prices, [.7, .3], rules='none', align=['left', 'right'], row_height=24,
               face='century', size=14, pad=3)
    if y3 + 8 + 24 * len(prices) > 1685:
        raise ValueError('Column 3 overflow')
    # column 4: advertisements
    ads = [('DR. WELLS’ COUGH BALSAM.', 'Sold by all druggists. 25 cents a bottle. Ask for no other.'),
           ('S. HARTWELL & SON,', 'Dry Goods, Notions and Carpets. Winter stock now open. No. 14 Main Street.'),
           ('FARM FOR SALE.', 'Eighty acres, good house and barn, two miles from depot. Inquire of J. B. Coyle.'),
           ('MILLBROOK SAVINGS BANK.', 'Interest paid on deposits at four per cent. Open daily from 9 to 3.'),
           ('WANTED.', 'A strong boy to learn the printing trade. Apply at this office.'),
           ('THE EAGLE HOTEL.', 'Rates $1.50 per day. Livery attached. Commercial men accommodated.'),
           ('NOTICE.', 'All persons indebted to the estate of the late Abner Price are requested to settle with the undersigned.'),
           ('C. W. DOANE, DENTIST.', 'Teeth extracted without pain. Office over the post office.'),
           ('COAL! COAL!', 'Hard and soft coal delivered to any part of town. Leave orders at the depot.'),
           ('LOST.', 'A brown leather pocket-book, containing papers of no value except to the owner. Finder will be rewarded.'),
           ('PIANOS AND ORGANS.', 'Sold on easy monthly payments. Catalogues free. J. Meyer, Music Dealer.'),
           ('HARNESS MADE TO ORDER.', 'Repairing promptly done. Fair prices. P. Dunn, Elm Street.')]
    ay = 195
    for head, body in ads:
        top = ay
        ay = p.text(head, xs[3] + 10, ay + 10, cw - 20, 14, 'century-bold', ink, label='title')
        ay = p.text(body, xs[3] + 10, ay + 4, cw - 20, 13, 'century', ink, leading=17, label='paragraph', kind='advertisement')
        p.rectangle([xs[3], top, xs[3] + cw, ay + 12], None, outline=ink, width=1)
        ay += 22
    if ay > 1690:
        raise ValueError('Advertisement column overflow')
    p.line([40, 1700, 1200, 1700], ink, 1)
    p.text('Authored period-style composition for a layout test. Engravings: public-domain plates (1887–1889) credited in each caption.', 40, 1710, 1160, 12, 'century-italic', '#4a4238', label='footer')
    return p


def build():
    return [gazette()]
