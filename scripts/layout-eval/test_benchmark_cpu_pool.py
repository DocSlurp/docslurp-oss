import hashlib
from concurrent.futures import ProcessPoolExecutor
import multiprocessing
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
import benchmark_cpu_pool as pool


class Detector:
    metadata={'id':'unit-test-detector','graph_sha256':'testgraph','revision':'test'}
    def predict(self,images,threshold):
        return [[{'label':'paragraph','raw_label':'text','confidence':.9,'bbox':[.1,.2,.8,.9]}]],{'preprocess_ms':1.,'inference_ms':2.,'postprocess_ms':1.}


def fake_initialize(ready):
    pool._DETECTOR=Detector();pool._CONFIG={'threshold':.3}
    import os
    ready.put(os.getpid())


class CpuPoolTests(unittest.TestCase):
    def test_worker_only_image_fields_and_serialized_predictions(self):
        with tempfile.TemporaryDirectory(prefix='cpu-pool-test-',dir='/home/dan/tmp/agents') as tmp:
            path=Path(tmp)/'source.png';Image.new('RGB',(20,30),'white').save(path)
            item={'page_id':'opaque-1','repeat':0,'image_path':str(path),'image_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'image_size':[20,30]}
            with patch.object(pool,'_DETECTOR',Detector()),patch.object(pool,'_CONFIG',{'threshold':.3}):
                body,start,end,serialization,cpu=pool.execute(item)
            row=json.loads(body)
            self.assertEqual(row['source_sha256'],item['image_sha256']);self.assertEqual(row['regions'][0]['raw_label'],'text')
            self.assertNotIn('truth',row);self.assertGreater(end,start);self.assertGreaterEqual(cpu,0)
            bad=dict(item,image_sha256='wrong')
            with patch.object(pool,'_DETECTOR',Detector()),patch.object(pool,'_CONFIG',{'threshold':.3}):
                row=json.loads(pool.execute(bad)[0])
            self.assertIn('SHA',row['error']);self.assertEqual(row['regions'],[])

    def test_spawned_workers_return_predictions_over_ipc(self):
        with tempfile.TemporaryDirectory(prefix='cpu-pool-spawn-',dir='/home/dan/tmp/agents') as tmp:
            path=Path(tmp)/'source.png';Image.new('RGB',(20,30),'white').save(path)
            item={'page_id':'opaque','repeat':0,'image_path':str(path),'image_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'image_size':[20,30]}
            context=multiprocessing.get_context('spawn');ready=context.Queue()
            with ProcessPoolExecutor(max_workers=2,mp_context=context,initializer=fake_initialize,initargs=(ready,)) as executor:
                pending=[executor.submit(pool.execute,dict(item,repeat=i)) for i in range(4)]
                pids={ready.get(timeout=10) for _ in range(2)}
                rows=[json.loads(future.result(timeout=10)[0]) for future in pending]
            ready.close()
            self.assertEqual(len(pids),2);self.assertEqual(len(rows),4)
            self.assertTrue(all(row['worker_pid'] in pids for row in rows))
            self.assertTrue(all(not row['error'] and 'truth' not in row for row in rows))

    def test_audit_rejects_raw_label_change_and_missing_pairs(self):
        row={'page_id':'opaque','repeat':0,'source_sha256':'same','model':{'graph_sha256':'graph'},'error':None,
             'regions':[{'label':'title','raw_label':'title','confidence':.8,'bbox':[.1,.1,.9,.9]}]}
        with tempfile.TemporaryDirectory(prefix='cpu-pool-audit-',dir='/home/dan/tmp/agents') as tmp:
            path=Path(tmp)/'serial.jsonl';path.write_text(json.dumps(row)+'\n')
            self.assertTrue(pool.audit_predictions([row],path)['pass'])
            changed=dict(row,regions=[dict(row['regions'][0],raw_label='section_header')])
            self.assertFalse(pool.audit_predictions([changed],path)['pass'])
            self.assertFalse(pool.audit_predictions([dict(row,page_id='different')],path)['pass'])

    def test_legacy_serial_page_only_and_absolute_coordinate_guard(self):
        region={'label':'table','raw_label':'table','confidence':.8,'bbox':[.1,.1,.9,.9]}
        old={'page_id':'opaque','repeat':0,'source_sha256':'image','error':None,'regions':[region]}
        pooled=dict(old,repeat=7,model={'graph_sha256':'graph'})
        with tempfile.TemporaryDirectory(prefix='cpu-pool-legacy-',dir='/home/dan/tmp/agents') as tmp:
            path=Path(tmp)/'serial.jsonl';path.write_text(json.dumps(old)+'\n'+json.dumps(dict(old,repeat=1))+'\n')
            path.with_suffix('.metadata.json').write_text(json.dumps({'model':{'graph_sha256':'graph'}}))
            self.assertTrue(pool.audit_predictions([pooled],path,ignore_repeat=True)['pass'])
            changed=dict(pooled,regions=[dict(region,bbox=[.1001,.1,.9,.9])])
            self.assertFalse(pool.audit_predictions([changed],path,ignore_repeat=True)['pass'])

    def test_strict_dev_rejected_before_model_load(self):
        with tempfile.TemporaryDirectory(prefix='cpu-pool-split-',dir='/home/dan/tmp/agents') as tmp:
            root=Path(tmp);manifest=root/'manifest.jsonl';manifest.write_text(json.dumps({'id':'unseen','split':'holdout'})+'\n')
            with self.assertRaisesRegex(ValueError,'dev-only'):
                pool.main(['--manifest',str(manifest),'--onnx-path',str(root/'nonexistent.onnx'),'--revision','test','--output',str(root/'out.jsonl')])
            self.assertFalse((root/'out.jsonl').exists())


if __name__=='__main__':unittest.main()
