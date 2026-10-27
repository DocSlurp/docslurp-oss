import json,os,tempfile,unittest
from pathlib import Path
from contract import file_hash
from report import timing_summary

class ReportTests(unittest.TestCase):
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
