"""Source/gold completeness gates for editorial pilots, independent of appearance."""
import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
try:from .page import Page,sha
except ImportError:from page import Page,sha

class SourceContracts(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='layout-v2-contract-',dir=os.environ.get('TMPDIR',str(Path.home()/'tmp/agents')));self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
 def test_source_expected_markdown_and_contract_precede_png(self):
  p=Page('editorial',400,500);p.text('An authored heading',20,20,360,24,'serif-bold',label='title');p.text('One paragraph with enough words to wrap onto another measured line.',20,80,210,18)
  original=Image.Image.save
  def save(image,path,*a,**kw):
   for folder,suffix in [('sources','json'),('references','json'),('contracts','json'),('expected','md')]:self.assertTrue((self.root/folder/f'editorial.{suffix}').exists())
   return original(image,path,*a,**kw)
  with patch.object(Image.Image,'save',save):row=p.finalize(self.root)
  ref=json.loads((self.root/'references/editorial.json').read_text());self.assertEqual(sha(self.root/'expected/editorial.md'),ref['expected_markdown']['sha256']);self.assertIn('One paragraph',(self.root/'expected/editorial.md').read_text());self.assertTrue(all(r['attributes']['prose_contract']['presence']=='present' for r in row['regions']))
 def test_unlabeled_authored_text_fails_before_raster(self):
  p=Page('missing',200,200);p.text('No parent label',10,10,180,14,label=None)
  with self.assertRaisesRegex(ValueError,'no layout/composite label'):p.finalize(self.root)
  self.assertFalse((self.root/'images/missing.png').exists())
 def test_component_text_belongs_to_composite_not_separate_paragraph(self):
  p=Page('diagram',300,300);p.text('Valve A',40,40,150,18,label=None);p.region('illustration',[20,20,240,150],None,diagram='valve')
  row=p.finalize(self.root);self.assertEqual(len(row['regions']),1);contract=json.loads((self.root/'contracts/diagram.json').read_text());block=contract['annotation_granularity']['text_blocks'][0];self.assertEqual(block['parent_region_id'],'r000');self.assertIn('internal-component',block['annotation_role']);self.assertIn('Valve A',(self.root/'expected/diagram.md').read_text())
 def test_formula_requires_source_expression(self):
  p=Page('math',300,300);p.region('formula',[20,20,250,90])
  with self.assertRaisesRegex(ValueError,'source expression'):p.finalize(self.root)
  p.source['regions'][0]['attributes']['latex']='E=mc^2';p.finalize(self.root)
  ref=json.loads((self.root/'references/math.json').read_text());self.assertEqual(ref['ground_truth']['math'],'present');self.assertIn('$$\nE=mc^2',(self.root/'expected/math.md').read_text())
 def test_tables_retain_cells_markdown_and_continuation_rows(self):
  for number,offset in [(1,0),(2,2)]:
   p=Page(f'table-{number}',400,400,document_id='report',page_number=number);r=p.table([20,20,380,180],['Site','Count'],[['A','3'],['B','7']],row_height=40,continuation_id='table',row_offset=offset);p.finalize(self.root);self.assertEqual([c['logical_row'] for c in r['attributes']['cells'] if c['column']==0],[0,offset+1,offset+2]);self.assertIn('| Site | Count |',(self.root/f'expected/table-{number}.md').read_text())
 def test_long_contact_tokens_wrap_without_losing_original_prose(self):
  p=Page('contact',300,400);address='exchange@northside.example';p.text(address,20,20,95,18)
  block=p.source['text_blocks'][0];self.assertEqual(''.join(block['line_texts']),address);self.assertEqual(block['text'],address);self.assertLessEqual(block['bbox'][2],116);p.finalize(self.root);self.assertIn(address,(self.root/'expected/contact.md').read_text())
 def test_confidence_is_source_first_ordinal_and_hash_bound(self):
  p=Page('confidence',300,300);p.text('Measured native source',20,20,250,18)
  original=Image.Image.save
  def save(image,path,*args,**kwargs):
   source=json.loads((self.root/'sources/confidence.json').read_text());axes=source['regions'][0]['annotationConfidence']['axes'];self.assertEqual(axes['geometry']['score'],.5);self.assertEqual(axes['readingOrder']['score'],0);return original(image,path,*args,**kwargs)
  with patch.object(Image.Image,'save',save):p.finalize(self.root)
  receipt=json.loads((self.root/'confidence/confidence.json').read_text());self.assertEqual(receipt['scale'],'evidence-ordinal-not-probability');self.assertEqual(receipt['artifacts']['imageSha256'],sha(self.root/'images/confidence.png'))
  for region in receipt['regions']:
   for axis in region['axes'].values():
    self.assertIn(axis['score'],(None,0,.25,.5,.75,1));self.assertTrue(all(key in receipt['evidence'] for key in axis['provenance']))
    if axis['score'] is None:self.assertTrue(axis['reason'])
 def test_internal_math_preserves_expression_without_extra_layout_region(self):
  asset=self.root/'formula.png';Image.new('RGB',(50,20),'white').save(asset)
  p=Page('component',300,300);p.math_component(asset,[40,40,90,60],'m');p.region('illustration',[20,20,220,150]);row=p.finalize(self.root)
  self.assertEqual(len(row['regions']),1);self.assertEqual(row['regions'][0]['attributes']['math_components'][0]['source_expression'],'m');self.assertIn('$$\nm\n$$',(self.root/'expected/component.md').read_text())
 def test_rtl_shaping_arguments_and_source_are_retained(self):
  p=Page('arabic',500,300);text='الاسم الكامل';p.text(text,30,30,430,27,'arabic',direction='rtl',language='ar');p.finalize(self.root);self.assertEqual(p.source['commands'][0]['layout'],{'direction':'rtl','language':'ar'});self.assertIn(text,(self.root/'expected/arabic.md').read_text())
 def test_invalid_geometry_fails(self):
  with self.assertRaisesRegex(ValueError,'Invalid authored'):Page('bad',100,100).region('photo',[0,0,200,20])

if __name__=='__main__':unittest.main()
