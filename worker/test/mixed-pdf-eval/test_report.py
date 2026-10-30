import json,os,tempfile,unittest
from pathlib import Path
from contract import file_hash
from report import timing_summary,validated_heldout
from unittest.mock import patch
from contract import identity_hash

class ReportTests(unittest.TestCase):
    def test_heldout_receipts_reject_mixed_policies_splits_and_partial_panels(self):
        with tempfile.TemporaryDirectory(prefix='mixed-binding-test-',dir=os.environ.get('TMPDIR','/home/dan/tmp/agents')) as tmp:
            root=Path(tmp);identity={'invented':'identity'};policy={'mode':'native'}
            families=[f'invented-{i}' for i in range(18)]
            put=lambda name,value:(root/name).write_text(json.dumps(value))
            put('evaluation-identity.json',identity);put('tune-complete.json',{})
            receipt={'schema':'mixed-pdf-policy@v2','policy':policy,'evaluationIdentity':identity,
                     'optimizerHash':file_hash(Path(__file__).with_name('optimize.py')),
                     'tuningInventoryHash':file_hash(root/'tune-complete.json'),'developmentFamilies':['development-only']}
            put('frozen-policy.json',receipt);put('heldout-complete.json',{})
            put('dataset-manifest.json',{'cases':[{'family':f,'split':'heldout'} for f in families]})
            inventory={'policyHash':file_hash(root/'frozen-policy.json'),'selectedFamilies':families.copy()}
            result={'quality':1,'passRate':1}
            report={'split':'heldout','policy':policy,'policyHash':inventory['policyHash'],
                    'evaluationIdentityHash':identity_hash(identity),'inventoryHash':file_hash(root/'heldout-complete.json'),
                    'result':result,'constraintsPass':True,'qualityNoninferioritySupported':True}
            # Panel hashing and complete membership are exercised by contract tests;
            # isolate reconciliation's independent policy/report/completeness checks here.
            with patch('report.load_panel',return_value=([{}],inventory)),patch('report.summarize',return_value=result),\
                 patch('report.eligible',return_value=True),patch('report.bootstrap',return_value={'qualityDifference95CI':[0,0],'acceptanceDifference95CI':[0,0]}):
                put('heldout-report.json',report)
                self.assertEqual(validated_heldout(root,root),report)
                for key,value in [('split','tune'),('policy',{'mode':'ocr-strong'}),('policyHash','wrong'),
                                  ('evaluationIdentityHash','wrong'),('inventoryHash','wrong'),('result',{'quality':0})]:
                    put('heldout-report.json',{**report,key:value})
                    with self.assertRaisesRegex(RuntimeError,'heldout-report-'):validated_heldout(root,root)
                put('heldout-report.json',report)
                inventory['selectedFamilies']=families[:-1]
                with self.assertRaisesRegex(RuntimeError,'complete-heldout-panel'):validated_heldout(root,root)
                inventory['selectedFamilies']=families.copy();inventory['policyHash']='other-policy'
                with self.assertRaisesRegex(RuntimeError,'heldout-policy-binding'):validated_heldout(root,root)

    def test_split_report_compares_layout_work_and_separates_spatial_capture(self):
        from optimize import split_report
        chunk=dict(bytes=110,splitSeconds=.2,extractSeconds=2,accountingSeconds=.1,nativeTokensEqual=True)
        case=dict(pdfBytes=100,nativeSeconds=10,nativeLayoutSeconds=1,nativeBboxSeconds=9,
                  splits={'1':dict(chunk),'4':dict(chunk)})
        report=split_report([case])['1']
        self.assertEqual(report['originalExtractSeconds'],1)
        self.assertGreater(report['extractSeconds'],report['originalExtractSeconds'])
        self.assertEqual(report['originalSpatialCaptureSeconds'],9)
        self.assertEqual(report['timingBasis'],'pdftotext-layout-only')
        self.assertEqual(report['accountingSeconds'],.1)
        del case['nativeLayoutSeconds']
        with self.assertRaisesRegex(RuntimeError,'missing-layout-only-timing'):
            split_report([case])

    def test_paired_timing_and_modified_sample_rejection(self):
        with tempfile.TemporaryDirectory(prefix='mixed-report-test-',dir=os.environ.get('TMPDIR','/home/dan/tmp/agents')) as tmp:
            root=Path(tmp);schedule=[]
            for case in ['invented-a','invented-b']:
                for repeat in range(3):
                    for arm in ['strong','selected']:
                        row={'case':case,'repeat':repeat,'arm':arm};schedule.append(row)
                        (root/f'{len(schedule)-1:03d}.json').write_text(json.dumps({**row,'policyHash':'policy','pages':10,'elapsedSeconds':2 if arm=='strong' else 1,'cpuSeconds':1}))
            (root/'schedule.json').write_text(json.dumps({'policyHash':'policy','schedule':schedule}))
            (root/'complete.json').write_text(json.dumps({'scheduleHash':file_hash(root/'schedule.json'),'samples':len(schedule),
                'resultHashes':{f'{i:03d}.json':file_hash(root/f'{i:03d}.json') for i in range(len(schedule))}}))
            result=timing_summary(root,'policy')
            self.assertEqual(result['elapsedSaving'],.5)
            self.assertEqual(result['elapsedSaving95CI'],[.5,.5])
            (root/'000.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError,'changed-timing-sample'):timing_summary(root,'policy')

if __name__=='__main__':unittest.main()
