import os
import sys
import unittest

sys.path.insert(0,os.environ["MIXED_PDF_SCORERS"])
import tolerant_markdown
from generate import author
from measure import content_score

class ScorerTests(unittest.TestCase):
    def setUp(self):
        self.ref=author(1,0)
        self.text=self.ref["expectedMarkdown"]
    def score(self,text): return content_score(self.ref,text,tolerant_markdown)
    def test_exact_and_whitespace(self):
        self.assertTrue(self.score(self.text)["acceptable"])
        self.assertTrue(self.score(self.text.replace("\n","  "))["acceptable"])
    def test_omitted_inset(self):
        self.assertFalse(self.score(self.text.replace(self.ref["sections"][3],""))["acceptable"])
    def test_nonapplicable_dimensions(self):
        for text in ['Only prose without numbers.', '']:
            ref={'expectedMarkdown':text,'sections':[text],'paragraphs':[text],'tables':[],'formulas':[],'excludedText':[]}
            result=content_score(ref,text,tolerant_markdown)
            self.assertTrue(result['acceptable']);self.assertEqual(result['quality'],1)
            self.assertIsNone(result['tableRowRecall']);self.assertIsNone(result['numericRecall'])
    def test_numeric_error_affects_primary_quality(self):
        text='alpha '*100+'123'
        ref={'expectedMarkdown':text,'sections':[text],'paragraphs':[text],'tables':[],'formulas':[],'excludedText':[]}
        self.assertEqual(content_score(ref,text.replace('123','999'),tolerant_markdown)['quality'],0)
    def test_contextual_swaps_and_operators(self):
        for expected,actual in [('alpha '*100+'dose 12 interval 34','alpha '*100+'dose 34 interval 12'),('Result: a + b = c.','Result: a - b = c.')]:
            ref={'expectedMarkdown':expected,'sections':[expected],'paragraphs':[expected],'tables':[],'formulas':[],'excludedText':[]}
            score=content_score(ref,actual,tolerant_markdown)
            self.assertFalse(score['acceptable']);self.assertLess(score['quality'],.95)
    def test_repeated_field_context_and_formula_grouping(self):
        prefix='padding '*300
        text=prefix+'Account Alpha has a reported balance of 12 dollars at close. Account Beta has a reported balance of 34 dollars at close.'
        actual=text.replace('12','VALUE').replace('34','12').replace('VALUE','34')
        for expected,extracted in [(text,actual),('Result: (a + b) * c = d.','Result: a + b * c = d.')]:
            ref={'expectedMarkdown':expected,'sections':[expected],'paragraphs':[expected],'tables':[],'formulas':[],'excludedText':[]}
            score=content_score(ref,extracted,tolerant_markdown)
            self.assertFalse(score['acceptable']);self.assertLess(score['quality'],.95)
    def test_empty(self):
        self.assertEqual(self.score("")["quality"],0)
    def test_formula_extensions_and_overlapping_occurrences(self):
        prefix='The valve has a pressure of 12 units. '*60
        short='q = a / b';long=short+' + c'
        ref={'expectedMarkdown':prefix+short,'sections':[prefix+short],
             'paragraphs':[prefix+short],'tables':[],'formulas':[],
             'printedFormulas':[short],'excludedText':[]}
        for changed in [long, 'x + '+short]:
            self.assertFalse(content_score(ref,prefix+changed,tolerant_markdown)['acceptable'])
        ref['expectedMarkdown']=prefix+short+'\n'+long;ref['printedFormulas']=[short,long]
        self.assertFalse(content_score(ref,prefix+long,tolerant_markdown)['acceptable'])
    def test_prose_mentions_cannot_repair_corrupt_declared_formula(self):
        formula='q = a / b'
        prose='padding '*300+'The implementation evaluates q = a / b + c as an alternative.'
        text=prose+'\n\n'+formula
        ref=dict(expectedMarkdown=text,sections=[prose,formula],paragraphs=[prose,formula],
                 tables=[],formulas=[],printedFormulas=[formula],excludedText=[],
                 printedFormulaOccurrences=[dict(start=len(prose)+2,end=len(text),text=formula)])
        self.assertTrue(content_score(ref,text,tolerant_markdown)['acceptable'])
        bad=content_score(ref,prose+'\n\nq = A / b',tolerant_markdown)
        self.assertFalse(bad['acceptable']);self.assertEqual(bad['printedFormulaRecall'],0)

    def test_case_sensitive_formulas_cannot_swap_identical_contexts(self):
        first='q = a / b';second='q = A / b'
        text='padding '*300+'Rule '+first+' end. Rule '+second+' end.'
        ref=dict(expectedMarkdown=text,sections=[text],paragraphs=[text],tables=[],formulas=[],
                 printedFormulas=[first,second],excludedText=[],printedFormulaOccurrences=[])
        for literal in [first,second]:
            start=text.index(literal)
            ref['printedFormulaOccurrences'].append(dict(start=start,end=start+len(literal),text=literal))
        self.assertTrue(content_score(ref,text,tolerant_markdown)['acceptable'])
        bad=text.replace(first,'TEMP').replace(second,first).replace('TEMP',second)
        self.assertFalse(content_score(ref,bad,tolerant_markdown)['acceptable'])

    def test_math_case_and_line_leading_operators_survive_normalization(self):
        for expected,wrong in [('q = a / b','q = A / b'),
                               ('Rule: a\n* b = c','Rule: a\nb = c'),
                               ('Rule: a\n- b = c','Rule: a\nb = c'),
                               ('q = a ― b','q = a b'),('q = a²','q = a2'),
                               ('q = a_1','q = a1')]:
            prefix='padding '*400
            ref={'expectedMarkdown':prefix+expected,'sections':[prefix+expected],
                 'paragraphs':[prefix+expected],'tables':[],'formulas':[],
                 'printedFormulas':[expected],'excludedText':[]}
            good=content_score(ref,prefix+expected,tolerant_markdown)
            self.assertTrue(good['acceptable'])
            bad=content_score(ref,prefix+wrong,tolerant_markdown)
            self.assertFalse(bad['acceptable']);self.assertEqual(bad['printedFormulaRecall'],0)
    def test_formula_error_cannot_hide_in_long_prose(self):
        formula='Result: (a + b) * c = d.'
        text='padding '*400+formula
        ref={'expectedMarkdown':text,'sections':[text],'paragraphs':[text],
             'tables':[],'formulas':[],'printedFormulas':[formula],'excludedText':[]}
        for changed in [formula.replace('+','-'),formula.replace('(','').replace(')','')]:
            score=content_score(ref,text.replace(formula,changed),tolerant_markdown)
            self.assertFalse(score['acceptable']);self.assertEqual(score['quality'],0)
        self.assertTrue(content_score(ref,text.replace(' * ','\n*\n'),tolerant_markdown)['acceptable'])
        ref['expectedMarkdown']=text+' '+formula;ref['printedFormulas'].append(formula)
        score=content_score(ref,text,tolerant_markdown)
        self.assertEqual(score['printedFormulaRecall'],.5)
        self.assertFalse(score['acceptable'])
    def test_swapped_table_cells(self):
        row=self.ref["tables"][0]["rows"][1]
        altered=self.text.replace(" | ".join(row)," | ".join([row[0],row[2],row[1],row[3]]))
        self.assertFalse(self.score(altered)["acceptable"])
    def test_hidden_text_leak(self):
        self.assertFalse(self.score(self.text+"\n"+self.ref["excludedText"][0])["acceptable"])
        for decoy in [self.ref['excludedText'][0].lower(), self.ref['excludedText'][0].replace('-','-\n')]:
            self.assertFalse(self.score(self.text+'\n'+decoy)['acceptable'])
    def test_reversed_prose_and_rows(self):
        self.assertFalse(self.score(' '.join(reversed(self.text.split())))['acceptable'])
        rows=self.ref['tables'][0]['rows']
        before='\n'.join(' | '.join(r) for r in rows)
        after='\n'.join(' | '.join(r) for r in [rows[0]]+list(reversed(rows[1:])))
        self.assertFalse(self.score(self.text.replace(before,after))['acceptable'])
    def test_padding_does_not_repair_omission(self):
        text=self.text.replace(self.ref["sections"][3],"")+"\n"+self.ref["sections"][1]*4
        self.assertFalse(self.score(text)["acceptable"])

if __name__ == "__main__": unittest.main()
