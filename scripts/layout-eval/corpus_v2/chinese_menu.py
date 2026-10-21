"""One original 1990s-style Chinese-American takeout menu, not a replica."""
from pathlib import Path
import hashlib
from fontTools.ttLib import TTFont
from .page import Page, FONT_FILES, poly

CJK_FONT = '/usr/share/fonts/noto-cjk/NotoSerifCJK-Bold.ttc'
CJK_TEXT = '楓燈小館小食湯羹炒飯麵食雞肉牛肉海鮮蔬菜套餐'
RED = '#a3231f'
INK = '#251c18'
PAPER = '#fff5d9'


def section(p, x, y, english, chinese, rows, single=False):
    width = 344
    p.rectangle([x, y, x + width, y + 48], RED)
    p.text(english, x + 10, y + 5, width - 20, 21, 'serif-bold', PAPER, label='title')
    p.text(chinese, x + 10, y + 27, width - 20, 15, 'menu-cjk', PAPER, label='title')
    top = y + 58
    headers = ['Dish', 'Price'] if single else ['Dish', 'Pint', 'Quart']
    bounds = [x, x + 279, x + width] if single else [x, x + 238, x + 291, x + width]
    cells = []
    allrows = [headers] + rows
    for ri, row in enumerate(allrows):
        yy = top + ri * 25
        for ci, value in enumerate(row):
            left, right = bounds[ci], bounds[ci + 1]
            p.text(str(value), left + 3, yy + 2, right - left - 5,
                   15 if ci == 0 else 14, 'serif-bold' if ri == 0 else 'serif',
                   RED if ri == 0 else INK, label=None)
            cells.append({'row': ri, 'column': ci, 'text': str(value),
                          'bbox': [left, yy, right, yy + 25],
                          'polygon': poly([left, yy, right, yy + 25]), 'is_header': ri == 0})
        if ri:
            # Decorative dot leaders are geometry, not text in the prose contract.
            f = p.font('serif', 15)
            begin = x + 7 + f.getlength(str(row[0]))
            for dot in range(round(begin), round(bounds[1] - 9), 6):
                p.ellipse([dot, yy + 17, dot + 1, yy + 18], '#7e6652')
    bottom = top + len(allrows) * 25
    p.line([x, top + 24, x + width, top + 24], RED, 1)
    p.region('table', [x, top, x + width, bottom], None, cells=cells,
             rows=len(allrows), columns=len(headers), border=False,
             menu_section=english, extent_policy='authored-table-layout',
             decorative_leaders='geometric dots excluded from source text')
    return bottom + 20


