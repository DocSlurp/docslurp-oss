import argparse
from http.server import HTTPServer
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from PIL import Image
from infer import add_detector_arguments,build_result
from server import make_handler
from transport_benchmark import forwarded_arguments,loopback_url,request_json,validate_result,compare_results


class FakeDetector:
    metadata={'id':'test/layout','revision':'fixture-v1'}
    supported_labels=['figure']
    def predict(self,images,threshold):
        return [[{'label':'figure','raw_label':'picture','confidence':.9,'bbox':[0.,0.,1.,1.]}] for _ in images],{'inference_ms':.1}


def image_bytes():
    stream=io.BytesIO();image=Image.new('RGB',(40,60),'white');image.paste('red',(5,5,20,30));image.save(stream,format='PNG')
    return stream.getvalue()


class TransportTests(unittest.TestCase):
    def test_detector_arguments_roundtrip_includes_opt_in_profiles(self):
        parser=argparse.ArgumentParser(add_help=False);add_detector_arguments(parser)
        args=parser.parse_args(['--model','pp-small-onnx','--onnx-path','/models/layout.onnx','--rectify-page','--model-size','640'])
        self.assertEqual(vars(parser.parse_args(forwarded_arguments(args,parser))),vars(args))

    def test_network_is_loopback_only(self):
        self.assertEqual(loopback_url('http://127.0.0.1:8769'),('127.0.0.1',8769))
        for value in ('https://127.0.0.1','http://example.com','http://u:p@127.0.0.1','http://127.0.0.1/layout'):
            with self.assertRaises(ValueError):loopback_url(value)

    def test_source_and_crop_fingerprints_are_verified(self):
        data=image_bytes();result=build_result(FakeDetector(),data,'cpu')
        validate_result(result,data)
        bad=json.loads(json.dumps(result));bad['image']['sha256']='0'*64
        with self.assertRaises(ValueError):validate_result(bad,data)
        bad=json.loads(json.dumps(result));bad['regions'][0]['exactCropSha256']='0'*64
        with self.assertRaises(ValueError):validate_result(bad,data)
        self.assertTrue(compare_results(result,result)['parity'])

    def test_actual_http_handler_receives_original_bytes(self):
        data=image_bytes();server=HTTPServer(('127.0.0.1',0),make_handler(FakeDetector(),'cpu',.3,12.5))
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True);thread.start()
        try:
            origin=f'http://127.0.0.1:{server.server_port}'
            health,_=request_json(origin,'/health');self.assertEqual(health['modelLoadMs'],12.5)
            result,timing=request_json(origin,'/layout',data)
            validate_result(result,data);self.assertGreater(timing['response_bytes'],0)
            self.assertEqual(result['diagnostics']['execution'],'warm-resident')
            with self.assertRaises(RuntimeError):request_json(origin,'/missing',data)
        finally:server.shutdown();server.server_close();thread.join(timeout=1)

    def test_managed_server_and_cli_phases_end_to_end_without_models(self):
        with tempfile.TemporaryDirectory(prefix='layout-transport-test-') as directory:
            root=Path(directory);(root/'image.png').write_bytes(image_bytes())
            common=f"import sys\nsys.path.insert(0,{str(Path(__file__).parent)!r})\nfrom test_transport_benchmark import FakeDetector\nfrom infer import add_detector_arguments,build_result,encode_result\nimport argparse,time\nfrom pathlib import Path\n"
            server_code=common+"from http.server import HTTPServer\nfrom server import make_handler\np=argparse.ArgumentParser();p.add_argument('--port',type=int);add_detector_arguments(p);a=p.parse_args()\ns=HTTPServer(('127.0.0.1',a.port),make_handler(FakeDetector(),a.device,a.threshold,.01));s.serve_forever()\n"
            cli_code=common+"p=argparse.ArgumentParser();p.add_argument('--image');p.add_argument('--output');add_detector_arguments(p);a=p.parse_args()\nr=build_result(FakeDetector(),Path(a.image).read_bytes(),a.device,a.threshold);r['diagnostics']['modelLoadMs']=.01;Path(a.output).write_bytes(encode_result(r))\n"
            (root/'server.py').write_text(server_code);(root/'cli.py').write_text(cli_code)
            command=[sys.executable,str(Path(__file__).with_name('transport_benchmark.py')),'--image',str(root/'image.png'),
                     '--output-dir',str(root/'results'),'--python',sys.executable,'--server-script',str(root/'server.py'),
                     '--cli-script',str(root/'cli.py'),'--repeats','1','--warmup','1','--max-seconds','15']
            result=subprocess.run(command,capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            summary=json.loads((root/'results/summary.json').read_text())
            self.assertEqual(summary['summaries']['http']['attempts'],1)
            self.assertEqual(summary['summaries']['cli']['attempts'],1)
            self.assertTrue(summary['pairs'][0]['parity'])
            self.assertEqual(summary['summaries']['cli']['model_load_ms']['mean'],.01)
            self.assertEqual(summary['server']['ownership'],'managed')


if __name__=='__main__':unittest.main()
