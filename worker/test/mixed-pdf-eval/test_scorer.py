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
    def test_empty(self):
        self.assertEqual(self.score("")["quality"],0)
    def test_swapped_table_cells(self):
        row=self.ref["tables"][0]["rows"][1]
        altered=self.text.replace(" | ".join(row)," | ".join([row[0],row[2],row[1],row[3]]))
        self.assertFalse(self.score(altered)["acceptable"])
    def test_hidden_text_leak(self):
        self.assertFalse(self.score(self.text+"\n"+self.ref["excludedText"][0])["acceptable"])
    def test_padding_does_not_repair_omission(self):
        text=self.text.replace(self.ref["sections"][3],"")+"\n"+self.ref["sections"][1]*4
        self.assertFalse(self.score(text)["acceptable"])

if __name__ == "__main__": unittest.main()
