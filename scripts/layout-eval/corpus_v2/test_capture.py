"""Geometry and occlusion invariants independent of any corpus document."""
import unittest
import numpy as np
from PIL import Image, ImageDraw
from capture import homography, project, transform_geometry, visible_fraction


class CaptureGeometryTests(unittest.TestCase):
    def setUp(self):
        self.source=[[0,0],[900,0],[900,1300],[0,1300]]
        self.target=[[190,95],[720,180],[820,1100],[65,1020]]
        self.matrix=homography(self.source,self.target)

    def test_corners_and_interior_roundtrip(self):
        self.assertTrue(np.allclose(project(self.source,self.matrix),self.target,atol=1e-8))
        points=np.random.default_rng(47).random((100,2))*[900,1300]
        restored=project(project(points,self.matrix),np.linalg.inv(self.matrix))
        self.assertTrue(np.allclose(restored,points,atol=1e-8))

    def test_table_cells_and_lines_keep_source_geometry(self):
        original={'bbox':[10,20,90,80],'attributes':{'cells':[{'bbox':[12,22,40,50],'text':'arbitrary content'}],'line_boxes':[[15,23,35,34]]}}
        result=transform_geometry(original,self.matrix)
        cell=result['attributes']['cells'][0]
        self.assertEqual(cell['source_bbox'],[12,22,40,50])
        self.assertTrue(np.allclose(project(cell['polygon'],np.linalg.inv(self.matrix)),[[12,22],[40,22],[40,50],[12,50]]))
        line=result['attributes']['line_polygons'][0]
        self.assertTrue(np.allclose(project(line,np.linalg.inv(self.matrix)),[[15,23],[35,23],[35,34],[15,34]]))
        self.assertNotIn('source_bbox',original)

    def test_occlusion_fraction_includes_fully_hidden_case(self):
        polygon=[[0,0],[99,0],[99,99],[0,99]]
        mask=Image.new('L',(100,100))
        self.assertEqual(visible_fraction(polygon,mask,mask.size),1)
        ImageDraw.Draw(mask).rectangle([0,0,49,99],fill=255)
        self.assertAlmostEqual(visible_fraction(polygon,mask,mask.size),0.5)
        ImageDraw.Draw(mask).rectangle([0,0,99,99],fill=255)
        self.assertEqual(visible_fraction(polygon,mask,mask.size),0)

    def test_degenerate_geometry_rejected(self):
        with self.assertRaises(np.linalg.LinAlgError):
            homography([[0,0]]*4,self.target)


if __name__=='__main__':
    unittest.main()
