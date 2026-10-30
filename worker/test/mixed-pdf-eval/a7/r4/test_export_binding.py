"""Content-free constructed bytes and mock callbacks only; not fixtures/acceptance.
Evidence is retained under this proposal, including deliberately failing cases.
"""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from export_binding import bind_export, identity, verify_receipt

ROOT = Path(__file__).resolve().parent
EVIDENCE = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4/mechanism-setup/test-evidence')
EVIDENCE.mkdir(parents=True,exist_ok=True)

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix=self._testMethodName+'-', dir=EVIDENCE))
        self.plan = self.root/'control.json'
        self.plan.write_text(json.dumps({'stem': 'fake', 'objects': []}))
        self.tool = self.root/'mock-tool'
        self.tool.write_bytes(b'constructed mock tool, never executed')
        self.tools = {'mock': self.tool}
        self.execution = {'executionId': 'mock-only-'+self.root.name}
        self.state = {'pageCount': 1, 'objects': [], 'tables': []}
        self.calls = []
        self.original = object()
        self.reloaded = object()
        def save(doc, path):
            self.assertIs(doc, self.original)
            self.calls.append('save')
            path.write_bytes(b'not an ODT: constructed mocked save')
        def close(doc):
            self.calls.append('close-original' if doc is self.original else 'close-reloaded')
        def reopen(path):
            self.assertEqual(self.calls[-2:], ['save', 'close-original'])
            self.assertEqual(path, self.root/'fake.odt')
            self.calls.append('reopen')
            return self.reloaded
        def export(doc, path):
            self.assertIs(doc, self.reloaded)
            self.calls.append('export-reloaded')
            path.write_bytes(b'%PDF-FAKE mock output; not a valid PDF')
        self.callbacks = dict(build=lambda plan: self.original, save=save, close=close,
                              reopen=reopen, readback=lambda doc, plan: copy.deepcopy(self.state), export_pdf=export)
    def run_bound(self):
        return bind_export(self.plan, self.root, self.tools, self.execution, **self.callbacks)
    def failed(self, text):
        with self.assertRaisesRegex((RuntimeError, FileNotFoundError), text):
            self.run_bound()
        record = json.loads((self.root/'fake.artifact-receipt.json').read_text())
        self.assertEqual(record['status'], 'failed')
        self.assertIn('error', record)
        return record
    def test_success_and_outer_check(self):
        record_path = self.run_bound()
        checked = verify_receipt(record_path, self.plan, self.execution['executionId'], {'mock': identity(self.tool)})
        self.assertEqual(checked['receipt']['status'], 'bound')
        self.assertEqual(self.calls, ['save', 'close-original', 'reopen', 'export-reloaded', 'close-reloaded'])
        phases = [e['phase'] for e in checked['receipt']['events']]
        self.assertLess(phases.index('odt-hashed-before-reload'), phases.index('reopened-exact-saved-path'))
    def test_replaced_odt_during_reopen(self):
        def reopen(path):
            other = path.with_suffix('.replacement')
            other.write_bytes(path.read_bytes())
            other.replace(path)
            return self.reloaded
        self.callbacks['reopen'] = reopen
        self.failed('replaced or changed')
        self.assertTrue((self.root/'fake.odt').exists())
        self.assertNotIn('export-reloaded', self.calls)
    def test_changed_odt_during_export(self):
        def export(doc, path):
            path.write_bytes(b'%PDF-FAKE')
            (self.root/'fake.odt').write_bytes(b'changed by mocked exporter')
        self.callbacks['export_pdf'] = export
        self.failed('replaced or changed')
        self.assertTrue((self.root/'fake.pdf').exists())
    def test_missing_pdf(self):
        self.callbacks['export_pdf'] = lambda doc, path: None
        self.failed('No such file')
        self.assertTrue((self.root/'fake.odt').exists())
    def test_empty_pdf(self):
        self.callbacks['export_pdf'] = lambda doc, path: path.write_bytes(b'')
        self.failed('empty')
    def test_invalid_pdf_header(self):
        self.callbacks['export_pdf'] = lambda doc, path: path.write_bytes(b'not pdf')
        self.failed('PDF header')
    def test_plan_changed_by_export(self):
        def export(doc, path):
            path.write_bytes(b'%PDF-FAKE')
            self.plan.write_text('{"changed": true}')
        self.callbacks['export_pdf'] = export
        self.failed('replaced or changed')
    def test_tool_changed_by_export(self):
        def export(doc, path):
            path.write_bytes(b'%PDF-FAKE')
            self.tool.write_bytes(b'changed tool')
        self.callbacks['export_pdf'] = export
        self.failed('replaced or changed')
    def test_reloaded_state_changed(self):
        def reopen(path):
            self.state['pageCount'] = 2
            return self.reloaded
        self.callbacks['reopen'] = reopen
        self.failed('page count')
        self.assertNotIn('export-reloaded', self.calls)
    def test_close_before_hash_is_required(self):
        self.callbacks['close'] = lambda doc: (_ for _ in ()).throw(RuntimeError('close failed'))
        record = self.failed('close failed')
        self.assertNotIn('odtBeforeReload', record)
    def test_outer_rejects_missing_output(self):
        path = self.run_bound()
        (self.root/'fake.pdf').unlink()
        with self.assertRaises(FileNotFoundError):
            verify_receipt(path, self.plan, self.execution['executionId'], {'mock': identity(self.tool)})
    def test_outer_rejects_wrong_execution(self):
        path = self.run_bound()
        with self.assertRaisesRegex(RuntimeError, 'Wrong execution'):
            verify_receipt(path, self.plan, 'different', {'mock': identity(self.tool)})
    def test_outer_rejects_retrospective_record(self):
        path = self.root/'old.json'
        path.write_text(json.dumps({'schema': 'old-round2', 'status': 'exported'}))
        with self.assertRaisesRegex(RuntimeError, 'prospective'):
            verify_receipt(path, self.plan, self.execution['executionId'], {'mock': identity(self.tool)})
    def test_existing_output_untouched(self):
        pdf = self.root/'fake.pdf'; pdf.write_bytes(b'preserve old bytes')
        with self.assertRaisesRegex(RuntimeError, 'existing artifact'):
            self.run_bound()
        self.assertEqual(pdf.read_bytes(), b'preserve old bytes')

