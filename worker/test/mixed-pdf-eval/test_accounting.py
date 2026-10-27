import io,os,tempfile,unittest
from pathlib import Path
import fitz
from PIL import Image
from measure import features,stream_bytes
from object_map import inspect

class AccountingTests(unittest.TestCase):
    def test_rotated_image_coverage(self):
        doc=fitz.open();p=doc.new_page(width=200,height=400)
        image=Image.new('RGB',(20,20),'white');data=io.BytesIO();image.save(data,format='PNG')
        p.insert_image(fitz.Rect(10,300,110,400),stream=data.getvalue())
        base=features(doc,p,'')
        for angle in [90,180,270]:
            p.set_rotation(angle);rotated=features(doc,p,'')
            self.assertEqual(rotated['imageCoverage'],base['imageCoverage'])
            self.assertEqual(rotated['placedImageStreamBytes'],base['placedImageStreamBytes'])
        doc.close()
    def test_shared_font_and_image_mask_and_overlap(self):
        doc=fitz.open();font=fitz.Font('helv').buffer
        image=Image.new('RGBA',(40,40),(90,100,110,128));data=io.BytesIO();image.save(data,format='PNG')
        for i in range(2):
            p=doc.new_page(width=100,height=100)
            p.insert_font(fontname='Shared',fontbuffer=font)
            p.insert_text((5,15),'Alpha beta',fontname='Shared',fontsize=8)
            for _ in range(2):p.insert_image(fitz.Rect(20,20,40,40),stream=data.getvalue())
        with tempfile.TemporaryDirectory(prefix='mixed-accounting-',dir=os.environ.get('TMPDIR','/home/dan/tmp/agents')) as tmp:
            path=Path(tmp)/'shared.pdf';doc.save(path,garbage=4);doc.close()
            report=inspect(path)
            self.assertTrue(any(o['kind']=='font' and len(o['referencedByPages'])==2 for o in report['objects']))
            self.assertGreaterEqual(sum(o['kind']=='image' and len(o['referencedByPages'])==2 for o in report['objects']),2)
            self.assertEqual(sum(report['streamBytes'].values())+report['nonStreamAndContainerBytes'],report['fileBytes'])
            reopened=fitz.open(path);f=features(reopened,reopened[0],'Alpha beta')
            self.assertAlmostEqual(f['imageCoverage'],.04)
            self.assertEqual(f['placedImageStreamBytes'],f['imageStreamBytes'])
            with self.assertRaises(RuntimeError):stream_bytes(reopened,[0],True)
            reopened.close()

if __name__=='__main__':unittest.main()
