"""Fast deterministic tests for matching, coordinate preservation, and leakage boundaries."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from scoring import iou,match_boxes,score_pages
from adapters import canonical,HERON_LABELS,normalized_region


class ScoringTests(unittest.TestCase):
    def test_iou_degenerate_and_touching(self):
        self.assertEqual(iou([0,0,1,1],[1,0,2,1]),0)
        self.assertEqual(iou([0,0,0,0],[0,0,0,0]),0)
        self.assertAlmostEqual(iou([0,0,1,1],[0,0,.5,1]),.5)

    def test_duplicate_predictions_penalized(self):
        region={'label':'table','bbox':[0,0,1,1]}
        score=score_pages([{'truth':[region],'regions':[region,region]}],['table'])
        self.assertEqual(score['iou50']['all_classes']['tp'],1)
        self.assertEqual(score['iou50']['all_classes']['fp'],1)
        self.assertAlmostEqual(score['iou50']['all_classes']['f1'],2/3)

    def test_wrong_class_and_unsupported_not_hidden(self):
        truth={'label':'photo','bbox':[0,0,1,1]}
        pred={'label':'figure','bbox':[0,0,1,1]}
        score=score_pages([{'truth':[truth],'regions':[pred]}],['figure'])
        self.assertEqual(score['iou50']['all_classes']['f1'],0)
        self.assertEqual(score['iou50']['class_agnostic_localization']['f1'],1)
        self.assertFalse(score['iou50']['per_class']['photo']['supported'])
        self.assertIn('photo',score['unsupported_labels'])

    def test_best_iou_one_to_one(self):
        truth=[{'label':'table','bbox':[0,0,1,1]},{'label':'table','bbox':[.8,0,1.8,1]}]
        pred=[{'label':'table','bbox':[.1,0,1.1,1]}]
        self.assertEqual(match_boxes(truth,pred)[0][0],0)
        self.assertEqual(len(match_boxes(truth,pred)),1)

    def test_macro_includes_unsupported_truth_classes(self):
        table={'label':'table','bbox':[0,0,1,1]}; photo={'label':'photo','bbox':[0,0,1,1]}
        score=score_pages([{'truth':[table,photo],'regions':[table]}],['table'])['iou50']
        self.assertEqual(score['macro_f1_truth_present'],.5)
        self.assertEqual(score['macro_f1_supported_truth_present'],1.)
        self.assertEqual(score['unsupported_truth_regions'],1)

    def test_missing_predictions_penalized(self):
        score=score_pages([{'truth':[{'label':'table','bbox':[0,0,1,1]}],'regions':[]}],['table'])
        self.assertEqual(score['iou50']['all_classes']['fn'],1)
        self.assertEqual(score['iou50']['all_classes']['recall'],0)

    def test_reading_order_absent_is_unknown(self):
        r={'label':'table','bbox':[0,0,1,1],'reading_order':1}
        p=dict(r); p.pop('reading_order')
        score=score_pages([{'truth':[r],'regions':[p]}],['table'])
        self.assertIsNone(score['iou50']['reading_order_pair_accuracy'])

    def test_heron_does_not_claim_photo_distinction(self):
        self.assertEqual(canonical('Picture',HERON_LABELS),'figure')
        self.assertEqual(canonical('List-item',HERON_LABELS),'list')
        self.assertEqual(canonical('Unseen',HERON_LABELS),'unknown')

    def test_nonfinite_boxes_fail(self):
        with self.assertRaises(ValueError): normalized_region('Table',.9,[0,0,float('nan'),1],(200,100),HERON_LABELS)
        with self.assertRaises(ValueError): normalized_region('Table',.9,[0,0,0,1],(200,100),HERON_LABELS)

    def test_boxes_normalize_source_and_clip(self):
        region=normalized_region('Table',.9,[-1,20,300,120],(200,100),HERON_LABELS)
        self.assertEqual(region['bbox'],[0.,.2,1.,1.])


@unittest.skipUnless(importlib.util.find_spec('PIL'),'Pillow optional for scoring-only tests')
class ImageTests(unittest.TestCase):
    def test_original_payload_decoded_once_and_has_no_producer_cost(self):
        import io
        from unittest.mock import patch
        from PIL import Image
        from benchmark import transform_bytes
        buffer=io.BytesIO(); Image.new('RGB',(40,60),'white').save(buffer,format='PNG')
        with patch('PIL.Image.open',wraps=Image.open) as opened:
            image,details=transform_bytes(buffer.getvalue(),{'codec':'original'})
        self.assertEqual(opened.call_count,1)
        self.assertEqual(details['producer_path_ms'],0.)
        self.assertEqual(details['payload_decode_ms'],0.)
        self.assertGreater(details['consumer_decode_ms'],0.)
        self.assertEqual(image.size,(40,60))

    def test_resampling_preserves_normalized_coordinates_and_bytes_are_real(self):
        import io
        from PIL import Image
        from benchmark import transform_bytes,normalized_truth
        original=Image.new('RGB',(200,100),'white'); original.paste('black',(20,20,80,80))
        stream=io.BytesIO(); original.save(stream,format='PNG')
        image,details=transform_bytes(stream.getvalue(),{'max_edge':100,'codec':'jpeg','quality':50})
        self.assertEqual(image.size,(100,50)); self.assertGreater(details['payload_bytes'],0)
        self.assertEqual(normalized_truth({'width':200,'height':100,'regions':[{'label':'table','bbox':[20,20,80,80]}]})[0]['bbox'],[.1,.2,.4,.8])
        self.assertEqual(normalized_region('Table',1,[10,10,40,40],image.size,HERON_LABELS)['bbox'],[.1,.2,.4,.8])

    def test_failure_time_counts_towards_delivered_throughput(self):
        from benchmark import summarize
        result=summarize([{'error':None,'truth':[],'regions':[],'timings':{'end_to_end_ms':1000},'payload_bytes':100},
                          {'error':'failure','truth':[],'regions':[],'timings':{'end_to_end_ms':9000}}],[],1.)
        self.assertAlmostEqual(result['throughput_pages_per_second'],.1)
        self.assertAlmostEqual(result['compute_usd_per_1000_successful_pages'],10/3600*1000)

    def test_fingerprints_and_coverage_only_images(self):
        from PIL import Image
        from fingerprints import describe_region
        image=Image.new('RGB',(20,30),'white')
        figure=describe_region(image,{'label':'figure','bbox':[0,0,1,1]})
        self.assertEqual(figure['coverageKind'],'full-page')
        self.assertEqual(len(figure['fingerprint']['value']),16)
        self.assertEqual(len(figure['exactCropSha256']),64)
        text=describe_region(image,{'label':'paragraph','bbox':[0,0,1,1]})
        self.assertNotIn('coverageKind',text)

    def test_palette_bilevel_and_lossless_variants_keep_dimensions(self):
        import io
        from PIL import Image
        from benchmark import transform_bytes
        image=Image.new('RGB',(160,100),'white'); image.paste('red',(20,20,80,80))
        stream=io.BytesIO(); image.save(stream,format='PNG')
        for variant in ({'codec':'png','max_edge':80,'palette_colors':16},
                        {'codec':'png','max_edge':80,'binary_threshold':160},
                        {'codec':'webp','max_edge':80,'lossless':True}):
            result,details=transform_bytes(stream.getvalue(),variant)
            self.assertEqual(result.size,(80,50))
            self.assertEqual(details['source_size'],(160,100))
            self.assertGreater(details['producer_path_ms'],0.)
            self.assertGreater(details['consumer_decode_ms'],0.)
            self.assertGreater(details['payload_bytes'],0)

    def test_manifest_jsonl_and_json_reference_formats(self):
        from benchmark import read_manifest,load_reference
        # Caller supplies task-owned scratch via TMPDIR; never force RAM-backed /tmp.
        with tempfile.TemporaryDirectory(prefix='layout-tests-') as directory:
            root=Path(directory)
            row={'id':'a','image_path':'a.png','width':20,'height':30,'regions':[]}
            (root/'manifest.jsonl').write_text(json.dumps(row)+'\n')
            self.assertEqual(read_manifest(root/'manifest.jsonl'),[row])
            (root/'manifest.json').write_text(json.dumps({'pages':[row]}))
            self.assertEqual(read_manifest(root/'manifest.json'),[row])
            (root/'reference.json').write_text(json.dumps({'image':{'width':20,'height':30},'regions':[]}))
            self.assertEqual(load_reference({'reference_path':'reference.json'},root)['height'],30)


if __name__=='__main__': unittest.main()
