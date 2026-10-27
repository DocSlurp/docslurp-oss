import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

from contract import file_hash, identity_hash
from fools_gold_v4_common import freeze
from approval_v4 import validator_identity
from seal_v4 import seal, validate_approval, validate_inventory


class V4SealTests(unittest.TestCase):
    def manifest(self, split=False):
        plan = [dict(familyId=f, classId='P', layoutId='A',
                     split='heldout' if split and f else 'train') for f in (0, 1)]
        cases = []
        for f in (0, 1):
            for h in range(0, 101, 20):
                cases.append(dict(id=f'case-{f}-{h}', familyId=f, classId='P', layoutId='A',
                    split=plan[f]['split'], pages=10, hardPercent=h, pdf=f'inputs/{f}-{h}.pdf',
                    labels=f'labels/{f}-{h}.json', sha256=identity_hash(f'pdf-{f}-{h}'),
                    labelHash=identity_hash(f'labels-{f}-{h}'), sourceLayoutHash=identity_hash(f'layout-{f}'),
                    authoringHash=identity_hash(f'authoring-{f}'), worldHash=identity_hash(f'world-{f}'),
                    pageContentHashes=[identity_hash(f'page-{f}-{p}') for p in range(10)]))
        return dict(schema='mixed-pdf-manifest@4', stage='full' if split else 'prototypes',
                    handoffHash='b' * 64, counts=dict(families=2, pdfs=12, pages=120), cases=cases), dict(dataset=dict(family_plan=plan))

    def test_exact_stage_membership_and_paths(self):
        manifest, spec = self.manifest()
        validate_inventory(manifest, spec)
        for kind in ['omit-family', 'duplicate', 'wrong-split', 'traversal', 'wrong-class', 'duplicate-path']:
            changed = copy.deepcopy(manifest)
            if kind == 'omit-family':
                changed['cases'] = changed['cases'][:6]; changed['counts'] = dict(families=1, pdfs=6, pages=60)
            elif kind == 'duplicate': changed['cases'][1]['id'] = changed['cases'][0]['id']
            elif kind == 'wrong-split': changed['cases'][0]['split'] = 'heldout'
            elif kind == 'traversal': changed['cases'][0]['labels'] = '../other.json'
            elif kind == 'duplicate-path': changed['cases'][1]['pdf'] = changed['cases'][0]['pdf']
            else: changed['cases'][0]['classId'] = 'E2'
            with self.assertRaises(ValueError): validate_inventory(changed, spec)

    def test_cross_split_identities_precede_any_artifact_access(self):
        manifest, spec = self.manifest(split=True)
        validate_inventory(manifest, spec)
        for field in ['sha256', 'sourceLayoutHash', 'authoringHash', 'worldHash', 'pageContentHashes']:
            changed = copy.deepcopy(manifest)
            for case in changed['cases'][6:]:
                value = changed['cases'][0][field]
                case[field] = list(reversed(value)) if field == 'pageContentHashes' else value
            with self.assertRaisesRegex(ValueError, 'cross-split'): validate_inventory(changed, spec)
        changed = copy.deepcopy(manifest); del changed['cases'][0]['pageContentHashes']
        with self.assertRaisesRegex(ValueError, 'predeclared'): validate_inventory(changed, spec)
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp); (root/'handoff').mkdir()
            path = root/'handoff/spec-a4.json'; path.write_text(json.dumps(spec))
            manifest['specHash'] = file_hash(path)
            manifest['cases'][6]['sha256'] = manifest['cases'][0]['sha256']
            (root/'manifest.json').write_text(json.dumps(freeze(manifest, 'manifestHash')))
            with self.assertRaisesRegex(ValueError, 'cross-split'):
                seal(root, root/'view', root/'nonexistent-approval.json')
            self.assertFalse((root/'view').exists())

    def save(self, path, value, own=None):
        if own: freeze(value, own)
        path.write_text(json.dumps(value))
        return dict(path=str(path), sha256=file_hash(path))

    def approval(self, root, manifest):
        candidate = root/'candidate'; snapshot = root/'snapshot'; snapshot.mkdir()
        files = {}
        for name in ['fools_gold_v4_check.py', 'fools_gold_v4_semantic.py', 'fools_gold_v4_common.py']:
            (snapshot/name).write_text('# invented validator fixture\n' + name)
            files[name] = file_hash(snapshot/name)
        code = {k:v for k,v in files.items() if k != 'fools_gold_v4_common.py'}
        deps = {'fools_gold_v4_common.py': files['fools_gold_v4_common.py']}
        index = dict(schema='mixed-pdf-validator-snapshot@1', files=files,
                     validatorCodeSha256=code, dependencySha256=deps)
        self.save(snapshot/'snapshot-hashes.json', index, 'snapshotHash')
        result = dict(passed=True, misses=[], checkedPages=10)
        checked = [dict(id=c['id'], schemaPassed=True, result=copy.deepcopy(result),
                       authoringHash=c['authoringHash'], worldHash=c['worldHash'],
                       pdfSha256=c['sha256'], labelSha256=c['labelHash']) for c in manifest['cases']]
        family = [dict(familyId=c['familyId'], schemaPassed=True, result=copy.deepcopy(result),
                       authoringHash=c['authoringHash'], worldHash=c['worldHash'],
                       sourceLayoutByteSha256=c['sourceLayoutHash']) for c in [manifest['cases'][0], manifest['cases'][6]]]
        semantic = dict(schema='mixed-pdf-semantic-revalidation@1', candidate=str(candidate),
            corpusManifestSha256='a'*64, handoffHash=manifest['handoffHash'], validatorCodeSha256=code,
            validatorDependencySha256=deps, validationSnapshot=str(snapshot),
            snapshotHashesSha256=file_hash(snapshot/'snapshot-hashes.json'), passed=True, misses=[],
            originalCorpusUnchanged=True, cleanInputsUnchanged=True, validatorCodeUnchangedDuringRun=True,
            tests=dict(exitCode=0), checkedCases=checked, checkedFamilies=family,
            counts=dict(families=2, authoringPages=20, labelPages=120, pdfsHashed=12))
        semantic_entry = self.save(root/'semantic.json', semantic, 'receiptHash')
        identity = validator_identity(semantic)
        approval = dict(schema='mixed-pdf-evaluation-approval@2', coordinatorApproval=True,
            stage='prototypes', candidate=str(candidate), datasetManifestSha256='a'*64,
            handoffHash=manifest['handoffHash'], reviewScope='corpus',
            semanticValidatorIdentityHash=identity, semanticValidation=semantic_entry)
        for stage, key in [('audit', 'auditDecision'), ('judge', 'judgeDecision')]:
            decision = {'pass':True, 'decision':'pass', 'score':100, 'stage':stage,
                        'counts':dict(fatal=0, high=0, medium=0, low=0)}
            report = dict(candidate=str(candidate), misses=[], corpusBinding=dict(corpusManifestSha256='a'*64,
                semanticReceiptSha256=semantic_entry['sha256'], validatorIdentityHash=identity))
            bound = dict(**decision, schema='mixed-pdf-bound-review@1', candidate=str(candidate),
                corpusManifestSha256='a'*64, handoffHash=manifest['handoffHash'], semanticValidation=semantic_entry,
                reviewReport=self.save(root/f'{stage}-report.json', report),
                scoreDecision=self.save(root/f'{stage}-score.json', decision))
            approval[key] = self.save(root/f'{stage}-bound.json', bound, 'bindingHash')
        return approval

    def test_corpus_and_validator_bound_approval(self):
        manifest, _ = self.manifest()
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp); approval = self.approval(root, manifest)
            validate_approval(approval, manifest, 'a'*64)
            for kind in ['wrong-corpus', 'audit-as-judge', 'changed-file', 'wrong-review-corpus']:
                changed = copy.deepcopy(approval)
                if kind == 'wrong-corpus': changed['datasetManifestSha256'] = 'other'
                elif kind == 'audit-as-judge': changed['judgeDecision'] = changed['auditDecision']
                elif kind == 'changed-file': changed['auditDecision']['sha256'] = 'other'
                else:
                    bound = json.loads(Path(changed['auditDecision']['path']).read_text())
                    bound['corpusManifestSha256'] = 'other'
                    changed['auditDecision'] = self.save(root/'other-bound.json', bound, 'bindingHash')
                with self.assertRaises(ValueError): validate_approval(changed, manifest, 'a'*64)

    def test_semantic_summary_cannot_hide_case_failure_or_stale_code(self):
        manifest, _ = self.manifest()
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp); approval = self.approval(root, manifest)
            original = json.loads(Path(approval['semanticValidation']['path']).read_text())
            for kind in ['schema', 'validator', 'case-failed', 'wrong-label', 'family-failed']:
                semantic = copy.deepcopy(original); changed = copy.deepcopy(approval)
                if kind == 'schema': semantic.pop('schema')
                elif kind == 'validator': semantic['validatorCodeSha256']['fools_gold_v4_semantic.py'] = '0'*64
                elif kind == 'case-failed': semantic['checkedCases'][0]['result']['passed'] = False
                elif kind == 'wrong-label': semantic['checkedCases'][0]['labelSha256'] = '0'*64
                else: semantic['checkedFamilies'][0]['result']['passed'] = False
                changed['semanticValidation'] = self.save(root/'changed-semantic.json', semantic, 'receiptHash')
                with self.assertRaises(ValueError): validate_approval(changed, manifest, 'a'*64)
            (root/'snapshot/fools_gold_v4_common.py').write_text('# changed dependency')
            with self.assertRaisesRegex(ValueError, 'stale-validator'): validate_approval(approval, manifest, 'a'*64)


if __name__ == '__main__':
    unittest.main()
