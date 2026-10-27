import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

from contract import file_hash
from seal_v4 import validate_approval, validate_inventory


class V4SealTests(unittest.TestCase):
    def manifest(self):
        plan = [dict(familyId=f, classId='P', layoutId='A', split='train') for f in (0, 1)]
        cases = [dict(id=f'case-{f}-{h}', familyId=f, classId='P', layoutId='A',
                      split='train', pages=10, hardPercent=h, pdf=f'inputs/{f}-{h}.pdf',
                      labels=f'labels/{f}-{h}.json') for f in (0, 1) for h in range(0, 101, 20)]
        return dict(schema='mixed-pdf-manifest@4', stage='prototypes', handoffHash='h',
                    counts=dict(families=2, pdfs=12, pages=120), cases=cases), dict(dataset=dict(family_plan=plan))

    def test_exact_stage_membership_and_paths(self):
        manifest, spec = self.manifest()
        validate_inventory(manifest, spec)
        for kind in ['omit-family', 'duplicate', 'wrong-split', 'traversal', 'wrong-class']:
            changed = copy.deepcopy(manifest)
            if kind == 'omit-family':
                changed['cases'] = changed['cases'][:6]
                changed['counts'] = dict(families=1, pdfs=6, pages=60)
            elif kind == 'duplicate': changed['cases'][1]['id'] = changed['cases'][0]['id']
            elif kind == 'wrong-split': changed['cases'][0]['split'] = 'heldout'
            elif kind == 'traversal': changed['cases'][0]['labels'] = '../other.json'
            else: changed['cases'][0]['classId'] = 'E2'
            with self.assertRaises(ValueError):
                validate_inventory(changed, spec)

    def approval(self, root, manifest):
        decisions = {}
        for name in ['auditDecision', 'judgeDecision']:
            decisions[name] = {'pass': True, 'decision': 'pass', 'score': 100,
                               'stage': 'audit' if name == 'auditDecision' else 'judge',
                               'counts': dict(fatal=0, high=0, medium=0, low=0)}
        decisions['semanticValidation'] = dict(passed=True, originalCorpusUnchanged=True,
            corpusManifestSha256='manifest', handoffHash='h', checkedCases=manifest['cases'],
            counts=dict(authoringPages=20, labelPages=120, pdfsHashed=12))
        approval = dict(schema='mixed-pdf-evaluation-approval@1', coordinatorApproval=True,
                        stage='prototypes', datasetManifestSha256='manifest', handoffHash='h')
        for name, value in decisions.items():
            path = root / f'{name}.json'; path.write_text(json.dumps(value))
            approval[name] = dict(path=str(path), sha256=file_hash(path))
        return approval

    def test_frozen_approval_and_distinct_review_stages(self):
        manifest, _ = self.manifest()
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            approval = self.approval(Path(tmp), manifest)
            validate_approval(approval, manifest, 'manifest')
            for kind in ['wrong-corpus', 'audit-as-judge', 'changed-file', 'missing-semantic']:
                changed = copy.deepcopy(approval)
                if kind == 'wrong-corpus': changed['datasetManifestSha256'] = 'other'
                elif kind == 'audit-as-judge': changed['judgeDecision'] = changed['auditDecision']
                elif kind == 'changed-file': changed['auditDecision']['sha256'] = 'other'
                else:
                    path = Path(tmp) / 'missing.json'; path.write_text('{}')
                    changed['semanticValidation'] = dict(path=str(path), sha256=file_hash(path))
                with self.assertRaises(ValueError):
                    validate_approval(changed, manifest, 'manifest')


if __name__ == '__main__':
    unittest.main()
