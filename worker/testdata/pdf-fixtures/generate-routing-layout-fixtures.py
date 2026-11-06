"""Generated, public routing-eval fixtures for the image-evidence OCR rule and the table-heavy threshold (owner rules,
2026-11-05). Deterministic: a fixed seed and Pillow's default font. Run with the worker venv's Python:

    python3 -I worker/testdata/pdf-fixtures/generate-routing-layout-fixtures.py worker/testdata/pdf-fixtures

Each PDF is assembled by worker/scripts/pdf_fixtures.py (raw objects), so geometry is exact.
"""
import importlib.util
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pdf_fixtures', HERE.parent.parent / 'scripts' / 'pdf_fixtures.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
PdfBuilder, place, text_lines = fixtures.PdfBuilder, fixtures.place, fixtures.text_lines

from PIL import Image, ImageDraw  # noqa: E402

PROSE = [
    'The committee reviewed the quarterly report and agreed the revised schedule for the district',
    'program. Members noted that the field survey was completed on time and that the archive copy',
    'of the original inspection notes is reproduced below for reference by the planning office.',
    'Questions about the survey method should be sent to the records desk before the next meeting.',
]


def scan_raster(width, height, seed, mode='L'):
    """A document page as pixels: lines of dark text on white, the way a scanned or photographed page looks."""
    rng = random.Random(seed)
    image = Image.new(mode, (width, height), 255 if mode == 'L' else (255, 255, 255))
    draw = ImageDraw.Draw(image)
    words = 'ledger article section district council measure annual revenue township clause report'.split()
    y = 20
    while y < height - 30:
        line = ' '.join(rng.choice(words) for _ in range(rng.randint(5, 9)))
        draw.text((24, y), line, fill=0 if mode == 'L' else (20, 20, 20))
        y += 22
    return image


