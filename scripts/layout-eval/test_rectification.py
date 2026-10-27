import unittest
import numpy as np
from PIL import Image,ImageDraw
from rectification import find_page_quad,rectify_image,map_regions


class RectificationTests(unittest.TestCase):
    def test_light_full_page_abstains(self):
        image=Image.new('RGB',(600,800),'white'); draw=ImageDraw.Draw(image)
        for y in range(70,700,30): draw.rectangle((50,y,500,y+6),fill='black')
        quad,diagnostics=find_page_quad(image)
        self.assertIsNone(quad); self.assertFalse(diagnostics['accepted'])

    def test_blank_dark_image_abstains(self):
        self.assertIsNone(find_page_quad(Image.new('RGB',(400,500),'#352b29'))[0])

    def test_quad_and_source_mapping(self):
        image=Image.new('RGB',(640,480),'#783b24'); draw=ImageDraw.Draw(image)
        quad=[(110,60),(550,90),(520,430),(80,390)]
        draw.polygon(quad,fill='#f5f4ee')
        for y in range(130,330,25): draw.line((150,y,460,y+18),fill='#333333',width=3)
        rectified,inverse,diagnostics=rectify_image(image)
        self.assertTrue(diagnostics['accepted'])
        regions=map_regions([{'label':'paragraph','bbox':[0,0,1,1]}],inverse,rectified.size,image.size)
        expected=[80/640,60/480,550/640,430/480]
        self.assertTrue(all(abs(a-b)<.012 for a,b in zip(regions[0]['bbox'],expected)))
        self.assertEqual(len(regions[0]['polygon']),4)

    def test_identity_mapping_does_not_mutate_regions(self):
        regions=[{'label':'table','bbox':[.2,.3,.8,.9]}]
        mapped=map_regions(regions,np.eye(3),(600,800),(600,800))
        self.assertNotIn('polygon',regions[0])
        self.assertTrue(np.allclose(mapped[0]['bbox'],regions[0]['bbox']))

    def test_texture_without_paper_abstains(self):
        rng=np.random.default_rng(14)
        data=rng.integers(0,140,size=(480,640,3),dtype=np.uint8)
        self.assertIsNone(find_page_quad(Image.fromarray(data))[0])


if __name__=='__main__': unittest.main()
