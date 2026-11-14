"""Image placement/metadata regressions for the layout-facts walker on authored PDFs; no private binary is executed.

Pure-Python parts run everywhere. Cross-checks against poppler's tools skip when those tools are absent.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).parent
CORE_ROOT = HERE.resolve().parent.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


facts = load('pdf_layout_facts', 'pdf_layout_facts.py')
fixtures = load('pdf_fixtures', 'pdf_fixtures.py')
PdfBuilder, rgb_gradient, solid_rgb, place = fixtures.PdfBuilder, fixtures.rgb_gradient, fixtures.solid_rgb, fixtures.place


class Scratch(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, data, name='input.pdf'):
        path = Path(self.dir.name) / name
        path.write_bytes(data)
        return str(path)

    def walk(self, data, first=1, last=None, deadline=None):
        pages = facts.walk_document(self.write(data), first, last or first, deadline)
        return pages

    def one(self, data, page=1):
        walk = self.walk(data, page, page)[page]
        self.assertIsNone(walk.unknown, walk.unknown)
        return walk


def simple_pdf(content, size=(40, 20), xref_stream=False, **page):
    b = PdfBuilder()
    im = b.image(size[0], size[1], rgb_gradient(*size))
    b.page(content, {'Im': im}, **page)
    return b.build(xref_stream=xref_stream), im


class PlacementTest(Scratch):
    def geometry(self, data, page=1, index=0):
        walk = self.one(data, page)
        return facts.placement_from_draw(walk.draws[index], walk)

    def test_upright_image_bbox_is_top_left_origin_points(self):
        data, im = simple_pdf(place(100, 50, 72, 700))
        walk = self.one(data)
        self.assertEqual(len(walk.draws), 1)
        self.assertEqual(walk.draws[0].obj, (im, 0))
        p = facts.placement_from_draw(walk.draws[0], walk)
        self.assertEqual(p['bbox'], [72.0, 42.0, 172.0, 92.0])           # 792 - 750 = 42 from the top
        self.assertEqual((p['widthPt'], p['heightPt']), (100.0, 50.0))
        self.assertEqual((p['rotationDegrees'], p['mirrored']), (0.0, False))
        self.assertAlmostEqual(p['coverage'], 100 * 50 / (612 * 792), places=4)
        self.assertEqual((p['pageWidthPt'], p['pageHeightPt']), (612.0, 792.0))

    def test_xref_stream_and_object_stream_files_give_the_same_geometry(self):
        classic = self.geometry(simple_pdf(place(100, 50, 72, 700))[0])
        packed = self.geometry(simple_pdf(place(100, 50, 72, 700), xref_stream=True)[0])
        self.assertEqual(classic, packed)

    def test_page_rotation_moves_the_box_to_where_a_viewer_shows_it(self):
        base = place(100, 50, 72, 700)  # near the top-left of an upright page
        # The expected boxes are computed by hand from the upright box: a clockwise quarter turn sends the
        # top-left corner to the top-right, and the displayed page is 792×612.
        w, h = 612.0, 792.0
        x0, y0, x1, y1 = 72.0, 42.0, 172.0, 92.0
        expected = {0: [x0, y0, x1, y1],
                    90: [h - y1, x0, h - y0, x1],
                    180: [w - x1, h - y1, w - x0, h - y0],
                    270: [y0, w - x1, y1, w - x0]}
        for rotate, box in expected.items():
            data, _ = simple_pdf(base, rotate=rotate)
            walk = self.one(data)
            p = facts.placement_from_draw(walk.draws[0], walk)
            self.assertEqual(p['bbox'], box, f'rotate {rotate}')
            self.assertEqual((walk.width, walk.height), (h, w) if rotate in (90, 270) else (w, h))
            self.assertEqual(p['rotationDegrees'], float(rotate), f'rotate {rotate}')   # the picture turns with the page
            self.assertFalse(p['mirrored'])

    def test_rotated_and_mirrored_draws(self):
        # 90° counter-clockwise on the page (PDF y-up) reads as -90° = 270° clockwise in displayed space.
        data, _ = simple_pdf('q 0 50 -100 0 300 300 cm /Im Do Q')
        p = self.geometry(data)
        self.assertEqual(p['rotationDegrees'], 270.0)
        self.assertFalse(p['mirrored'])
        self.assertEqual(p['bbox'], [200.0, 442.0, 300.0, 492.0])
        # Horizontal flip: negative x scale.
        data, _ = simple_pdf('q -100 0 0 50 200 300 cm /Im Do Q')
        p = self.geometry(data)
        self.assertTrue(p['mirrored'])
        self.assertEqual(p['bbox'], [100.0, 442.0, 200.0, 492.0])
        # Vertical flip: negative y scale.
        data, _ = simple_pdf('q 100 0 0 -50 100 300 cm /Im Do Q')
        self.assertTrue(self.geometry(data)['mirrored'])
        # 45 degrees.
        data, _ = simple_pdf('q 70.7107 70.7107 -70.7107 70.7107 300 300 cm /Im Do Q')
        p = self.geometry(data)
        self.assertAlmostEqual(p['rotationDegrees'], 315.0, places=1)
        self.assertAlmostEqual(p['bbox'][2] - p['bbox'][0], 141.42, places=1)
        self.assertLess(p['coverage'], 141.42 * 141.42 / (612 * 792))   # the rotated square's own area, not its bounding box

    def test_nested_form_matrices_compose_and_draw_order_follows_painting(self):
        b = PdfBuilder()
        im = b.image(8, 8, solid_rgb(8, 8, (200, 10, 10)))
        inner = b.form('q 50 0 0 50 0 0 cm /Im Do Q', resources=f'/XObject << /Im {im} 0 R >>', bbox='0 0 100 100')
        outer = b.form('q 1 0 0 1 10 20 cm /Inner Do Q', resources=f'/XObject << /Inner {inner} 0 R >>', matrix='2 0 0 2 0 0')
        b.page('BT /F1 12 Tf (x) Tj ET q 1 0 0 1 100 100 cm /Outer Do Q q 20 0 0 20 5 5 cm /Im Do Q',
               {'Outer': outer, 'Im': im})
        walk = self.one(b.build())
        self.assertEqual([d.order for d in walk.draws], [0, 1])
        p0, p1 = (facts.placement_from_draw(d, walk) for d in walk.draws)
        # Inner image: 50×50 at (10,20) inside a form scaled ×2, placed at (100,100): 100×100 at (120, 140).
        self.assertEqual((p0['widthPt'], p0['heightPt']), (100.0, 100.0))
        self.assertEqual(p0['bbox'], [120.0, 792 - 240.0, 220.0, 792 - 140.0])
        self.assertEqual(walk.draws[0].text_before, 1)       # painted after the first text-show
        self.assertEqual(walk.text_ops, 1)
        self.assertEqual(p1['bbox'], [5.0, 792 - 25.0, 25.0, 792 - 5.0])

    def test_same_object_drawn_twice_is_two_draws_with_one_object_id(self):
        data, im = simple_pdf(place(30, 30, 10, 10) + place(30, 30, 100, 10))
        walk = self.one(data)
        self.assertEqual([d.obj for d in walk.draws], [(im, 0), (im, 0)])

    def test_inline_image_is_a_draw_without_object_identity(self):
        pixels = bytes(range(12))  # 2×2 RGB
        content = b'q 20 0 0 20 50 50 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ' + pixels + b'\nEI Q q 10 0 0 10 0 0 cm /Im Do Q'
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (1, 2, 3)))
        b.page(content, {'Im': im})
        walk = self.one(b.build())
        self.assertEqual([d.kind for d in walk.draws], ['inline', 'xobject'])
        self.assertIsNone(walk.draws[0].obj)

    def test_inline_image_with_ei_bytes_inside_the_data(self):
        pixels = b'\x00 EI \x00 EI ' + bytes(4)   # 2×2 RGB = 12 bytes, containing "EI" lookalikes
        content = b'q 20 0 0 20 50 50 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ' + pixels + b'\nEI Q'
        b = PdfBuilder()
        b.page(content, {})
        walk = self.one(b.build())
        self.assertEqual(len(walk.draws), 1)

    def test_alt_text_from_marked_content_and_from_the_structure_tree(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        content = ('/Span <</ActualText (Inline caption)>> BDC q 10 0 0 10 10 10 cm /Im Do Q EMC '
                    '/Figure <</MCID 0>> BDC q 10 0 0 10 40 10 cm /Im Do Q EMC '
                    '/Figure <</MCID 1>> BDC q 10 0 0 10 70 10 cm /Im Do Q EMC')
        b.page(content, {'Im': im})

        def tree(builder, pages):
            fig0 = builder.add(f'<< /Type /StructElem /S /Figure /P 99 0 R /Pg {pages[0]} 0 R /K 0 /Alt (A red square) >>')
            fig1 = builder.add(f'<< /Type /StructElem /S /Figure /Pg {pages[0]} 0 R /K 1 >>')
            return builder.add(f'<< /Type /StructTreeRoot /K [{fig0} 0 R {fig1} 0 R] >>')
        walk = self.one(b.build(struct_tree=tree))
        self.assertEqual([(d.alt, d.alt_source) for d in walk.draws],
                         [('Inline caption', 'marked-content'), ('A red square', 'struct-figure'), (None, None)])

    def test_pages_are_found_through_a_deep_page_tree_and_counts_skip_subtrees(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        for n in range(1, 41):
            b.page(place(10 * n, 10, 0, 0), {'Im': im})
        walk = self.walk(b.build(), 33, 35)
        self.assertEqual(sorted(walk), [33, 34, 35])
        self.assertEqual([facts.placement_from_draw(walk[n].draws[0], walk[n])['widthPt'] for n in (33, 34, 35)], [330.0, 340.0, 350.0])


class HostileInputTest(Scratch):
    def test_encrypted_documents_are_unknown_not_guessed(self):
        data = simple_pdf(place(10, 10, 0, 0))[0]
        data = data.replace(b'/Root', b'/Encrypt << /Filter /Standard >> /Root', 1)
        with self.assertRaises(facts.Unknown) as caught:
            self.walk(data)
        self.assertEqual(str(caught.exception), 'encrypted')

    def test_garbage_and_truncated_files_raise_unknown_never_crash(self):
        good = simple_pdf(place(10, 10, 0, 0))[0]
        for data in (b'', b'%PDF-1.7\n', b'x' * 5000, good[:len(good) // 2], good[:-30], b'%PDF-1.4\nstartxref\n99999999\n%%EOF'):
            with self.subTest(size=len(data)):
                try:
                    pages = self.walk(data)
                except facts.Unknown:
                    continue
                self.assertTrue(all(w.unknown or not w.draws for w in pages.values()))

    def test_form_cycles_and_deep_nesting_terminate(self):
        b = PdfBuilder()
        loop = b.reserve()
        b.form('/Self Do', resources=f'/XObject << /Self {loop} 0 R >>', num=loop)
        chain = b.form('q 1 0 0 1 1 1 cm /Self Do Q', resources=f'/XObject << /Self {loop} 0 R >>')
        b.page('/Chain Do', {'Chain': chain})
        started = time.monotonic()
        walk = self.walk(b.build())[1]
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(walk.draws, [])

    def test_huge_operand_and_operator_counts_hit_the_budget_not_memory(self):
        b = PdfBuilder()
        im = b.image(2, 2, solid_rgb(2, 2, (1, 1, 1)))
        b.page(('q ' * (facts.MAX_PAGE_OPERATIONS + 1000)) + place(1, 1, 0, 0) * 5, {'Im': im})
        walk = self.walk(b.build())[1]
        self.assertEqual(walk.unknown, 'operation-budget')
        self.assertEqual(walk.draws, [])      # unknown pages carry no draws: nothing is guessed from a partial walk
        b = PdfBuilder()                       # two million operands and no operator: the operand stack stays bounded
        b.page('1 ' * 2000000 + 'cm', {})
        walk = self.walk(b.build())[1]
        self.assertEqual((walk.unknown, walk.draws), (None, []))

    def test_too_many_draws_makes_the_page_unknown(self):
        b = PdfBuilder()
        im = b.image(2, 2, solid_rgb(2, 2, (1, 1, 1)))
        b.page('/Im Do\n' * (facts.MAX_PAGE_DRAWS + 1), {'Im': im})
        self.assertEqual(self.walk(b.build())[1].unknown, 'draw-budget')

    def test_flate_bombs_are_cut_at_the_decoded_limit(self):
        bomb = zlib.compress(b'q ' * (facts.MAX_PAGE_CONTENT // 2 + 1000))
        b = PdfBuilder()
        cs = b.add(b'<< /Filter /FlateDecode /Length %d >>\nstream\n' % len(bomb) + bomb + b'\nendstream')
        b.pages.append((cs, '/Resources << >> /MediaBox [0 0 100 100]'))
        started = time.monotonic()
        walk = self.walk(b.build())[1]
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn(walk.unknown, ('content-too-large', 'stream-too-large'))
        self.assertEqual(walk.draws, [])

    def test_predictor_row_bombs_are_refused_before_allocating(self):
        # 65 bytes of Flate data claiming 16384 columns of 65536 colors: one predictor row would be 1 GiB, and the row
        # buffers over 3 GB. Refused from the parameters alone, cheaply, under a 512 MiB address-space cap.
        tiny = zlib.compress(b'\x02' + b'\x00' * 64)
        params = {'Predictor': 12, 'Columns': 16384, 'Colors': 65536, 'BitsPerComponent': 8}
        script = '\n'.join([
            'import importlib.util, resource, zlib',
            'resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))',
            f'spec = importlib.util.spec_from_file_location("f", {str(HERE / "pdf_layout_facts.py")!r})',
            'f = importlib.util.module_from_spec(spec)',
            'spec.loader.exec_module(f)',
            'try:',
            f'    f.decode_filters(zlib.compress(bytes(65)), {{"Filter": "FlateDecode", "DecodeParms": {params!r}}})',
            'except f.Unknown as error:',
            '    print("refused", error)',
        ])
        started = time.monotonic()
        result = subprocess.run([sys.executable, '-I', '-c', script], capture_output=True, text=True, timeout=60)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('refused stream-too-large', result.stdout)
        with self.assertRaises(facts.Unknown):
            facts.decode_filters(tiny, {'Filter': 'FlateDecode', 'DecodeParms': params})

    def test_page_tree_cycles_and_wrong_counts_do_not_loop(self):
        b = PdfBuilder()
        pages_num = b.reserve()
        kid = b.add(f'<< /Type /Pages /Parent {pages_num} 0 R /Kids [{pages_num} 0 R] /Count 5 >>')
        b.add(f'<< /Type /Pages /Kids [{kid} 0 R {kid} 0 R] /Count 10 >>', pages_num)
        root = b.add(f'<< /Type /Catalog /Pages {pages_num} 0 R >>')
        out = bytearray(b'%PDF-1.7\n')
        offsets = {}
        for n in sorted(b.objects):
            offsets[n] = len(out)
            out += f'{n} 0 obj\n'.encode() + b.objects[n] + b'\nendobj\n'
        xref = len(out)
        out += f'xref\n0 {max(b.objects) + 1}\n'.encode() + b'0000000000 65535 f \n'
        for n in range(1, max(b.objects) + 1):
            out += f'{offsets[n]:010d} 00000 n \n'.encode()
        out += f'trailer\n<< /Size {max(b.objects) + 1} /Root {root} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
        started = time.monotonic()
        self.assertEqual(self.walk(bytes(out), 1, 3), {})
        self.assertLess(time.monotonic() - started, 5)

    def test_symlinked_input_is_refused(self):
        real = self.write(simple_pdf(place(10, 10, 0, 0))[0], 'real.pdf')
        link = Path(self.dir.name) / 'link.pdf'
        link.symlink_to(real)
        with self.assertRaises(OSError):
            facts.walk_document(str(link), 1, 1)

    def test_time_budget_makes_pages_unknown(self):
        data = simple_pdf(place(10, 10, 0, 0) * 3)[0]
        with self.assertRaises(facts.Unknown):
            self.walk(data, deadline=time.monotonic() - 1)



def xhtml(pages):
    """Text-layer xhtml for pages given as [(x, y, text), ...] lines; one <word> per token, 6pt per character."""
    out = ['<doc>']
    for lines in pages:
        out.append('<page width="612.000000" height="792.000000">')
        for x, y, text in lines:
            cursor = x
            for token in text.split():
                width = 6 * len(token)
                out.append(f'<word xMin="{cursor:.3f}" yMin="{y:.3f}" xMax="{cursor + width:.3f}" yMax="{y + 10:.3f}" fontName="F" fontSize="11">{token}</word>')
                cursor += width + 3
        out.append('</page>')
    return '\n'.join(out) + '\n</doc>'


class ReadingOrderTest(Scratch):
    def anchors(self, markdown, lines, images):
        height, words = facts.page_words(xhtml([lines]), [0])[0]
        return facts.block_anchors(markdown, words, images, height)

    def test_block_counting_matches_the_shared_vectors(self):
        # Core's own root (worker/scripts -> worker -> root), the same standalone or as the app's core/ checkout. A missing
        # vector file fails the test: the parity check never passes without the shared vectors.
        vectors = json.loads((CORE_ROOT / 'packages' / 'shared' / 'test-vectors' / 'markdown-blocks.json').read_text())
        self.assertGreater(len(vectors), 0)
        for vector in vectors:
            with self.subTest(vector['name']):
                self.assertEqual(facts.markdown_blocks(vector['page']), vector['blocks'])

    def test_single_column_figure_between_paragraphs(self):
        md = 'Heading One\n\nFirst paragraph body words here.\n\nSecond paragraph after the figure.'
        lines = [(72, 60, 'Heading One'), (72, 90, 'First paragraph body words here.'), (72, 400, 'Second paragraph after the figure.')]
        [a] = self.anchors(md, lines, [(72, 200, 272, 320)])
        self.assertEqual((a['block'], a['blocks'], a['method'], a['matchedBlocks']), (2, 3, 'aligned', 3))

    def test_image_above_everything_and_below_everything(self):
        md = 'Alpha beta gamma delta.\n\nEpsilon zeta eta theta.'
        lines = [(72, 100, 'Alpha beta gamma delta.'), (72, 140, 'Epsilon zeta eta theta.')]
        top, bottom, background = self.anchors(md, lines, [(72, 20, 200, 80), (72, 600, 200, 700), (0, 0, 612, 792)])
        self.assertEqual((top['block'], bottom['block'], background['block']), (0, 2, 0))

    def test_two_columns_use_the_figures_own_column_not_document_order(self):
        # Markdown order is left column then right column. A figure in the right column between its two paragraphs
        # goes before the right column's second paragraph (block 3), not after the left column's tall block.
        md = 'Left one words.\n\nLeft two words.\n\nRight one words.\n\nRight two words.'
        lines = [(72, 100, 'Left one words.'), (72, 400, 'Left two words.'), (330, 100, 'Right one words.'), (330, 450, 'Right two words.')]
        [right, left] = self.anchors(md, lines, [(330, 200, 540, 330), (72, 200, 280, 330)])
        self.assertEqual(right['block'], 3)
        self.assertEqual(left['block'], 1)

    def test_full_width_figure_goes_after_the_text_above_it(self):
        md = 'Top left words.\n\nTop right words.\n\nBottom left words.\n\nBottom right words.'
        lines = [(72, 60, 'Top left words.'), (330, 60, 'Top right words.'), (72, 500, 'Bottom left words.'), (330, 500, 'Bottom right words.')]
        [a] = self.anchors(md, lines, [(72, 200, 540, 400)])
        self.assertEqual(a['block'], 2)

    def test_blocks_without_a_text_match_are_never_references(self):
        md = 'Intro words here.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nClosing words here.'
        lines = [(72, 60, 'Intro words here.'), (72, 600, 'Closing words here.')]
        [a] = self.anchors(md, lines, [(72, 300, 200, 400)])
        self.assertEqual((a['block'], a['method'], a['matchedBlocks']), (2, 'aligned', 2))   # before "Closing"; the table is ignored

    def test_no_alignment_is_reported_as_a_fallback_not_an_alignment(self):
        md = 'Alpha beta.\n\nGamma delta.'
        top, bottom, unknown = self.anchors(md, [(72, 100, 'unrelated words only')], [(72, 20, 200, 80), (72, 700, 200, 760), None])
        self.assertEqual((top['method'], top['block']), ('page-start', 0))
        self.assertEqual((bottom['method'], bottom['block']), ('page-end', 2))
        self.assertEqual((unknown['method'], unknown['block']), ('page-end', 2))
        [empty] = facts.block_anchors('', [], [(0, 0, 10, 10)])
        self.assertEqual((empty['block'], empty['blocks'], empty['method']), (0, 0, 'page-start'))

    def test_repeated_phrases_match_in_reading_order(self):
        md = 'Total amount due.\n\nNotes on payment.\n\nTotal amount due.'
        lines = [(72, 100, 'Total amount due.'), (72, 140, 'Notes on payment.'), (72, 500, 'Total amount due.')]
        [a] = self.anchors(md, lines, [(72, 300, 200, 400)])
        self.assertEqual(a['block'], 2)

    def test_hostile_markup_and_sizes_stay_bounded(self):
        words = facts.page_words('<page>' + '<word xMin="1" yMin="1" xMax="2" yMax="2">w</word>' * (facts.MAX_ANCHOR_WORDS + 5) + '</page>', [0])
        self.assertEqual(words, {})                                                  # too many words: not aligned, not trusted
        started = time.monotonic()
        md = '\n\n'.join(f'block {i} text' for i in range(facts.MAX_ANCHOR_BLOCKS + 10))
        [a] = facts.block_anchors(md, [(0, 0, 1, 1, 'x')], [(0, 0, 10, 10)])
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(a['method'], 'page-end')                                   # too many blocks: every image takes the fallback
        self.assertEqual(facts.page_words('<page><word xMin="a" yMin="1" xMax="2" yMax="2">w</word></page>', [0]), {0: (None, [])})
        [b] = facts.block_anchors('<script>alert(1)</script>\n\n](x)(y)', [(0, 0, 5, 5, 'alert')], [(0, 0, 1, 1)])
        self.assertIn(b['method'], ('aligned', 'page-start', 'page-end'))



class LayoutFactsTest(unittest.TestCase):
    """pdf-layout-facts@1: images with stream facts and text overlap, and tables with rows, columns and coverage."""
    FIXTURES = HERE.parent / 'testdata' / 'pdf-fixtures'

    def test_markdown_tables_count_rows_without_the_separator(self):
        page = 'Intro paragraph.\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nAfter.'
        self.assertEqual([(t['rows'], t['columns']) for t in facts.markdown_tables(page)], [(3, 3)])
        html = '<table>\n<tr><td>a</td><td>b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>'
        self.assertEqual([(t['rows'], t['columns']) for t in facts.markdown_tables(html)], [(2, 2)])
        self.assertEqual(facts.markdown_tables('- one\n- two\n- three'), [])

    def test_table_box_matches_cells_in_reading_order(self):
        words = [(0, 0, 10, 10, 'common'), (100, 500, 110, 510, 'alpha'), (120, 500, 130, 510, '2025-10-01'), (100, 520, 110, 530, 'beta'), (300, 700, 310, 710, 'common')]
        box = facts.table_box(['alpha', '2025', '10', '01', 'beta'], words, set())
        self.assertEqual(box, [100, 500, 130, 530])
        self.assertIsNone(facts.table_box(['zulu', 'yankee', 'xray'], words, set()))

    def test_repeated_objects_are_furniture(self):
        rows = [{'role': 'image', 'objectId': (7, 0), 'pageNumber': p} for p in range(1, 6)] + [{'role': 'image', 'objectId': (9, 0), 'pageNumber': 2}]
        self.assertEqual(facts.repeated_objects(rows, 5), {(7, 0)})

    @unittest.skipUnless(shutil.which('pdfimages') and shutil.which('pdftotext'), 'needs poppler-utils')
    def test_public_fixtures(self):
        def run(name, pages):
            source = self.FIXTURES / name
            listing = subprocess.run(['pdfimages', '-list', str(source)], capture_output=True, text=True, check=True).stdout
            with tempfile.TemporaryDirectory() as d:
                xhtml_path = Path(d) / 'layout.xhtml'
                subprocess.run(['pdftotext', '-bbox-layout', str(source), str(xhtml_path)], check=True)
                xhtml = xhtml_path.read_text()
            markdown = (self.FIXTURES / 'doppler-md' / (name + '.md')).read_text().split('\f')
            return facts.layout_facts(str(source), listing, xhtml, {i + 1: m for i, m in enumerate(markdown)}, 1, pages)['pages']
        [scan] = run('kreuzberg-handwriting-notes.pdf', 1)
        image = scan['images'][0]
        self.assertTrue(scan['known'])
        self.assertGreater(scan['words'], 30)
        self.assertGreater(image['coverage'], 0.3)
        self.assertEqual(image['wordsInside'], 0)
        self.assertFalse(image['repeated'])
        self.assertLess(image['bytesPerPixel'], 0.1)
        [prose] = run('kreuzberg-metadata-document.pdf', 1)
        self.assertEqual([(t['rows'], t['columns']) for t in prose['tables']], [(4, 3)])
        self.assertLess(prose['tables'][0]['coverage'], 0.4)
        for page in run('tables-multipage-financials.pdf', 3):
            self.assertGreaterEqual(page['tables'][0]['rows'], 5)

    @unittest.skipUnless(shutil.which('pdfimages'), 'needs poppler-utils')
    def test_chunks_share_the_whole_range_furniture(self):
        source = self.FIXTURES / 'routing-letterhead-logo.pdf'
        listing = subprocess.run(['pdfimages', '-list', str(source)], capture_output=True, text=True, check=True).stdout
        rows = []
        for line in listing.split('\n')[2:]:
            if line.split():
                rows.append(facts.parse_listing_row(line.split()))
        pages = max(row['pageNumber'] for row in rows)
        whole = facts.layout_facts(str(source), listing, None, None, 1, pages)['pages']
        furniture = facts.repeated_objects(rows, pages)
        chunk = facts.layout_facts(str(source), listing, None, None, 2, 2, repeated=furniture)['pages']
        self.assertTrue(whole[1]['images'][0]['repeated'])
        self.assertEqual(chunk[0]['images'], whole[1]['images'])
        self.assertFalse(facts.layout_facts(str(source), listing, None, None, 2, 2, repeated=set())['pages'][0]['images'][0]['repeated'])

    def test_tables_only_gives_the_full_walks_tables_grids_and_coverage(self):
        """content=False (the first-pass batch's table facts, council #340 C7): no content stream is read, and every public
        fixture's tables, grids and table coverage equal the full walk's. Synthetic word boxes and ruling lines (a ruled
        4x5 grid and a table's cells) so the test needs no external binary; Poppler's own XHTML too when it is installed."""
        def xhtml_for(pages):
            body = []
            for _ in range(pages):
                rules = ''.join(f'<rule xMin="72" yMin="{100 + 30 * r}" xMax="540" yMax="{100.5 + 30 * r}"/>' for r in range(6))
                rules += ''.join(f'<rule xMin="{72 + 117 * c}" yMin="100" xMax="{72.5 + 117 * c}" yMax="250"/>' for c in range(5))
                words = ''.join(f'<word xMin="{80 + 40 * i}" yMin="300" xMax="{110 + 40 * i}" yMax="310">w{i}</word>' for i in range(6))
                body.append(f'<page width="612" height="792"><flow><block><line>{words}</line></block></flow>{rules}</page>')
            return '<html><body><doc>' + ''.join(body) + '</doc></body></html>'
        names = sorted(p.name for p in self.FIXTURES.glob('*.pdf'))
        self.assertGreater(len(names), 10)
        compared = 0
        for name in names:
            source = str(self.FIXTURES / name)
            md_path = self.FIXTURES / 'doppler-md' / (name + '.md')
            markdown = md_path.read_text().split('\f') if md_path.exists() else ['| a | b |\n| --- | --- |\n| w0 | w1 |']
            pages = min(len(markdown), 8)
            texts = [xhtml_for(pages)]
            if shutil.which('pdftotext'):
                with tempfile.TemporaryDirectory() as d:
                    out = Path(d) / 'layout.xhtml'
                    if subprocess.run(['pdftotext', '-bbox-layout', '-f', '1', '-l', str(pages), source, str(out)], capture_output=True).returncode == 0:
                        texts.append(out.read_text(errors='replace'))
            for xhtml in texts:
                md = {i + 1: m for i, m in enumerate(markdown[:pages])}
                full = facts.layout_facts(source, None, xhtml, md, 1, pages)['pages']
                lean = facts.layout_facts(source, None, xhtml, md, 1, pages, content=False)['pages']
                for a, b in zip(full, lean):
                    if not a['known']:
                        continue  # the full walk gave up on this page's content: the batch then reports more, never less
                    with self.subTest(fixture=name, page=a['pageNumber']):
                        self.assertTrue(b['known'])
                        self.assertEqual((b['tables'], b['grids'], b['tableCoverage'], b.get('widthPt'), b.get('heightPt')),
                                         (a['tables'], a['grids'], a['tableCoverage'], a.get('widthPt'), a.get('heightPt')))
                        self.assertIsNone(b['images'])
                        compared += 1
        self.assertGreater(compared, 10)

    def test_page_list_gives_the_whole_runs_entries_for_those_pages(self):
        """`pages` (the selective walker's per-page list): only the listed pages come back, in page order, each equal to a
        run over the whole range, for a full walk and tables only, with synthetic and (when installed) Poppler XHTML and
        `pdfimages -list` rows; pages left out are neither walked nor reported."""
        def xhtml_for(pages):
            body = []
            for page in range(pages):
                rules = ''.join(f'<rule xMin="72" yMin="{100 + 30 * r}" xMax="540" yMax="{100.5 + 30 * r}"/>' for r in range(2 + page % 4))
                rules += ''.join(f'<rule xMin="{72 + 117 * c}" yMin="100" xMax="{72.5 + 117 * c}" yMax="250"/>' for c in range(5))
                words = ''.join(f'<word xMin="{80 + 40 * i}" yMin="300" xMax="{110 + 40 * i}" yMax="310">w{i}</word>' for i in range(2 + page))
                body.append(f'<page width="612" height="792"><flow><block><line>{words}</line></block></flow>{rules}</page>')
            return '<html><body><doc>' + ''.join(body) + '</doc></body></html>'
        compared = 0
        for name in sorted(p.name for p in self.FIXTURES.glob('*.pdf')):
            source = str(self.FIXTURES / name)
            md_path = self.FIXTURES / 'doppler-md' / (name + '.md')
            markdown = md_path.read_text().split('\f') if md_path.exists() else ['| a | b |\n| --- | --- |\n| w0 | w1 |']
            pages = min(len(markdown), 8)
            if pages < 2:
                continue
            texts = [xhtml_for(pages)]
            listing = None
            if shutil.which('pdftotext'):
                with tempfile.TemporaryDirectory() as d:
                    out = Path(d) / 'layout.xhtml'
                    if subprocess.run(['pdftotext', '-bbox-layout', '-f', '1', '-l', str(pages), source, str(out)], capture_output=True).returncode == 0:
                        texts.append(out.read_text(errors='replace'))
            if shutil.which('pdfimages'):
                done = subprocess.run(['pdfimages', '-list', '-f', '1', '-l', str(pages), source], capture_output=True, text=True)
                listing = done.stdout if done.returncode == 0 else None
            md = {i + 1: m for i, m in enumerate(markdown[:pages])}
            for wanted in ([pages], [1, pages], list(range(2, pages + 1, 2))):
                for xhtml in texts:
                    for content in (True, False):
                        whole = facts.layout_facts(source, listing, xhtml, md, 1, pages, content=content)['pages']
                        some = facts.layout_facts(source, listing, xhtml, md, 1, pages, content=content, pages=wanted)['pages']
                        with self.subTest(fixture=name, pages=wanted, content=content):
                            self.assertEqual([page['pageNumber'] for page in some], sorted(set(wanted)))
                            self.assertEqual(some, [whole[number - 1] for number in sorted(set(wanted))])
                            compared += len(some)
        self.assertGreater(compared, 40)

    def test_page_list_only_walks_the_listed_pages(self):
        b = PdfBuilder()
        im = b.image(4, 4, rgb_gradient(4, 4))
        for _ in range(6):
            b.page(place(20, 20, 10, 10), {'Im': im})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'x.pdf'
            path.write_bytes(b.build())
            walked = []
            original = facts.walk_document

            def spy(*args, **kwargs):
                result = original(*args, **kwargs)
                walked.append(sorted(result))
                return result
            facts.walk_document = spy
            try:
                result = facts.layout_facts(str(path), None, None, None, 1, 6, pages=[5, 2])
            finally:
                facts.walk_document = original
        self.assertEqual(walked, [[2, 5]])
        self.assertEqual([page['pageNumber'] for page in result['pages']], [2, 5])
        for bad in ([], [0], [7], [2, '3'], [True], [2.0]):
            with self.subTest(pages=bad), self.assertRaises(ValueError):
                facts.layout_facts(str(path), None, None, None, 1, 6, pages=bad)

    def test_page_list_text_is_strict_and_bounded(self):
        self.assertEqual(facts.parse_page_list('3,5,9-12', 1, 32), [3, 5, 9, 10, 11, 12])
        self.assertEqual(facts.parse_page_list('20000', 19969, 20000), [20000])
        for pages in ([1], [3, 5, 6, 7, 32], list(range(1, 33)), [2, 4, 6, 8]):
            self.assertEqual(facts.parse_page_list(facts.format_page_list(pages), 1, 32), pages)
        self.assertEqual(facts.format_page_list([3, 5, 6, 7]), '3,5-7')
        for bad in ('', ',', '1,', '0', '33', '5-3', '1-40', ' 1', '1 ', '+1', '-1', '1--2', '1-2-3', '0x10', '١', '1' * 8,
                    'a', '1;2', '7,7', '6-8,7', '5,3', '1-5,5-9', None, 5):
            with self.subTest(text=bad), self.assertRaises(ValueError):
                facts.parse_page_list(bad, 1, 32)
        started = time.monotonic()
        for hostile in (','.join(['1'] * (facts.MAX_LAYOUT_PAGES + 1)), ','.join([f'1-{facts.MAX_LAYOUT_PAGES}'] * 4_000),
                        '1-9999999', '1' * 1_000_000, ',' * 100_000):
            with self.assertRaises(ValueError):
                facts.parse_page_list(hostile, 1, facts.MAX_LAYOUT_PAGES)
        self.assertLess(time.monotonic() - started, 1)
        # A whole 5,000-page range in its compact form parses quickly and expands to exactly the range.
        self.assertEqual(len(facts.parse_page_list(f'1-{facts.MAX_LAYOUT_PAGES}', 1, facts.MAX_LAYOUT_PAGES)), facts.MAX_LAYOUT_PAGES)

    def test_cli_page_list(self):
        source = self.FIXTURES / 'tables-multipage-financials.pdf'
        markdown = (self.FIXTURES / 'doppler-md' / (source.name + '.md')).read_text()
        with tempfile.TemporaryDirectory() as d:
            md = Path(d) / 'x.md'
            md.write_text(markdown)
            run = lambda *extra: subprocess.run([sys.executable, '-I', str(HERE / 'pdf_layout_facts.py'), '--input', str(source),
                                                 '--first', '1', '--last', '3', '--markdown', str(md), '--tables-only', *extra],
                                                capture_output=True, text=True, timeout=60)
            whole, some = run(), run('--pages', '1,3')
            self.assertEqual(whole.returncode, 0, whole.stderr)
            self.assertEqual(some.returncode, 0, some.stderr)
            pages = json.loads(whole.stdout)['pages']
            self.assertEqual(json.loads(some.stdout)['pages'], [pages[0], pages[2]])
            for bad in ('0', '4', '1-4', 'x', ''):
                with self.subTest(pages=bad):
                    self.assertNotEqual(run('--pages', bad).returncode, 0)

    def test_unknown_inputs_are_null_never_zero(self):
        data = PdfBuilder().build() if hasattr(PdfBuilder(), 'build') else None
        if data is None:
            self.skipTest('builder has no default document')
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'x.pdf'
            path.write_bytes(data)
            [page] = facts.layout_facts(str(path), None, None, None, 1, 1)['pages']
        self.assertIsNone(page['images'])
        self.assertIsNone(page['tables'])
        self.assertIsNone(page['words'])


class LinearRegexTest(unittest.TestCase):
    """Council K #3: regexes over extracted text stay linear on unclosed `<`, `](` and `<page` runs (and pipe lines)."""

    def test_hostile_runs_scan_quickly(self):
        import time
        n = 256 * 1024
        for regex, text in [(facts._TAG, '<' * n), (facts._LINK_TARGET, '](' * (n // 2)),
                            (facts._PAGE, '<page ' * (n // 6))]:
            started = time.monotonic()
            regex.sub('', text)
            self.assertLess(time.monotonic() - started, 0.25, regex.pattern)
        started = time.monotonic()
        facts.markdown_tables('|' + ' ' * (8 * 1024 - 2) + 'x\n' + '| a |\n' * 4)
        self.assertLess(time.monotonic() - started, 0.25)


if __name__ == '__main__':
    unittest.main()