def photo_raster(width, height, seed):
    """A photograph-like raster: smooth colour fields with per-pixel noise (does not compress like a page of text)."""
    rng = random.Random(seed)
    image = Image.new('RGB', (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = ((x * 255 // width + rng.randint(0, 60)) % 256, (y * 255 // height + rng.randint(0, 60)) % 256,
                            (128 + rng.randint(-60, 60)) % 256)
    return image


def add_image(builder, image):
    if image.mode == 'L':
        return builder.image(image.width, image.height, image.tobytes(), colorspace='/DeviceGray')
    return builder.image(image.width, image.height, image.convert('RGB').tobytes())


def scan_beside_caption():
    b = PdfBuilder()
    im = add_image(b, scan_raster(800, 600, seed=11))
    content = text_lines(PROSE, x=72, y=740) + place(468, 351, 72, 300) + text_lines(['Figure 1: archive copy of the inspection notes (scan).'], x=72, y=280, size=9)
    b.page(content, {'Im': im})
    return b.build()


def letterhead_logo():
    """Three letters sharing one letterhead banner (flat colours: compresses like a page, but it is furniture)."""
    b = PdfBuilder()
    banner = Image.new('RGB', (900, 300), (240, 244, 250))
    ImageDraw.Draw(banner).rectangle([20, 20, 880, 280], outline=(20, 40, 120), width=8)
    ImageDraw.Draw(banner).text((60, 120), 'DISTRICT RECORDS OFFICE', fill=(20, 40, 120))
    im = add_image(b, banner)
    for page in range(3):
        b.page(place(540, 180, 36, 590) + text_lines(PROSE + [f'Letter {page + 1} of the records series.'], x=72, y=560), {'Im': im})
    return b.build()


def photo_with_overlaid_caption():
    b = PdfBuilder()
    im = add_image(b, photo_raster(400, 300, seed=5))
    caption = text_lines(['Harbour at dawn, looking north from the east pier', 'during the spring survey of the waterfront'], x=110, y=360, size=14)
    b.page(text_lines(PROSE, x=72, y=740) + place(468, 351, 72, 280) + caption, {'Im': im})
    return b.build()


def scan_with_text_layer():
    """A searchable scan: the page image with its own native text drawn over it (an OCR layer)."""
    b = PdfBuilder()
    im = add_image(b, scan_raster(850, 1100, seed=23))
    layer = text_lines([' '.join(PROSE)[i:i + 90] for i in range(0, 360, 90)] * 6, x=60, y=700, size=10, leading=24)
    b.page(place(612, 792, 0, 0) + layer, {'Im': im})
    return b.build()


def ruled_table(rows, x=72, top=520, widths=(140, 120, 208), row_height=20, cell_text=None):
    """A ruled table: grid lines (`re` strokes) and one text line per cell."""
    out = ['0.5 w']
    y = top
    for r in range(rows):
        cx = x
        for c, w in enumerate(widths):
            out.append(f'{cx} {y - row_height} {w} {row_height} re S')
            cx += w
        y -= row_height
    out.append('BT /F1 9 Tf')
    y = top - 14
    for r in range(rows):
        cx = x + 4
        for c, w in enumerate(widths):
            text = (cell_text or (lambda r, c: f'R{r + 1} cell {c + 1} value {r * 7 + c * 3}'))(r, c)
            out.append(f'1 0 0 1 {cx} {y} Tm ({text}) Tj')
            cx += w
        y -= row_height
    out.append('ET')
    return '\n'.join(out) + '\n'


def table_page(rows, **kwargs):
    b = PdfBuilder()
    b.page(text_lines(PROSE, x=72, y=740) + ruled_table(rows, **kwargs) + text_lines(PROSE[:2], x=72, y=200), {})
    return b.build()


def tall_table():
    """Four rows of multi-line cells: few rows, but the table covers most of the page."""
    lines = ['Survey area north of the', 'harbour, measured in the', 'spring and checked again', 'in the autumn season by', 'the field team on site.', 'Records kept at the desk.']
    b = PdfBuilder()
    content = ['0.5 w']
    widths, x, top, height = (156, 156, 156), 72, 710, 118
    for r in range(4):
        cx = x
        for w in widths:
            content.append(f'{cx} {top - (r + 1) * height} {w} {height} re S')
            cx += w
    content.append('BT /F1 9 Tf')
    for r in range(4):
        cx = x + 6
        for c, w in enumerate(widths):
            for i, line in enumerate([f'Row {r + 1} column {c + 1}'] + lines):
                content.append(f'1 0 0 1 {cx} {top - r * height - 14 - i * 14} Tm ({line}) Tj')
            cx += w
    content.append('ET')
    b.page(text_lines(PROSE[:1], x=72, y=740) + '\n'.join(content) + '\n', {})
    return b.build()


FINANCIAL = [('Account', '2024', '2025', 'Change')] + [
    (name, f'{a:,}', f'{b:,}', f'{(b - a) / a * 100:+.1f}%') for name, a, b in (
        ('Revenue', 48210, 52934), ('Cost of sales', 21877, 23015), ('Gross profit', 26333, 29919), ('Operating expenses', 15012, 15890),
        ('Operating income', 11321, 14029), ('Interest expense', 1204, 1187), ('Pre-tax income', 10117, 12842), ('Income tax', 2529, 3211))]


def clean_financial_table():
    """A born-digital financial statement: one header row, eight data rows, a ruled grid. Doppler's table is sound."""
    b = PdfBuilder()
    table = ruled_table(len(FINANCIAL), top=600, widths=(170, 100, 100, 98), cell_text=lambda r, c: FINANCIAL[r][c])
    b.page(text_lines(['Consolidated statement of income (in thousands)'], x=72, y=700, font='F2') + text_lines(PROSE[:2], x=72, y=670) + table, {})
    return b.build()


def two_line_header_table():
    """A grouped header over two lines: 'Revenue' and 'Margin' each span two quarter columns. Unruled, so only alignment says
    which cells belong together."""
    rows = [('', 'Revenue', '', 'Margin', ''), ('Region', 'Q1', 'Q2', 'Q1', 'Q2')] + [
        (region, f'{1200 + i * 87:,}', f'{1310 + i * 91:,}', f'{18 + i}.{i}%', f'{19 + i}.{i + 2}%')
        for i, region in enumerate(('North', 'South', 'East', 'West', 'Central', 'Overseas'))]
    xs = (72, 200, 280, 360, 440)
    out = ['BT /F1 9 Tf']
    y = 600
    for row in rows:
        for x, text in zip(xs, row):
            if text:
                out.append(f'1 0 0 1 {x + (20 if row is rows[0] and text else 0)} {y} Tm ({text}) Tj')
        y -= 16
    out.append('ET')
    b = PdfBuilder()
    b.page(text_lines(['Regional results'], x=72, y=700, font='F2') + text_lines(PROSE[:2], x=72, y=670) + '\n'.join(out) + '\n', {})
    return b.build()


def bullet_list_in_columns():
    """A bulleted agenda laid out in aligned columns (bullet, item, owner, minutes): a list, though it lines up like a table."""
    items = [('Approve the minutes of the last meeting', 'Chair', '5'), ('Review the quarterly survey results', 'Planning', '20'),
             ('Agree the revised district schedule', 'Committee', '15'), ('Archive the inspection notes', 'Records', '5'),
             ('Confirm the next meeting date', 'Secretary', '5'), ('Any other business', 'All', '10')]
    out = ['BT /F1 10 Tf']
    y = 600
    for item, owner, minutes in items:
        out.append(f'1 0 0 1 80 {y} Tm (-) Tj')
        out.append(f'1 0 0 1 96 {y} Tm ({item}) Tj')
        out.append(f'1 0 0 1 380 {y} Tm ({owner}) Tj')
        out.append(f'1 0 0 1 500 {y} Tm ({minutes} min) Tj')
        y -= 18
    out.append('ET')
    b = PdfBuilder()
    b.page(text_lines(['Agenda'], x=72, y=700, font='F2') + text_lines(PROSE[:2], x=72, y=670) + '\n'.join(out) + '\n', {})
    return b.build()


def scanned_table():
    """The financial table as a page scan: no text layer, the table only as pixels."""
    from PIL import Image as PILImage, ImageDraw as PILDraw
    width, height = 1700, 2200
    image = PILImage.new('L', (width, height), 255)
    draw = PILDraw.Draw(image)
    x0, y0, row, widths = 150, 400, 70, (560, 330, 330, 330)
    for r, cells in enumerate(FINANCIAL):
        x = x0
        for c, w in enumerate(widths):
            draw.rectangle([x, y0 + r * row, x + w, y0 + (r + 1) * row], outline=0, width=3)
            draw.text((x + 14, y0 + r * row + 22), cells[c], fill=0)
            x += w
    b = PdfBuilder()
    im = add_image(b, image)
    b.page(place(612, 792, 0, 0), {'Im': im})
    return b.build()


FIXTURES = {
    'routing-scan-beside-caption.pdf': scan_beside_caption,
    'routing-letterhead-logo.pdf': letterhead_logo,
    'routing-photo-overlaid-caption.pdf': photo_with_overlaid_caption,
    'routing-scan-with-text-layer.pdf': scan_with_text_layer,
    'routing-table-4-rows.pdf': lambda: table_page(4),
    'routing-table-6-rows.pdf': lambda: table_page(6),
    'routing-table-large-coverage.pdf': tall_table,
    'routing-table-clean-financial.pdf': clean_financial_table,
    'routing-table-two-line-header.pdf': two_line_header_table,
    'routing-table-bullet-list.pdf': bullet_list_in_columns,
    'routing-table-scanned.pdf': scanned_table,
}

if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE
    for name, make in FIXTURES.items():
        (out / name).write_bytes(make())
        print(name)
