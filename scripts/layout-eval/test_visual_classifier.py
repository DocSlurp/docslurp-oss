import unittest
from visual_classifier import PROMPTS, PROMPTS_SHA256, VisualClassifierDetector, classify_scores, crop_box

class Image:
    width=100
    height=80
    def crop(self,box): return self
    def convert(self,mode): return self

class Base:
    supported_labels=['figure','chart']
    metadata={'id':'test','revision':'test','graph_sha256':'0'*64}
    def __init__(self):
        self.regions=[{'label':'figure','raw_label':'picture','confidence':.9,'bbox':[.1,.2,.9,.8]},
                      {'label':'chart','raw_label':'chart','confidence':.8,'bbox':[0,0,.1,.1]}]
    def predict(self,images,threshold): return [self.regions],{'inference_ms':10.}
    def memory(self): return {}

class Classifier:
    metadata={}
    def classify(self,crops):
        assert len(crops)==1
        return [classify_scores([.8,.1,.2,.3,.4,.1])],2.

class Tests(unittest.TestCase):
    def test_abstains_without_calibrated_probability(self):
        self.assertEqual(classify_scores([.3,.29,.1,.1,.1,.1])['label'],'figure')
        result=classify_scores([.1,.1,.1,.1,.1,.9])
        self.assertFalse(result['accepted'])
        self.assertEqual(result['scoreKind'],'cosine-similarity-not-probability')
        with self.assertRaises(ValueError): classify_scores([float('nan')]*len(PROMPTS))
    def test_preserves_detection_and_does_not_reclassify_native_chart(self):
        base=Base(); wrapped=VisualClassifierDetector(base,Classifier())
        result,timing=wrapped.predict([Image()])
        self.assertEqual(wrapped.metadata['graph_sha256'],'0'*64)
        self.assertEqual(result[0][0]['label'],'photo')
        self.assertEqual(result[0][0]['detector_label'],'figure')
        self.assertEqual(result[0][0]['raw_label'],'picture')
        self.assertEqual(result[0][0]['confidence'],.9)
        self.assertEqual(base.regions[0]['label'],'figure')
        self.assertNotIn('classification',result[0][1])
        self.assertEqual(timing['visual_classification_ms'],2.)
    def test_crop_mapping(self):
        self.assertEqual(crop_box(Image(),[.1,.2,.9,.8]),(10,16,90,64))
        with self.assertRaises(ValueError): crop_box(Image(),[.9,0,.1,1])
    def test_prompt_manifest_is_fingerprinted(self):
        self.assertEqual(len(PROMPTS_SHA256),64)
        self.assertEqual({x[0] for x in PROMPTS},{'photo','chart','logo','illustration','mind_map','figure'})

if __name__=='__main__': unittest.main()
