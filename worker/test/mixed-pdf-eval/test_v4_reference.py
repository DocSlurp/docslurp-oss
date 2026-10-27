import copy
import unittest

from v4_reference import page_reference, table_rows


class V4ReferenceTests(unittest.TestCase):
    def page(self):
        text = 'Reading: 14 kg.'
        return {'id': 'sample-page', 'sizePt': [612, 792],
                'blocks': [dict(id='body', visible=True, displayText=text,
                                cells=[], formula=None),
                           dict(id='decoy', visible=False, displayText='Excluded text',
                                cells=[], formula=None)],
                'readingOrder': ['body'], 'sections': [text], 'paragraphs': [text],
                'expectedMarkdown': text}

    def test_exact_visible_projection_and_exclusion(self):
        page = self.page()
        before = copy.deepcopy(page)
        ref = page_reference(page)
        self.assertEqual(ref['expectedMarkdown'], 'Reading: 14 kg.')
        self.assertEqual(ref['excludedText'], ['Excluded text'])
        self.assertEqual(page, before)
        ref['blocks'][0]['displayText'] = 'Changed'
        self.assertEqual(page, before)

    def test_formula_occurrence_is_bound_to_its_authored_block(self):
        page=self.page();formula='q = a / b'
        page['blocks'][0]['displayText']='An alternative is q = a / b + c.'
        page['blocks'].append(dict(id='rule',visible=True,displayText=formula,cells=[],
                                   formula=dict(display=formula,latex='q=a/b')))
        page['readingOrder']=['body','rule']
        page['sections']=page['paragraphs']=[page['blocks'][0]['displayText'],formula]
        page['expectedMarkdown']='\n\n'.join(page['sections'])
        ref=page_reference(page);row=ref['printedFormulaOccurrences'][0]
        self.assertEqual(row['blockId'],'rule')
        self.assertEqual(ref['expectedMarkdown'][row['start']:row['end']],formula)
        self.assertEqual(row['start'],ref['expectedMarkdown'].rindex(formula))

    def test_gold_disagreement_fails_closed(self):
        for field, value in [('sections', ['Other']), ('readingOrder', []),
                             ('expectedMarkdown', 'Extra'),
                             ('readingOrder', ['body', 'decoy'])]:
            page = self.page()
            page[field] = value
            with self.assertRaises(ValueError):
                page_reference(page)

    def test_merged_cells_and_invalid_grids(self):
        cell = lambda r, c, text, span=1: dict(row=r, column=c, rowSpan=1,
                                             columnSpan=span, displayText=text)
        cells = [cell(0, 0, 'Group', 2), cell(1, 0, 'A'), cell(1, 1, 'B')]
        self.assertEqual(table_rows(cells), [['Group', ''], ['A', 'B']])
        for bad in [cells + [cell(0, 1, 'Overlap')], cells[:-1]]:
            with self.assertRaises(ValueError):
                table_rows(bad)


if __name__ == '__main__':
    unittest.main()
