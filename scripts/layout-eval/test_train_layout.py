import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from custom_layout import LABELS,ARCHITECTURE,validate_config,convert_predictions
from train_layout import read_split,assert_disjoint,targets,load_image,move_inputs,main


def row(split='train'):
    return {'id':'sample','split':split,'width':100,'height':80,'image_path':'images/sample.png',
            'metadata':{'source_id':'source-a','document_id':'doc-a','template_family':'template-a','image_sha256':'a'*64},
            'regions':[{'label':'paragraph','bbox':[1,2,70,60]}]}


class TrainingBoundaryTests(unittest.TestCase):
    def test_reader_rejects_mixed_splits_and_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'train.jsonl';data=json.dumps(row())+'\n';path.write_text(data)
            rows,digest=read_split(path,'train')
            self.assertEqual(len(rows),1);self.assertEqual(digest,hashlib.sha256(data.encode()).hexdigest())
            for split in ('dev','holdout'):
                path.write_text(data+json.dumps(dict(row(split),id='other'))+'\n')
                with self.assertRaisesRegex(ValueError,'mixed/holdout'):read_split(path,'train')
            with self.assertRaisesRegex(ValueError,'holdout'):read_split(path,'holdout')

    def test_failed_attempt_keeps_receipt_without_loading_model(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'bad.jsonl';path.write_text(json.dumps(row('holdout'))+'\n')
            output=Path(temp)/'attempt'
            with self.assertRaisesRegex(ValueError,'mixed/holdout'):
                main(['--manifest',str(path),'--root',temp,'--output',str(output),'--device','cpu'])
            receipt=json.loads((output/'receipt.json').read_text())
            self.assertEqual(receipt['status'],'failed');self.assertEqual(receipt['steps'],0)
            self.assertGreaterEqual(receipt['peak_rss_bytes'],0)

    def test_boxes_and_classes_fail_closed(self):
        sample=row();self.assertEqual(targets(sample),([[1,2,70,60]],[0]))
        for invalid in ([2,2,1,5],[-1,2,5,6],[1,2,float('nan'),6],[1,2,101,60]):
            sample=row();sample['regions'][0]['bbox']=invalid
            with self.assertRaises(ValueError):targets(sample)
        sample=row();sample['regions'][0]['label']='undeclared'
        with self.assertRaisesRegex(ValueError,'category'):targets(sample)

    def test_cluster_and_image_overlap_rejected(self):
        train=row();dev=row('dev')
        for key in ('source_id','document_id','template_family','image_sha256'):
            dev['metadata']={name:'different-'+name for name in train['metadata']}
            dev['metadata'][key]=train['metadata'][key]
            with self.assertRaisesRegex(ValueError,'overlap'):assert_disjoint([train],[dev])
        dev['metadata']={name:'different-'+name for name in train['metadata']}
        assert_disjoint([train],[dev])

    def test_image_path_hash_and_dimensions_checked(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'images').mkdir();path=root/'images/sample.png'
            Image.new('RGB',(100,80),'white').save(path);sample=row()
            with self.assertRaisesRegex(ValueError,'hash'):load_image(root,sample)
            sample['metadata']['image_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(load_image(root,sample).size,(100,80))
            sample['width']=99
            with self.assertRaisesRegex(ValueError,'dimensions'):load_image(root,sample)
            sample['image_path']='../escape.png'
            with self.assertRaisesRegex(ValueError,'escapes'):load_image(root,sample)

    def test_custom_checkpoint_exact_class_contract(self):
        config={'docslurp_layout_architecture':ARCHITECTURE,'id2label':dict(enumerate(LABELS))}
        validate_config(config)
        bad=copy.deepcopy(config);bad['id2label'][0]='figure'
        with self.assertRaisesRegex(ValueError,'contract'):validate_config(bad)
        with self.assertRaisesRegex(ValueError,'contract'):validate_config({'id2label':dict(enumerate(LABELS))})

    def test_prediction_mapping_and_nested_device_transfer(self):
        class Values:
            def __init__(self,values):self.values=values
            def tolist(self):return self.values
            def to(self,device):return ('moved',device)
        class Image: size=(100,80)
        pred={'boxes':Values([[10,8,90,72]]),'scores':Values([.9]),'labels':Values([LABELS.index('photo')])}
        result=convert_predictions([pred],[Image()],.3)[0][0]
        self.assertEqual(result['label'],'photo');self.assertEqual(result['bbox'],[.1,.1,.9,.9])
        pred['labels']=Values([99])
        with self.assertRaises(ValueError):convert_predictions([pred],[Image()],.3)
        self.assertEqual(move_inputs({'labels':[{'boxes':Values([])}]},'cuda'),{'labels':[{'boxes':('moved','cuda')}]})


if __name__=='__main__':unittest.main()
