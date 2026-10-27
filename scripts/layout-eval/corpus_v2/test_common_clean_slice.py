import unittest
from build_common_clean_slice import choose


def condition(identifier,tags,category='native'):
 return {'category':category,'assertions':[{'tag':tag,'scope':{'kind':'page','id':identifier}} for tag in tags]}

class CommonCleanSliceTests(unittest.TestCase):
 def test_preserves_split_group_and_dense_content(self):
  row={'id':'dense','split':'holdout','metadata':{'source_cluster':'group-a'},'regions':[{'label':'table'}]}
  selected,excluded=choose([row],{'dense':condition('dense',['digital','born-digital','aligned'])})
  self.assertEqual(selected,[row]);self.assertIs(selected[0],row);self.assertEqual(excluded,[])
 def test_does_not_accept_flat_or_ancestor_tags_as_current_evidence(self):
  row={'id':'child','split':'dev','metadata':{'source_cluster':'group-a'}}
  evidence={'category':'native','tags':['digital','born-digital','aligned'],'assertions':[{'tag':'aligned','scope':{'kind':'page','id':'parent'}}]}
  selected,excluded=choose([row],{'child':evidence})
  self.assertEqual(selected,[]);self.assertIn('aligned',excluded[0]['missing_positive_evidence'])
 def test_declared_blur_excluded_even_with_clean_origin(self):
  row={'id':'blur','split':'dev','metadata':{'source_cluster':'group-a'}}
  selected,excluded=choose([row],{'blur':condition('blur',['digital','born-digital','aligned','blurry'])})
  self.assertEqual(selected,[]);self.assertEqual(excluded[0]['declared_degradation'],['blurry'])
 def test_group_leakage_fails_instead_of_resplitting(self):
  rows=[{'id':'a','split':'dev','metadata':{'source_cluster':'shared'}},{'id':'b','split':'holdout','metadata':{'source_cluster':'shared'}}]
  with self.assertRaises(ValueError):choose(rows,{})

if __name__=='__main__':unittest.main()
