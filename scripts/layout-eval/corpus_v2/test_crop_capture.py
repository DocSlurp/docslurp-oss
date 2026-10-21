import unittest
from crop_capture import area,clip_polygon,clipped_item,visible_lines

class CropTests(unittest.TestCase):
    def test_partial_cell_clips_and_translates(self):
        item={'bbox':[10,20,50,60],'text':'retained source'}
        result=clipped_item(item,[5,10,40,45])
        self.assertEqual(result['bbox'],[5,10,35,35])
        self.assertEqual(result['visibility'],750/1600)
        self.assertTrue(result['truncated'])
        self.assertIsNone(clipped_item(item,[60,60,100,100]))

    def test_diagonal_polygon_clip_area(self):
        self.assertAlmostEqual(area(clip_polygon([[0,0],[10,0],[0,10]],[0,0,5,5])),25)

    def test_clipped_glyphs_never_claim_full_text(self):
        blocks=[{'id':'x','line_texts':['complete','hidden','partial'],'line_boxes':[[1,1,4,4],[1,12,4,15],[1,8,4,11]]}]
        text,receipts=visible_lines(blocks,[0,0,10,10])
        self.assertEqual(text,'complete')
        self.assertEqual([r['visibility_state'] for r in receipts],['fully-visible','outside-crop','partial-glyphs-untranscribed'])
        self.assertIsNone(receipts[2]['visible_text'])

if __name__=='__main__':unittest.main()
