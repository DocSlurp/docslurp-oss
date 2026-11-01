import importlib.util, json, os, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('orientation',Path(__file__).with_name('image_orientation.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Policy(unittest.TestCase):
    def test_confident_four_classes(self):
        for i in range(4):
            scores=[.02]*4;scores[i]=.94
            self.assertEqual(m.decision(scores),(i*90,.94,.9199999999999999,True))
    def test_abstains_ambiguous(self):
        self.assertFalse(m.decision([.4,.3,.2,.1])[3])
    def test_invalid_probabilities(self):
        for values in [[],[1,0,0],[float('nan'),0,0,0],[-1,1,1,0],[2,0,0,0],[.9,.9,.1,.1]]:
            with self.assertRaises(ValueError):m.decision(values)

@unittest.skipUnless(os.environ.get('ORIENTATION_TEST_MODEL'),'explicit local offline model required')
class Raster(unittest.TestCase):
    def test_malformed_oversized_and_multiframe(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'input';out=Path(tmp)/'output.png';model=Path(os.environ['ORIENTATION_TEST_MODEL'])
            source.write_bytes(b'not an image')
            with self.assertRaises(Exception):m.normalize(source,out,model)
            image=Image.new('1',(5000,4000));image.save(source,format='PNG')
            with self.assertRaises(ValueError):m.normalize(source,out,model)
            a=Image.new('RGB',(64,64));b=Image.new('RGB',(64,64),'white');a.save(source,format='GIF',save_all=True,append_images=[b])
            with self.assertRaises(ValueError):m.normalize(source,out,model)
    def test_transparent_pixels_and_exif_only_rotation(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'input.png';out=Path(tmp)/'output.png';model=Path(os.environ['ORIENTATION_TEST_MODEL'])
            image=Image.new('RGBA',(100,120),(0,0,0,0));image.putpixel((40,50),(0,0,0,255));image.save(source)
            r=m.normalize(source,out,model)
            with Image.open(out) as result:
                self.assertEqual(result.mode,'RGBA');self.assertEqual(result.getpixel((0,0)),(0,0,0,0));self.assertEqual(result.getpixel((40,50)),(0,0,0,255))
            image=Image.new('RGB',(100,120),'white');exif=Image.Exif();exif[274]=6;image.save(source,exif=exif)
            r=m.normalize(source,out,model)
            self.assertTrue(r['exifApplied']);self.assertEqual(r['exifOrientation'],6)
            with Image.open(out) as result:self.assertEqual(result.size,(120,100));self.assertNotIn(274,result.getexif())
    def test_blank_preserves_pixels_and_input(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'input.png';out=Path(tmp)/'output.png'
            Image.new('RGB',(200,300),'white').save(source);before=source.read_bytes()
            r=m.normalize(source,out,Path(os.environ['ORIENTATION_TEST_MODEL']))
            self.assertEqual(r['status'],'uncertain');self.assertEqual(source.read_bytes(),before)
            with Image.open(out) as image:self.assertEqual(image.size,(200,300));self.assertEqual(image.getpixel((0,0)),(255,255,255))

if __name__=='__main__':unittest.main()
