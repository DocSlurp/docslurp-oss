import unittest
from collections import Counter
import fitz
from PIL import Image,ImageChops,ImageStat,ImageFilter
from generate import author,clean_page,make_page,layout_for,genre_for,degradation

class GeneratorTests(unittest.TestCase):
    def test_factors_cross_in_every_split(self):
        for start,end in [(0,54),(54,72),(72,90)]:
            cells=Counter((layout_for(f),f%6) for f in range(start,end))
            self.assertEqual(len(cells),18)
            self.assertEqual(len(set(cells.values())),1)
            self.assertEqual(len(Counter(genre_for(f) for f in range(start,end))),9)
    def test_visible_regions_survive_clipping_raster_and_outlines(self):
        for family in [0,5,6,11,12,17]:
            for page in [1,2,3]:
                ref=author(family,page);src=clean_page(ref,family);out=fitz.open()
                actual=make_page(out,src,ref,family,page,False,{})
                self.assertEqual(actual['outline'],1 in actual['outlinedSections'])
                self.assertFalse(set(actual['rasterSections']) & set(actual['outlinedSections']))
                for box in ref['bbox']:
                    clip=fitz.Rect(box)
                    images=[]
                    for doc in [src,out]:
                        pix=doc[0].get_pixmap(dpi=150,clip=clip,alpha=False)
                        images.append(Image.frombytes('RGB',(pix.width,pix.height),pix.samples))
                    # Raster/native antialiasing differs at character edges; compare low-pass
                    # appearance while retaining independent per-section clipping checks.
                    images=[im.filter(ImageFilter.GaussianBlur(1.5)) for im in images]
                    error=sum(ImageStat.Stat(ImageChops.difference(*images)).mean)/3/255
                    self.assertLess(error,.02,(family,page,box,error))
                src.close();out.close()

if __name__=='__main__': unittest.main()
