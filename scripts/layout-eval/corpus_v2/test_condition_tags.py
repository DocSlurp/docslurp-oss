import unittest
from condition_tags import assertion, inherit_page, table_assertions, validate

EV=[{"path":"fixture","sha256":"a"*64}]
class ConditionTagsTests(unittest.TestCase):
 def test_conflict_only_within_same_scope(self):
  scope={"kind":"page","id":"p"}
  with self.assertRaises(ValueError):validate([assertion("digital",scope,EV,"known"),assertion("picture",scope,EV,"known")])
 def test_page_alignment_not_row_alignment(self):
  page=assertion("aligned",{"kind":"page","id":"p"},EV,"canvas")
  row=assertion("row-misaligned",{"kind":"row","id":"t/row/1"},EV,"review")
  inherited=inherit_page([page,row],row["scope"])
  self.assertEqual(inherited["assertions"],[row]);self.assertEqual(inherited["pageContext"][0]["scope"],page["scope"])
  validate([page,row])
 def test_border_false_with_rules_is_not_borderless(self):
  region={"id":"t","label":"table","bbox":[0,0,100,100],"attributes":{"border":False,"cells":[{"row":0,"column":0,"text":"x"}]}}
  result=table_assertions([region],EV,[{"op":"line","xy":[0,20,100,20]}])
  self.assertEqual([a["tag"] for a in result],["mixed-rules"])
 def test_null_cell_not_empty_and_crop_marks_row(self):
  region={"id":"t","label":"table","bbox":[0,0,100,100],"attributes":{"cells":[{"row":2,"column":0,"text":None,"truncated":True}]}}
  result=table_assertions([region],EV)
  self.assertEqual(set(a["tag"] for a in result),{"truncated-cell","partial-row"})
 def test_unknown_quality_not_asserted(self):
  with self.assertRaises(ValueError):validate([assertion("blurry",{"kind":"page","id":"p"},[],"guessed")])
if __name__=="__main__":unittest.main()
