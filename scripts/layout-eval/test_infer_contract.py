import argparse
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from infer import add_detector_arguments,create_detector,build_result


def arguments(extra=()):
    parser=argparse.ArgumentParser();add_detector_arguments(parser);return parser.parse_args(extra)


class InferContractTests(unittest.TestCase):
    def test_defaults_and_invalid_options(self):
        args=arguments();self.assertFalse(args.rectify_page);self.assertIsNone(args.orientation_onnx_path)
        for extra in (['--model-size','33'],['--model','pp-small-onnx','--model-size','640'],
                      ['--orientation-minimum-score','nan'],['--rectify-max-edge','8'],
                      ['--orientation-onnx-path','/missing/graph.onnx']):
            with patch('infer.load_detector') as loader:
                with self.assertRaises(ValueError):create_detector(arguments(extra))
                loader.assert_not_called()

    def test_wrappers_preserve_source_model_hash_and_configuration(self):
        class Wrapper:
            def __init__(self,base,*args,**kwargs):
                self.base=base;self.metadata={'id':base.metadata['id'],'revision':base.metadata['revision'],'detector':base.metadata}
        with tempfile.TemporaryDirectory() as temp:
            graph=Path(temp)/'orientation.onnx';graph.write_bytes(b'local-test')
            args=arguments(['--model-size','640','--processor','fast','--orientation-onnx-path',str(graph),
                            '--orientation-revision','test-pin','--orientation-minimum-score','.8','--rectify-page'])
            base=SimpleNamespace(metadata={'id':'test','revision':'r','graph_sha256':'a'*64})
            orientation=SimpleNamespace(OnnxOrientation=lambda path,**kwargs:dict(path=path,**kwargs),OrientedDetector=Wrapper)
            rectification=SimpleNamespace(RectifiedDetector=Wrapper)
            with patch.dict('sys.modules',orientation=orientation,rectification=rectification),patch('infer.load_detector',return_value=base) as loader:
                detector=create_detector(args)
            self.assertEqual(detector.metadata['graph_sha256'],'a'*64)
            self.assertEqual(loader.call_args.kwargs['model_size'],640)
            self.assertEqual(loader.call_args.kwargs['processor'],'fast')
            self.assertTrue(loader.call_args.kwargs['local_files_only'])

    def test_result_preserves_original_pixels_and_transform_diagnostics(self):
        from PIL import Image
        class Detector:
            metadata={'id':'test','revision':'r','orientation':{'revision':'pinned'}}
            supported_labels=['paragraph']
            last_image_metadata=[{'orientation':{'correction_angle':90}}]
            def predict(self,images,threshold):
                return [[dict(label='paragraph',raw_label='text',confidence=.9,bbox=[.1,.2,.8,.9],
                              polygon=[[.1,.2],[.8,.2],[.8,.9]],reading_order=0)]],{}
        data=io.BytesIO();Image.new('RGB',(20,10),'white').save(data,format='PNG')
        result=build_result(Detector(),data.getvalue(),'cpu')
        self.assertEqual(result['image']['width'],20)
        self.assertEqual(result['regions'][0]['readingOrder'],0)
        self.assertEqual(result['diagnostics']['imageTransforms'][0]['orientation']['correction_angle'],90)
        self.assertTrue(result['diagnostics']['nativeReadingOrder'])


if __name__=='__main__':unittest.main()