def menu(root=None):
    font = TTFont(CJK_FONT, fontNumber=0)
    cmap = font.getBestCmap()
    missing = sorted({c for c in CJK_TEXT if ord(c) not in cmap})
    if missing:
        raise ValueError('Missing authored CJK glyphs: ' + ''.join(missing))
    FONT_FILES['menu-cjk'] = CJK_FONT
    p = Page('maple-lantern-1994-takeout-menu', 1200, 1600, paper=PAPER)
    p.source['provenance'].update({
        'kind': 'original-fictional-period-menu-composition',
        'release_candidate_license': 'CC-BY-4.0',
        'copyright_holder': 'DocSlurp contributors',
        'public_release_status': 'candidate-only-not-published',
        'inspiration': {
            'url': 'https://www.mocanyc.org/collections/stories/1980s-1990s-menus-collection-from-the-harley-spiller-collection-at-university-of-toronto-scarborough/',
            'item': '1995 Chiam Chinese Cuisine menu front and back',
            'rights': 'unverified-inspiration-only-no-raster-name-logo-or-copy-reused',
            'observed_features': ['folded paper panels', 'dense category lists', 'price columns', 'large restaurant heading'],
            'observation_date': '2026-10-20'},
        'font': {'path': CJK_FONT, 'sha256': hashlib.sha256(Path(CJK_FONT).read_bytes()).hexdigest(),
                 'license': 'OFL-1.1', 'license_evidence': 'Installed Arch package noto-fonts-cjk 20240730-1 metadata; upstream Noto CJK LICENSE',
                 'upstream': 'https://github.com/notofonts/noto-cjk/blob/main/LICENSE',
                 'glyph_coverage': {'checked': CJK_TEXT, 'missing': missing, 'method': 'fontTools cmap check, TTC face 0'},
                 'font_binary_embedded': False}})
    p.rectangle([23, 23, 1177, 1577], None, outline=RED, width=3)
    p.rectangle([30, 30, 1170, 1570], None, outline=RED, width=1)
    p.text('楓燈小館', 51, 47, 370, 45, 'menu-cjk', RED, label='title')
    p.text('MAPLE LANTERN', 420, 46, 730, 52, 'serif-bold', RED, label='title')
    p.text('CHINESE KITCHEN  •  TAKE-OUT MENU  •  AUTUMN 1994', 423, 110, 720, 18, 'serif-bold', INK, label='header')
    p.line([48, 149, 1152, 149], RED, 3)
    p.text('CANTONESE • SZECHUAN • HUNAN', 49, 164, 600, 20, 'serif-bold', RED, label='paragraph')
    p.text('Order by number  /  212-555-0147', 654, 162, 500, 23, 'serif-bold', RED, label='paragraph')
    p.text('88 Lantern Lane, New York, NY 10000  •  Open daily 11:00 a.m.–10:30 p.m.', 49, 199, 1100, 17, 'serif', INK)
    p.text('Please tell us how hot you like it.  * Hot & spicy dishes may be prepared mild.', 49, 228, 1100, 17, 'serif-italic', INK)
    for x in (409, 797):
        p.line([x, 278, x, 1451], '#d2b792', 1)
        p.source.setdefault('physical_layout', {})['fold_lines_x'] = [409, 797]
    y = section(p, 48, 280, 'APPETIZERS', '小食', [
        ['1. Egg Roll (1)', '1.00'], ['2. Vegetable Spring Roll', '1.10'], ['3. Fried Wonton (10)', '2.25'],
        ['4. Dumplings (6)', '3.75'], ['5. Sesame Cold Noodles*', '3.25'], ['6. Barbecued Spare Ribs', '4.95'],
        ['7. Scallion Pancake', '2.50'], ['8. Pu Pu Platter (for 2)', '8.25']], True)
    y = section(p, 48, y, 'SOUP', '湯羹', [
        ['9. Wonton Soup', '1.25', '2.20'], ['10. Egg Drop Soup', '1.10', '1.95'],
        ['11. Hot & Sour Soup*', '1.40', '2.50'], ['12. Chicken Noodle Soup', '1.35', '2.35'],
        ['13. Vegetable Bean Curd', '1.45', '2.60']])
    y = section(p, 48, y, 'FRIED RICE', '炒飯', [
        ['14. Roast Pork Fried Rice', '3.10', '5.20'], ['15. Chicken Fried Rice', '3.10', '5.20'],
        ['16. Shrimp Fried Rice', '3.65', '6.10'], ['17. Vegetable Fried Rice', '2.85', '4.80'],
        ['18. House Special Rice', '3.95', '6.65']])
    section(p, 48, y, 'LO MEIN', '麵食', [
        ['19. Roast Pork Lo Mein', '3.65', '6.25'], ['20. Chicken Lo Mein', '3.65', '6.25'],
        ['21. Shrimp Lo Mein', '4.10', '6.95']])
    y = section(p, 436, 280, 'CHICKEN', '雞肉', [
        ['22. Chicken with Broccoli', '4.25', '7.25'], ['23. Chicken with Cashews', '4.50', '7.75'],
        ['24. Kung Pao Chicken*', '4.35', '7.50'], ['25. Chicken Garlic Sauce*', '4.35', '7.50'],
        ['26. Sweet & Sour Chicken', '4.25', '7.25'], ['27. Chicken with Snow Peas', '4.65', '7.95'],
        ['28. Moo Goo Gai Pan', '4.25', '7.25']])
    y = section(p, 436, y, 'BEEF', '牛肉', [
        ['29. Beef with Broccoli', '4.65', '7.95'], ['30. Pepper Steak with Onion', '4.65', '7.95'],
        ['31. Beef with Mushrooms', '4.80', '8.25'], ['32. Hunan Beef*', '4.80', '8.25'],
        ['33. Beef with Snow Peas', '4.95', '8.50'], ['34. Beef Garlic Sauce*', '4.80', '8.25']])
    section(p, 436, y, 'SEAFOOD', '海鮮', [
        ['35. Shrimp with Broccoli', '5.10', '8.75'], ['36. Shrimp Lobster Sauce', '5.10', '8.75'],
        ['37. Shrimp Garlic Sauce*', '5.20', '8.95'], ['38. Shrimp with Snow Peas', '5.25', '9.10'],
        ['39. Scallops with Vegetables', '5.65', '9.75'], ['40. Hunan Shrimp*', '5.20', '8.95']])
    y = section(p, 824, 280, 'VEGETABLES', '蔬菜', [
        ['41. Mixed Vegetables', '3.50', '5.95'], ['42. Broccoli Garlic Sauce*', '3.50', '5.95'],
        ['43. Bean Curd Home Style', '3.65', '6.25'], ['44. Sauteed Snow Peas', '3.95', '6.75'],
        ['45. Eggplant Garlic Sauce*', '3.75', '6.50']])
    p.text('COMBINATION DINNERS', 828, y, 337, 21, 'serif-bold', RED, label='title')
    p.text('套餐', 828, y + 25, 330, 19, 'menu-cjk', RED, label='title')
    p.text('Served with pork fried rice & egg roll.\nAvailable all day. No substitutions.', 828, y + 57, 332, 17, 'serif', INK, leading=21)
    y = section(p, 824, y + 115, 'YOUR CHOICE', '套餐', [
        ['C1. Chicken Chow Mein', '5.25'], ['C2. Roast Pork Lo Mein', '5.50'],
        ['C3. Sweet & Sour Chicken', '5.50'], ['C4. Beef with Broccoli', '5.95'],
        ['C5. General Tso Chicken*', '6.25'], ['C6. Sesame Chicken', '6.25'],
        ['C7. Shrimp Lobster Sauce', '6.50'], ['C8. Boneless Spare Ribs', '6.50']], True)
    p.rectangle([824, y + 7, 1168, y + 176], None, outline=RED, width=2)
    p.text('LUNCH TO GO', 845, y + 22, 305, 26, 'serif-bold', RED, label='title')
    p.text('Mon.–Sat. 11:00 a.m.–3:00 p.m.\nAny C1–C4 combination: $3.95\nIncludes fried rice and soup.\nPlease mention lunch when ordering.', 842, y + 64, 310, 17, 'serif', INK, leading=23)
    section(p, 436, 1092, 'HOUSE FAVORITES', '套餐', [
        ['H1. Sesame Chicken', '8.25'], ['H2. Orange Flavored Beef*', '9.25'],
        ['H3. Happy Family', '10.50'], ['H4. General Tso Chicken*', '8.25'],
        ['H5. Triple Delight', '9.75'], ['H6. Seafood Combination', '11.25']], True)
    p.rectangle([48, 1260, 392, 1426], None, outline=RED, width=2)
    p.text('A LITTLE EXTRA', 64, 1274, 310, 23, 'serif-bold', RED, label='title')
    p.text('''One FREE egg roll with any order
of $15 or more. Take-out only.
Please present this coupon.
One coupon per order. Ends 12/31/94.''', 64, 1316, 310, 17, 'serif', INK, leading=23)
    p.text('ORDERING NOTES', 829, 1176, 330, 21, 'serif-bold', RED, label='title')
    p.text('''All entrees served with white rice.
Extra white rice: pint .75 / quart 1.25
Brown rice available on request.

For parties, ask about our large trays.
Allow extra time for delivery.
Prices subject to change without notice.''', 829, 1216, 327, 17, 'serif', INK, leading=23)
    p.line([48, 1469, 1152, 1469], RED, 2)
    p.text('TELEPHONE ORDERS WELCOME', 55, 1488, 710, 23, 'serif-bold', RED, label='footer')
    p.text('212-555-0147', 824, 1486, 340, 30, 'serif-bold', RED, label='footer')
    p.text('Cash accepted • Free delivery on orders over $10 within 10 blocks • Sales tax additional', 55, 1530, 1100, 16, 'serif', INK, label='footer')
    return p


def build(root=None):
    return [menu(root)]