class NativeTableTests(unittest.TestCase):
    def setUp(self):
        from export_binding import validate_plan_state
        self.check = validate_plan_state
        obj = {'kind': 'table', 'id': 'mock.table', 'data': [['', '', '']], 'span': True, 'paddingPt': 4}
        self.plan = {'objects': [obj]}
        pad = round(4*2540/72)
        self.table = {'identity': 'mock_table_native', 'rows': 1, 'cellNames': ['A1', 'B1'],
                      'cells': {'A1': '', 'B1': ''}, 'properties': {}, 'parent': {'bodyMembership': True},
                      'cellProperties': {name: {'paragraph': {'ParaAdjust': adjust},
                                               'cell': {'LeftBorderDistance': pad, 'RightBorderDistance': pad}}
                                         for name, adjust in [('A1', 0), ('B1', 3)]}}
        self.state = {'pageCount': 1, 'objects': [], 'tables': [self.table]}
    def test_native_span_alignment_padding(self):
        self.check(self.state, self.plan)
    def test_reject_alignment_change(self):
        self.table['cellProperties']['B1']['paragraph']['ParaAdjust'] = 0
        with self.assertRaisesRegex(RuntimeError, 'alignment'):
            self.check(self.state, self.plan)
    def test_reject_padding_change(self):
        self.table['cellProperties']['A1']['cell']['LeftBorderDistance'] = 0
        with self.assertRaisesRegex(RuntimeError, 'padding'):
            self.check(self.state, self.plan)
    def test_reject_missing_span(self):
        self.table['cells']['C1'] = ''
        with self.assertRaisesRegex(RuntimeError, 'span'):
            self.check(self.state, self.plan)
    def test_reject_pipe_cell(self):
        self.table['cells']['A1'] = '|'
        with self.assertRaisesRegex(RuntimeError, 'Pipe'):
            self.check(self.state, self.plan)
    def test_reject_unavailable_property(self):
        self.table['properties']['Width'] = {'unavailable': 'mock'}
        with self.assertRaisesRegex(RuntimeError, 'Unavailable'):
            self.check(self.state, self.plan)

class OuterTests(unittest.TestCase):
    setUp = BindingTests.setUp
    # Reuse bounded mock callbacks; no UNO or converter process.
    def outer(self, produce):
        import writer_export_wrapper as export_round2
        from unittest.mock import patch
        from types import SimpleNamespace
        import hashlib
        freeze = self.root/'FREEZE.json'
        freeze.write_text(json.dumps({'files': {self.plan.name: hashlib.sha256(self.plan.read_bytes()).hexdigest()}}))
        def runner(command, **kwargs):
            if '-c' in command:
                return SimpleNamespace(stdout=json.dumps({'uno': str(self.tool), 'pyuno': str(self.tool)}), returncode=0)
            if produce:
                context = json.loads((self.root/'fake.writer-launch.json').read_bytes())
                tools = {role: item['path'] for role, item in context['tools'].items()}
                tools['context'] = str(self.root/'fake.writer-launch.json')
                bind_export(self.plan, self.root, tools, context, **self.callbacks)
            return SimpleNamespace(stdout='', stderr='', returncode=0)
        converter = {'pid': 999999, 'startTicks': 'mock', 'executable': str(self.tool), 'argv': ['mock']}
        with patch.object(export_round2, 'converter_state', return_value=converter):
            return export_round2.export_writer(self.plan, self.root, freeze, 'mock-pipe', 999999, runner=runner)
    def test_outer_success_contains_checked_receipt(self):
        record = self.outer(True)
        self.assertEqual(record['status'], 'exported-with-checked-binding')
        self.assertEqual(record['checkedArtifactReceipt']['receipt']['status'], 'bound')
    def test_outer_zero_exit_without_receipt_fails(self):
        with self.assertRaises(FileNotFoundError):
            self.outer(False)
        record = json.loads((self.root/'fake.execution.json').read_bytes())
        self.assertEqual(record['status'], 'failed')
        self.assertNotIn('checkedArtifactReceipt', record)

if __name__ == '__main__':
    unittest.main(verbosity=2)
