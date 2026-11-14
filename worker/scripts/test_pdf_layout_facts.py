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
        with self.assertRaises(facts.Unknown) as caught:
            self.walk(bytes(out), 1, 3)
        self.assertEqual(str(caught.exception), 'page-tree-shared')
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
        for bad in ([], [0], [7], [2, '3'], [True], [2.0], 5, None.__class__):
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

    def test_dots_cannot_use_up_the_rule_budget_and_a_page_over_it_is_unknown(self):
        def page(rules):
            return '<page width="612" height="792">' + ''.join(
                f'<rule xMin="{a}" yMin="{b}" xMax="{c}" yMax="{d}"/>' for a, b, c, d in rules) + '</page>'
        grid = [(72, 100 + 30 * r, 540, 100.5 + 30 * r) for r in range(6)] + [(72 + 117 * c, 100, 72.5 + 117 * c, 250) for c in range(5)]
        dots = [(10 + (i % 500), 700 + i // 500, 10.5 + (i % 500), 700.5 + i // 500) for i in range(6000)]
        xhtml = '<doc>' + page(dots + grid) + page(dots) + page(grid * 500) + '</doc>'
        rules = facts.page_rules(xhtml, [0, 1, 2])
        self.assertEqual(len(rules[0]), len(grid))          # the dots are dropped as they are read; the table is seen
        self.assertEqual(facts.ruled_grids(rules[0])[0]['columns'], 4)
        self.assertEqual(rules[1], [])                      # dots alone: known, no grid
        self.assertNotIn(2, rules)                          # more usable rules than the budget: unknown, never cut short

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


# ---- page tree: one checked walk per document (PageIndex), hostile trees, parity with the pre-index walk ----

def raw_pdf(objects, root_pages, catalog_extra=''):
    """A classic-xref PDF from raw object bodies ({num: body}); the catalog points /Pages at `root_pages` (a ref string
    like '3 0 R' or a direct dictionary). Object numbers missing from `objects` are free xref entries."""
    objects = dict(objects)
    catalog = max(objects, default=0) + 1
    objects[catalog] = f'<< /Type /Catalog /Pages {root_pages} {catalog_extra} >>'
    out = bytearray(b'%PDF-1.7\n')
    offsets = {}
    for n in sorted(objects):
        offsets[n] = len(out)
        out += f'{n} 0 obj\n'.encode() + objects[n].encode('latin-1') + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {catalog + 1}\n'.encode() + b'0000000000 65535 f \n'
    for n in range(1, catalog + 1):
        out += f'{offsets[n]:010d} 00000 n \n'.encode() if n in offsets else b'0000000000 00000 f \n'
    out += f'trailer\n<< /Size {catalog + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    return bytes(out)


class TreeBuilder:
    """Page trees from a nested spec. A page is `'P'` (its MediaBox width is 100 + its depth-first leaf number, so geometry
    names the page); a node is a dict: `kids`, optional `count` ('auto' is the true count, None leaves it out, anything else
    is written as is), `extra` (inheritable attributes), `inline` (a direct dictionary in its parent's Kids), `kids_ref`
    (the Kids array as its own object). The string 'null' and 'free' are kids that are not dictionaries."""

    def __init__(self):
        self.objects, self.next, self.leaves = {}, 1, 0

    def reserve(self):
        self.next += 1
        return self.next - 1

    def page(self):
        self.leaves += 1
        return f'<< /Type /Page /MediaBox [0 0 {100 + self.leaves} 300] >>', 1

    def node(self, spec):
        """(body, pages under it)."""
        if spec == 'P':
            return self.page()
        refs, total = [], 0
        for kid in spec['kids']:
            if kid == 'null':
                refs.append('null')
                continue
            if kid == 'free':
                refs.append(f'{self.reserve()} 0 R')
                continue
            body, pages = self.node(kid)
            total += pages
            if isinstance(kid, dict) and kid.get('inline'):
                refs.append(body)
            else:
                num = self.reserve()
                self.objects[num] = body
                refs.append(f'{num} 0 R')
        kids = f'[{" ".join(refs)}]'
        if spec.get('kids_ref'):
            num = self.reserve()
            self.objects[num] = kids
            kids = f'{num} 0 R'
        count = spec.get('count', 'auto')
        count = '' if count is None else f'/Count {total if count == "auto" else count}'
        return f'<< /Type /Pages /Kids {kids} {count} {spec.get("extra", "")} >>', total

    def build(self, spec):
        body, _ = self.node(spec)
        root = self.reserve()
        self.objects[root] = body
        return raw_pdf(self.objects, f'{root} 0 R')


def legacy_iter_pages(file, first, last):
    """The page-tree walk before PageIndex (core c7256e7b), kept as the parity reference: it skipped subtrees by /Count."""
    root = file.deref(file.catalog.get('Pages'))
    if not isinstance(root, dict):
        raise facts.Unknown('no-page-tree')
    visited, nodes, number = set(), [0], [1]

    def visit(ref, node, trail, depth):
        if depth > facts.MAX_TREE_DEPTH:
            raise facts.Unknown('tree-depth')
        nodes[0] += 1
        if nodes[0] > facts.MAX_TREE_NODES:
            raise facts.Unknown('tree-size')
        kids = file.deref(node.get('Kids'))
        if not isinstance(kids, list) or node.get('Type') == 'Page':
            if first <= number[0] <= last:
                yield number[0], node, (ref.num if isinstance(ref, facts.Ref) else None), trail
            number[0] += 1
            return
        for kid in kids:
            if number[0] > last:
                return
            child = file.deref(kid)
            if not isinstance(child, dict):
                continue
            if isinstance(kid, facts.Ref):
                if kid.num in visited:
                    continue
                visited.add(kid.num)
            count = file.deref(child.get('Count'))
            is_node = isinstance(file.deref(child.get('Kids')), list) and child.get('Type') != 'Page'
            if is_node and isinstance(count, int) and 0 <= count and number[0] + count - 1 < first:
                number[0] += count
                continue
            yield from visit(kid, child, [child] + trail, depth + 1)

    yield from visit(None, root, [root], 0)


def geometry(file, pages):
    out = {}
    for number, page, objnum, trail in pages:
        walk = facts.PageWalk(number, objnum)
        facts._page_geometry(file, page, trail, walk)
        out[number] = (objnum, walk.width, walk.height, walk.rotate, walk.media, walk.crop)
    return out


def random_tree(rng, depth=0, budget=None):
    """A random intact tree of at most ~80 pages (`budget` counts the nodes left to place)."""
    budget = budget if budget is not None else [80]
    if depth >= 5 or budget[0] <= 0 or (depth and rng.random() < 0.45):
        budget[0] -= 1
        return 'P'
    kids = [random_tree(rng, depth + 1, budget) for _ in range(rng.randint(0 if depth else 1, 6))]
    spec = {'kids': kids, 'count': rng.choice(['auto', 'auto', 'auto', None, '2.0', '/Seven'])}
    if rng.random() < 0.3:
        spec['extra'] = rng.choice(['/Rotate 90', '/MediaBox [0 0 500 700]', '/CropBox [10 10 90 200] /Rotate 270'])
    spec['inline'] = depth > 0 and rng.random() < 0.15
    spec['kids_ref'] = rng.random() < 0.2
    return spec


class PageIndexTest(Scratch):
    def index(self, data):
        return facts.page_index(self.write(data))

    def assert_unknown(self, data, reason):
        result = self.index(data)
        self.assertIsInstance(result, facts.Unknown)
        self.assertEqual(str(result), reason)
        with self.assertRaises(facts.Unknown) as caught:
            self.walk(data, 1, 3)
        self.assertEqual(str(caught.exception), reason)

    def test_parity_with_the_count_skipping_walk_on_intact_trees_for_every_range(self):
        import random
        rng = random.Random(20261114)
        checked = 0
        for case in range(80):
            data = TreeBuilder().build(random_tree(rng))
            path = self.write(data, f'tree-{case}.pdf')
            index = facts.page_index(path)
            if isinstance(index, facts.Unknown) and str(index) == 'no-pages':   # a tree of empty nodes
                continue
            self.assertIsInstance(index, facts.PageIndex, case)
            index = facts.PageIndex.loads(index.dumps())
            file = facts.PdfFile(path)
            try:
                for size in (1, 7, 32):
                    for first in range(1, index.pages + 2, 1 if size == 1 else 3):
                        last = first + size - 1
                        expected = geometry(file, legacy_iter_pages(file, first, last))
                        got = geometry(file, facts.indexed_pages(file, index, range(first, last + 1)))
                        self.assertEqual(got, expected, (case, first, last))
                        checked += 1
            finally:
                file.close()
        self.assertGreater(checked, 1000)

    def test_parity_of_whole_walks_with_content_and_explicit_page_lists(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        for n in range(1, 71):
            b.page(place(10 * n, 10, 0, 0), {'Im': im}, rotate=90 * (n % 4))
        path = self.write(b.build())
        index = facts.page_index(path)
        for first, last, only in ((1, 32, None), (33, 64, None), (65, 96, None), (33, 64, {34, 40, 64}), (40, 40, None)):
            walks = facts.walk_document(path, first, last, only_pages=only, index=index)
            plain = facts.walk_document(path, first, last, only_pages=only)
            self.assertEqual(sorted(walks), sorted(plain))
            self.assertEqual(sorted(walks), sorted(n for n in range(first, min(last, 70) + 1) if only is None or n in only))
            for n in walks:
                self.assertEqual((walks[n].objnum, walks[n].rotate, walks[n].width, walks[n].height),
                                 (plain[n].objnum, plain[n].rotate, plain[n].width, plain[n].height))
                self.assertEqual(facts.placement_from_draw(walks[n].draws[0], walks[n]), facts.placement_from_draw(plain[n].draws[0], plain[n]))

    def test_a_lying_count_fails_closed_instead_of_moving_pages(self):
        for lie in (0, 1, 5, 99999999999, 'true'):
            spec = {'kids': [{'kids': ['P', 'P', 'P'], 'count': lie}, 'P', 'P']}
            self.assert_unknown(TreeBuilder().build(spec), 'page-tree-count')
        # A /Count that is not a non-negative integer was never used to skip, so it changes nothing.
        for ignored in ('-4', '2.0', '/Name', '(3)', '[3]'):
            data = TreeBuilder().build({'kids': [{'kids': ['P', 'P', 'P'], 'count': ignored}, 'P', 'P']})
            walks = self.walk(data, 4, 5)
            self.assertEqual({n: w.width for n, w in walks.items()}, {4: 104.0, 5: 105.0})
        # The root's /Count is the document's page count: renderers stop there, so it must agree too.
        self.assert_unknown(TreeBuilder().build({'kids': ['P', 'P'], 'count': 7}), 'page-tree-count')
        self.assertEqual(sorted(self.walk(TreeBuilder().build({'kids': ['P', 'P'], 'count': '/Seven'}), 1, 9)), [1, 2])

    def test_shared_kids_and_cycles_fail_closed(self):
        page = '<< /Type /Page /MediaBox [0 0 100 100] >>'
        shared_leaf = raw_pdf({1: page, 2: '<< /Type /Pages /Kids [1 0 R 1 0 R] /Count 2 >>'}, '2 0 R')
        shared_node = raw_pdf({1: page, 2: '<< /Type /Pages /Kids [1 0 R] /Count 1 >>',
                               3: '<< /Type /Pages /Kids [2 0 R 2 0 R] /Count 2 >>'}, '3 0 R')
        to_root = raw_pdf({1: page, 2: '<< /Type /Pages /Kids [1 0 R 2 0 R] /Count 1 >>'}, '2 0 R')
        loop = raw_pdf({1: page, 2: '<< /Type /Pages /Kids [3 0 R] >>', 3: '<< /Type /Pages /Kids [1 0 R 2 0 R] >>',
                        4: '<< /Type /Pages /Kids [2 0 R] >>'}, '4 0 R')
        for data in (shared_leaf, shared_node, to_root, loop):
            started = time.monotonic()
            self.assert_unknown(data, 'page-tree-shared')
            self.assertLess(time.monotonic() - started, 5)

    def test_deep_wide_and_broken_trees_are_bounded(self):
        spec = 'P'
        for _ in range(facts.MAX_TREE_DEPTH + 1):
            spec = {'kids': [spec]}
        self.assert_unknown(TreeBuilder().build(spec), 'tree-depth')
        spec = 'P'
        for _ in range(facts.MAX_TREE_DEPTH - 1):
            spec = {'kids': [spec]}
        self.assertEqual(self.index(TreeBuilder().build(spec)).pages, 1)
        original = facts.MAX_TREE_NODES
        facts.MAX_TREE_NODES = 50
        try:
            self.assert_unknown(TreeBuilder().build({'kids': ['P'] * 60}), 'tree-size')
        finally:
            facts.MAX_TREE_NODES = original
        # A kid that is not a dictionary (null, a free object), or a /Pages node without a Kids array: renderers disagree
        # on whether it takes a page number, so the tree fails closed rather than guess.
        for kids in (['P', 'null', 'P'], ['P', 'free', 'P'], ['P', {'kids': ['free', 'P']}, 'P']):
            self.assert_unknown(TreeBuilder().build({'kids': kids}), 'page-tree-kid')
        page = '<< /Type /Page /MediaBox [0 0 100 100] >>'
        for odd in ('<< /Type /Pages /Count 1 >>', '<< /Type /Pages /Kids 7 /Count 1 >>', '42'):
            data = raw_pdf({1: page, 2: odd, 3: page, 4: '<< /Type /Pages /Kids [1 0 R 2 0 R 3 0 R] >>'}, '4 0 R')
            self.assert_unknown(data, 'page-tree-kid')
        # A kid whose object is broken makes the whole tree unknown, wherever the chunk is.
        data = TreeBuilder().build({'kids': ['P', 'P', 'P']})
        broken = data.replace(b'2 0 obj', b'9 0 obj', 1)
        self.assert_unknown(broken, 'object-mismatch')
        self.assert_unknown(raw_pdf({}, '<< /Type /Pages /Kids [] /Count 0 >>'), 'no-pages')
        self.assert_unknown(raw_pdf({1: '[1 2 3]'}, '1 0 R'), 'no-page-tree')

    def test_a_flat_ten_thousand_page_tree_is_indexed_once_and_each_chunk_loads_only_its_pages(self):
        pages = 10_000
        objects = {n: f'<< /Type /Page /MediaBox [0 0 {n} 300] >>' for n in range(1, pages + 1)}
        objects[pages + 1] = f'<< /Type /Pages /Kids [{" ".join(f"{n} 0 R" for n in range(1, pages + 1))}] /Count {pages} >>'
        path = self.write(raw_pdf(objects, f'{pages + 1} 0 R'))
        index = facts.page_index(path)
        self.assertEqual(index.pages, pages)
        self.assertLess(len(index.dumps()), 150_000)
        loads = []
        original = facts.PdfFile.load

        def counting(file, num):
            if num not in file.cache:
                loads.append(num)
            return original(file, num)
        facts.PdfFile.load = counting
        try:
            costs = {}
            for first in (1, 5001, 9969):
                del loads[:]
                walks = facts.walk_document(path, first, first + 31, content=False, index=index)
                costs[first] = len(loads)
                self.assertEqual(walks[first].width, float(first))
        finally:
            facts.PdfFile.load = original
        self.assertEqual(costs[1], costs[5001])
        self.assertEqual(costs[1], costs[9969])
        self.assertLessEqual(costs[9969], 40)

    def test_index_records_are_strict_and_bound_to_their_file(self):
        data = TreeBuilder().build({'kids': [{'kids': ['P', 'P']}, 'P']})
        path = self.write(data)
        index = facts.page_index(path)
        blob = index.dumps()
        self.assertEqual(facts.PageIndex.loads(blob).pages, 3)
        header = facts.PageIndex.HEADER
        bad = [blob[:-1], blob + b'\0', b'X' + blob[1:], b'', blob[:header.size]]
        # parent not before its child; a slot past its parent's Kids; leaf parent out of range; negative slot; bad object
        magic, size, root, nodes, n = header.unpack_from(blob)
        body = bytearray(blob[header.size:])
        for offset, value in ((4 * 1, 1), (4 * (nodes + 1), 9), (4 * (3 * nodes), nodes), (4 * (3 * nodes + n), -2),
                              (4 * (3 * nodes + 2 * n), -5)):
            changed = bytearray(body)
            changed[offset:offset + 4] = value.to_bytes(4, 'little', signed=True)
            bad.append(blob[:header.size] + bytes(changed))
        bad.append(header.pack(magic, size, root, facts.MAX_TREE_NODES + 1, n) + bytes(body))
        for item in bad:
            with self.assertRaises(ValueError):
                facts.PageIndex.loads(item)
        # The same index on another file (another size or page-tree root) is refused, never followed.
        other = self.write(TreeBuilder().build({'kids': ['P', 'P', 'P', 'P']}), 'other.pdf')
        with self.assertRaises(facts.Unknown) as caught:
            facts.walk_document(other, 1, 3, index=index)
        self.assertEqual(str(caught.exception), 'page-index')
        # A path that no longer matches the tree (a slot off the end, a page where a node should be) is refused.
        moved = facts.PageIndex(index.size, index.root, index.node_parent, index.node_slot, index.node_kids, index.leaf_parent,
                                facts.array.array('i', [0, 7, 1]), index.leaf_object)
        with self.assertRaises(facts.Unknown):
            facts.walk_document(path, 1, 3, index=moved)
        # Another file of the same size and page-tree root, whose pages sit elsewhere: the recorded Kids lengths and page
        # objects do not match, so its walk fails closed instead of naming another page (council #395 adversarial M1).
        a = TreeBuilder().build({'kids': [{'kids': ['P', 'P']}, {'kids': ['P', 'P']}]})
        b = TreeBuilder().build({'kids': [{'kids': ['P', 'P', 'P']}, {'kids': ['P']}]})
        a, b = a + b' ' * max(0, len(b) - len(a)), b + b' ' * max(0, len(a) - len(b))
        a_index = facts.page_index(self.write(a, 'a.pdf'))
        b_path = self.write(b, 'b.pdf')
        self.assertEqual((a_index.size, a_index.root), (facts.page_index(b_path).size, facts.page_index(b_path).root))
        for first, last in ((1, 3), (3, 3), (1, 1)):
            with self.assertRaises(facts.Unknown) as caught:
                facts.walk_document(b_path, first, last, index=a_index)
            self.assertEqual(str(caught.exception), 'page-index')
        with self.assertRaises(facts.Unknown):
            facts.walk_document(path, 1, 3, index=facts.Unknown('page-tree-count'))
        with self.assertRaises(TypeError):
            facts.walk_document(path, 1, 3, index={'pages': 3})

    def test_index_file_is_built_once_reused_and_never_trusted_blindly(self):
        data = TreeBuilder().build({'kids': [{'kids': ['P', 'P']}, 'P', 'P']})
        path = self.write(data)
        record = Path(self.dir.name) / 'page-index'
        built = []
        original = facts.build_page_index

        def spy(file):
            built.append(1)
            return original(file)
        facts.build_page_index = spy
        try:
            first = facts.page_index_file(path, str(record))
            second = facts.page_index_file(path, str(record))
            self.assertEqual(len(built), 1)
            self.assertEqual(first.dumps(), second.dumps())
            # A record for another file (another size) is ignored, rebuilt in memory and left as it is.
            other = self.write(data + b'\n% padding\n', 'other.pdf')
            self.assertEqual(facts.page_index_file(other, str(record)).size, len(data) + 11)
            self.assertEqual(len(built), 2)
            self.assertEqual(record.read_bytes(), first.dumps())
            # Garbage is ignored (not overwritten); a symlink is never followed.
            record.write_bytes(b'garbage')
            self.assertEqual(facts.page_index_file(path, str(record)).pages, 4)
            self.assertEqual(record.read_bytes(), b'garbage')
            record.unlink()
            target = Path(self.dir.name) / 'target'
            target.write_bytes(first.dumps())
            record.symlink_to(target)
            self.assertEqual(facts.page_index_file(path, str(record)).pages, 4)
            self.assertEqual(len(built), 4)
            record.unlink()
            # A tree that does not check out is recorded as its reason, so the next chunk does not walk it again.
            lying = self.write(TreeBuilder().build({'kids': [{'kids': ['P'], 'count': 3}]}), 'lying.pdf')
            for _ in range(2):
                result = facts.page_index_file(lying, str(record))
                self.assertIsInstance(result, facts.Unknown)
                self.assertEqual(str(result), 'page-tree-count')
            self.assertEqual(len(built), 5)
            # A deadline failure is not recorded.
            record.unlink()
            result = facts.page_index_file(path, str(record), deadline=time.monotonic() - 1)
            self.assertEqual(str(result), 'time-budget')
            self.assertFalse(record.exists())
        finally:
            facts.build_page_index = original

    def test_shared_indirect_kids_arrays_fail_closed(self):
        page = '<< /Type /Page /MediaBox [0 0 100 100] >>'
        # Two nodes share one Kids array object of inline pages: 4 pages for 2, every /Count consistent.
        data = raw_pdf({1: f'[{page} {page}]', 2: '<< /Type /Pages /Kids 1 0 R /Count 2 >>',
                        3: '<< /Type /Pages /Kids 1 0 R /Count 2 >>', 4: '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 4 >>'}, '4 0 R')
        self.assert_unknown(data, 'page-tree-shared')
        # The same array reached through a reference chain (Kids 5 0 R, object 5 is `1 0 R`): still one object twice.
        data = raw_pdf({1: f'[{page} {page}]', 5: '1 0 R', 2: '<< /Type /Pages /Kids 5 0 R /Count 2 >>',
                        3: '<< /Type /Pages /Kids 1 0 R /Count 2 >>', 4: '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 4 >>'}, '4 0 R')
        self.assert_unknown(data, 'page-tree-shared')
        # Two kids that reach one page or one node through reference-to-reference aliases (council #395 re-check M1).
        alias_page = raw_pdf({3: page, 5: '3 0 R', 6: '3 0 R', 8: page, 9: '<< /Type /Pages /Kids [5 0 R 6 0 R 8 0 R] >>'}, '9 0 R')
        alias_node = raw_pdf({1: f'<< /Type /Pages /Kids [{page} {page}] >>', 5: '1 0 R', 6: '1 0 R',
                              9: '<< /Type /Pages /Kids [5 0 R 6 0 R] >>'}, '9 0 R')
        self.assert_unknown(alias_page, 'page-tree-shared')
        self.assert_unknown(alias_node, 'page-tree-shared')
        # A kid reached through one alias, once, is still an ordinary page.
        self.assertEqual(self.index(raw_pdf({3: page, 5: '3 0 R', 9: '<< /Type /Pages /Kids [5 0 R] >>'}, '9 0 R')).pages, 1)
        # One indirect Kids array, used once, is an ordinary tree.
        data = raw_pdf({1: f'[{page} {page}]', 2: '<< /Type /Pages /Kids 1 0 R /Count 2 >>'}, '2 0 R')
        self.assertEqual(self.index(data).pages, 2)

    def test_the_deepest_tree_the_builder_accepts_round_trips(self):
        spec = {'kids': ['P', {'kids': []}]}
        for _ in range(facts.MAX_TREE_DEPTH - 1):
            spec = {'kids': [spec]}
        index = self.index(TreeBuilder().build(spec))
        self.assertIsInstance(index, facts.PageIndex)
        self.assertEqual(facts.PageIndex.loads(index.dumps()).pages, 1)

    def test_inherited_resources_and_content_through_a_nested_tree(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        objects = {n: body.decode('latin-1') for n, body in b.objects.items()}
        nodes, number = [], max(objects) + 1
        for group in range(5):
            kids = []
            for k in range(7):
                n = group * 7 + k + 1
                objects[number] = f'<< /Length {len(place(n * 3, 10, 0, 0))} >>\nstream\n{place(n * 3, 10, 0, 0)}\nendstream'
                objects[number + 1] = f'<< /Type /Page /Contents {number} 0 R >>'
                kids.append(f'{number + 1} 0 R')
                number += 2
            # Resources, MediaBox and Rotate inherited from the intermediate node.
            objects[number] = (f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count 7 /Resources << /XObject << /Im {im} 0 R >> >> '
                               f'/MediaBox [0 0 {400 + group} 800] /Rotate {90 * group % 360} >>')
            nodes.append(f'{number} 0 R')
            number += 1
        objects[number] = f'<< /Type /Pages /Kids [{" ".join(nodes)}] /Count 35 >>'
        path = self.write(raw_pdf(objects, f'{number} 0 R'))
        index = facts.page_index(path)
        file = facts.PdfFile(path)
        try:
            for first in (1, 8, 20, 30):
                expected = geometry(file, legacy_iter_pages(file, first, first + 5))
                got = geometry(file, facts.indexed_pages(file, index, range(first, first + 6)))
                self.assertEqual(got, expected)
        finally:
            file.close()
        for first in (1, 15, 33):
            walks = facts.walk_document(path, first, first + 2, index=index)
            for n, walk in walks.items():
                self.assertIsNone(walk.unknown)
                self.assertEqual((walk.media[2], walk.rotate), (400 + (n - 1) // 7, 90 * ((n - 1) // 7) % 360))
                self.assertEqual(len(walk.draws), 1)
                self.assertIn(float(n * 3), [abs(v) for v in walk.draws[0].matrix[:4]])   # after the display rotation

    def test_index_records_survive_truncation_and_ignore_other_files_failures(self):
        data = TreeBuilder().build({'kids': ['P', 'P', 'P']})
        path = self.write(data)
        record = Path(self.dir.name) / 'page-index'
        index = facts.page_index_file(path, str(record))
        self.assertEqual(record.read_bytes(), index.dumps())
        self.assertEqual([p.name for p in Path(self.dir.name).iterdir() if p.name.endswith('.partial')], [])
        record.write_bytes(index.dumps()[:-3])            # a writer killed mid-record (an older writer, or a full disk)
        self.assertEqual(facts.page_index_file(path, str(record)).pages, 3)
        # A recorded failure for another file (another size) is ignored.
        record.write_bytes(facts._UNKNOWN_RECORD + (len(data) + 1).to_bytes(8, 'little') + b'page-tree-count')
        self.assertIsInstance(facts.page_index_file(path, str(record)), facts.PageIndex)
        record.write_bytes(facts._UNKNOWN_RECORD + len(data).to_bytes(8, 'little') + b'page-tree-count')
        self.assertEqual(str(facts.page_index_file(path, str(record))), 'page-tree-count')
        record.write_bytes(facts._UNKNOWN_RECORD + len(data).to_bytes(8, 'little') + b'Not A Slug!')
        self.assertIsInstance(facts.page_index_file(path, str(record)), facts.PageIndex)

    def test_recursion_while_reading_is_an_unknown_not_a_crash(self):
        original = facts.PdfFile._load_xref

        def recursing(file):
            raise RecursionError('maximum recursion depth exceeded')
        facts.PdfFile._load_xref = recursing
        try:
            self.assertEqual(str(facts.page_index(self.write(TreeBuilder().build({'kids': ['P']})))), 'unreadable')
        finally:
            facts.PdfFile._load_xref = original

    def test_layout_facts_with_an_index_match_layout_facts_without(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        for n in range(1, 41):
            b.page(place(10 * n, 10, 0, 0), {'Im': im})
        path = self.write(b.build())
        index = facts.page_index(path)
        for first, last, only in ((1, 32, None), (33, 40, None), (33, 40, [35, 39])):
            self.assertEqual(facts.layout_facts(path, None, None, None, first, last, pages=only, index=index),
                             facts.layout_facts(path, None, None, None, first, last, pages=only))



class LayoutDocumentTest(Scratch):
    """One open PDF for every chunk of a file (LayoutDocument): the same answers as a fresh open per chunk, each call under
    its own deadline, and nothing but parsed objects carried from one call to the next."""

    def chunked(self, path, size, last, document=None, index=None, content=True, only=None):
        out = []
        for first in range(1, last + 1, size):
            chunk_last = min(first + size - 1, last)
            pages = None if only is None else [n for n in only if first <= n <= chunk_last] or None
            out.append(facts.layout_facts(path, None, None, None, first, chunk_last, content=content, pages=pages,
                                          index=index, document=document))
        return out

    def test_chunks_through_one_document_equal_a_fresh_open_per_chunk(self):
        import random
        rng = random.Random(20261114)
        checked = 0
        for case in range(16):
            path = self.write(TreeBuilder().build(random_tree(rng)), f'tree-{case}.pdf')
            index = facts.page_index(path)
            pages = index.pages if isinstance(index, facts.PageIndex) else 9
            for content in (True, False):
                for size, only in ((7, None), (32, None), (5, set(range(2, pages + 1, 3)))):
                    with facts.LayoutDocument(path) as document:
                        self.assertEqual(self.chunked(path, size, pages, document=document, content=content, only=only),
                                         self.chunked(path, size, pages, content=content, only=only), (case, content, size))
                        if isinstance(index, facts.PageIndex):
                            self.assertEqual(self.chunked(path, size, pages, document=document, index=index, content=content, only=only),
                                             self.chunked(path, size, pages, content=content, only=only), (case, content, size))
                    checked += 1
        self.assertGreater(checked, 90)

    def test_images_and_walks_match_through_one_document(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        for n in range(1, 71):
            b.page(place(10 * n, 10, 0, 0), {'Im': im}, rotate=90 * (n % 4))
        path = self.write(b.build())
        index = facts.page_index(path)
        with facts.LayoutDocument(path) as document:
            for first, last in ((1, 32), (33, 64), (65, 70), (1, 32)):
                kept = facts.walk_document(path, first, last, index=index, document=document)
                fresh = facts.walk_document(path, first, last, index=index)
                self.assertEqual(sorted(kept), sorted(fresh))
                for n in kept:
                    self.assertEqual((kept[n].objnum, kept[n].rotate, kept[n].width, kept[n].height, kept[n].unknown),
                                     (fresh[n].objnum, fresh[n].rotate, fresh[n].width, fresh[n].height, fresh[n].unknown))
                    self.assertEqual([facts.placement_from_draw(d, kept[n]) for d in kept[n].draws],
                                     [facts.placement_from_draw(d, fresh[n]) for d in fresh[n].draws])

    def test_the_file_is_opened_once_and_the_root_is_not_reread_per_chunk(self):
        data = TreeBuilder().build({'kids': ['P'] * 300})
        path = self.write(data)
        index = facts.page_index(path)
        opened, loads = [0], [0]
        original_init, original_load = facts.PdfFile.__init__, facts.PdfFile._parse_indirect

        def counting_init(file, *args, **kwargs):
            opened[0] += 1
            original_init(file, *args, **kwargs)

        def counting_load(file, offset, num):
            loads[0] += 1
            return original_load(file, offset, num)
        facts.PdfFile.__init__, facts.PdfFile._parse_indirect = counting_init, counting_load
        try:
            with facts.LayoutDocument(path) as document:
                self.chunked(path, 32, 300, document=document, index=index, content=False)
            once, once_loads = opened[0], loads[0]
            opened[0] = loads[0] = 0
            self.chunked(path, 32, 300, index=index, content=False)
        finally:
            facts.PdfFile.__init__, facts.PdfFile._parse_indirect = original_init, original_load
        self.assertEqual(once, 1)
        self.assertEqual(opened[0], 10)
        self.assertLess(once_loads, loads[0])

    def test_each_call_has_its_own_deadline(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        for n in range(1, 11):
            b.page(place(10, 10, 0, 0), {'Im': im})
        path = self.write(b.build())
        with facts.LayoutDocument(path) as document:
            fresh = facts.layout_facts(path, None, None, None, 1, 10)
            first = facts.layout_facts(path, None, None, None, 1, 10, document=document)
            self.assertEqual(first, fresh)
            late = facts.layout_facts(path, None, None, None, 1, 10, deadline=time.monotonic() - 1, document=document)
            self.assertTrue(all(not page['known'] for page in late['pages']))
            again = facts.layout_facts(path, None, None, None, 1, 10, deadline=time.monotonic() + 30, document=document)
            self.assertEqual(again, fresh)

    def test_an_unexpected_error_drops_the_open_file(self):
        b = PdfBuilder()
        im = b.image(4, 4, solid_rgb(4, 4, (9, 9, 9)))
        for n in range(1, 6):
            b.page(place(10, 10, 0, 0), {'Im': im})
        path = self.write(b.build())
        fresh = facts.layout_facts(path, None, None, None, 1, 5)
        with facts.LayoutDocument(path) as document:
            facts.layout_facts(path, None, None, None, 1, 5, document=document)
            held = document._file
            original = facts.Walker.walk_page

            def failing(walker, walk, page, resources):
                raise RecursionError('deep')
            facts.Walker.walk_page = failing
            try:
                broken = facts.layout_facts(path, None, None, None, 1, 5, document=document)
            finally:
                facts.Walker.walk_page = original
            self.assertTrue(all(page['reason'] == 'walker-error' for page in broken['pages']))
            self.assertIsNone(document._file)
            self.assertEqual(facts.layout_facts(path, None, None, None, 1, 5, document=document), fresh)
            self.assertIsNot(document._file, held)
            # Anything a call raises past the walker (not Unknown) drops it too.
            original_pages = facts.indexed_pages

            def raising(*_args, **_kwargs):
                raise MemoryError()
                yield  # pragma: no cover
            facts.indexed_pages = raising
            try:
                with self.assertRaises(MemoryError):
                    facts.walk_document(path, 1, 5, document=document)
            finally:
                facts.indexed_pages = original_pages
            self.assertIsNone(document._file)
            self.assertEqual(facts.layout_facts(path, None, None, None, 1, 5, document=document), fresh)

    def test_whole_file_failures_are_answered_per_call_and_never_cached(self):
        lying = self.write(TreeBuilder().build({'kids': [{'kids': ['P', 'P', 'P'], 'count': 5}, 'P']}), 'lying.pdf')
        with facts.LayoutDocument(lying) as document:
            for _ in range(2):
                result = facts.layout_facts(lying, None, None, None, 1, 4, document=document)
                self.assertEqual({page['reason'] for page in result['pages']}, {'page-tree-count'})
                self.assertEqual(result['walkerUnknown'], {'reason': 'page-tree-count', 'pages': 4})
                listed = facts.layout_facts(lying, None, None, None, 1, 4, pages=[2, 4], document=document)
                self.assertEqual(listed['walkerUnknown'], {'reason': 'page-tree-count', 'pages': 2})
        intact = self.write(TreeBuilder().build({'kids': ['P', 'P']}), 'intact.pdf')
        self.assertNotIn('walkerUnknown', facts.layout_facts(intact, None, None, None, 1, 2))
        garbage = self.write(b'%PDF-1.4 not a pdf', 'garbage.pdf')
        before = len(os.listdir('/proc/self/fd'))
        with facts.LayoutDocument(garbage) as document:
            for _ in range(50):
                with self.assertRaises(facts.Unknown):
                    facts.walk_document(garbage, 1, 1, document=document)
                self.assertIsNone(document._file)
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)   # a failed open keeps no descriptor

    def test_a_document_is_bound_to_its_path(self):
        a = self.write(TreeBuilder().build({'kids': ['P']}), 'a.pdf')
        other = self.write(TreeBuilder().build({'kids': ['P']}), 'b.pdf')
        with facts.LayoutDocument(a) as document:
            with self.assertRaises(TypeError):
                facts.walk_document(other, 1, 1, document=document)
            with self.assertRaises(TypeError):
                facts.walk_document(a, 1, 1, document=object())


if __name__ == '__main__':
    unittest.main()
