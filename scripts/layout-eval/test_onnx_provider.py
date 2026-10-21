"""Provider identity must survive runtime execution failures, not only startup."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
from adapters import OnnxSmallDetector


class ProviderFailure(RuntimeError):pass


class FakeSession:
    def __init__(self,path,sess_options,providers):
        self.providers=list(providers);self.fallback_enabled=True;self.disable_calls=0
    def get_providers(self):return self.providers
    def get_provider_options(self):return {provider:{} for provider in self.providers}
    def get_inputs(self):return [SimpleNamespace(name='image',shape=[1,3,480,480],type='tensor(float)')]
    def disable_fallback(self):self.fallback_enabled=False;self.disable_calls+=1
    def run(self,output_names,feed):
        # Mirror ORT's EPFail handler: without the guard it silently replaces the
        # CUDA session and returns output from its CPU retry.
        if self.fallback_enabled:
            self.providers=['CPUExecutionProvider']
            return [np.empty((0,6),dtype=np.float32),np.array([0])]
        raise ProviderFailure('CUDA execution provider failed')


class OnnxProviderTests(unittest.TestCase):
    def detector(self,device):
        runtime=SimpleNamespace(SessionOptions=SimpleNamespace,
          GraphOptimizationLevel=SimpleNamespace(ORT_ENABLE_ALL=1),InferenceSession=FakeSession,
          get_available_providers=lambda:['CUDAExecutionProvider','CPUExecutionProvider'])
        with TemporaryDirectory() as directory:
            graph=Path(directory)/'model.onnx';graph.write_bytes(b'fake-local-model')
            with patch.dict('sys.modules',onnxruntime=runtime,torch=SimpleNamespace()):
                return OnnxSmallDetector(onnx_path=str(graph),device=device)

    def test_cuda_disables_runtime_retry_and_propagates_provider_failure(self):
        detector=self.detector('cuda')
        self.assertEqual(detector.session.disable_calls,1)
        self.assertFalse(detector.session.fallback_enabled)
        # Explicit CPU node placement remains available; only whole-session retry stops.
        self.assertEqual(detector.session.providers,['CUDAExecutionProvider','CPUExecutionProvider'])
        with self.assertRaisesRegex(ProviderFailure,'CUDA execution provider failed'):
            detector.predict([Image.new('RGB',(30,40))])
        self.assertEqual(detector.session.get_providers(),['CUDAExecutionProvider','CPUExecutionProvider'])

    def test_cpu_session_behavior_is_unchanged(self):
        detector=self.detector('cpu')
        self.assertEqual(detector.session.disable_calls,0)
        self.assertTrue(detector.session.fallback_enabled)
        predictions,_=detector.predict([Image.new('RGB',(30,40))])
        self.assertEqual(predictions,[[]])
        self.assertEqual(detector.session.get_providers(),['CPUExecutionProvider'])


if __name__=='__main__':unittest.main()
