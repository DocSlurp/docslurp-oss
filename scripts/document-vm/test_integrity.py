"""Synthetic archive/converter/control fixtures; no Docker or network required."""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from inspect_oci import inspect_archive, INDEX, MANIFEST, ATTESTATION
from container_case import run_container
spec = importlib.util.spec_from_file_location('export_pp_small', Path(__file__).parents[1] / 'layout-eval/export_pp_small.py')
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


def archive_fixture(root, change=None):
    blobs = {}
    def descriptor(data, media, **extra):
        if not isinstance(data, bytes): data = json.dumps(data, sort_keys=True).encode()
        digest = 'sha256:' + hashlib.sha256(data).hexdigest()
        blobs['blobs/sha256/' + digest.split(':')[1]] = data
        return {'digest': digest, 'size': len(data), 'mediaType': media, **extra}
    raw = b'synthetic rootfs layer'
    diff = 'sha256:' + hashlib.sha256(raw).hexdigest()
    config = {'os': 'linux', 'architecture': 'amd64', 'rootfs': {'type': 'layers', 'diff_ids': [diff]},
              'config': {'Cmd': ['python3'], 'WorkingDir': '/job'}}
    local = [{'Os': 'linux', 'Architecture': 'amd64', 'Id': 'sha256:' + 'f' * 64,
              'RootFS': {'Type': 'layers', 'Layers': [diff]}, 'Config': copy.deepcopy(config['config'])}]
    if change == 'runtime': config['config']['Cmd'] = ['unexpected']
    if change == 'rootfs': local[0]['RootFS']['Layers'] = ['sha256:' + 'e' * 64]
    payload = raw if change != 'layer-bytes' else b'changed rootfs'
    image = descriptor({'schemaVersion': 2, 'mediaType': MANIFEST,
        'config': descriptor(config, 'application/vnd.oci.image.config.v1+json'),
        'layers': [descriptor(gzip.compress(payload), 'application/vnd.oci.image.layer.v1.tar+gzip')]}, MANIFEST,
        platform={'os': 'linux', 'architecture': 'amd64'})
    if change == 'descriptor-platform': image['platform']['architecture'] = 'arm64'
    layers = []
    for kind, predicate in [('sbom', 'https://spdx.dev/Document'), ('provenance', 'https://slsa.dev/provenance/v1')]:
        if change == 'missing-' + kind: continue
        subjects = [] if change != 'explicit-subject' else [{'name': '_', 'digest': {'sha256': image['digest'].split(':')[1]}}]
        if change == 'wrong-statement-subject': subjects = [{'name': '_', 'digest': {'sha256': '0' * 64}}]
        statement = {'_type': 'https://in-toto.io/Statement/v1', 'predicateType': predicate, 'subject': subjects,
                     'predicate': {'SPDXID': 'SPDXRef-DOCUMENT', 'spdxVersion': 'SPDX-2.3'} if kind == 'sbom' else {'buildDefinition': {}, 'runDetails': {}}}
        if change == 'unknown-predicate' and kind == 'sbom': statement['predicateType'] = 'https://invalid/predicate'
        annotation = statement['predicateType'] if change != 'annotation-type' else 'https://wrong/type'
        layer = descriptor(statement, 'application/vnd.in-toto+json', annotations={'in-toto.io/predicate-type': annotation})
        layers.append(layer)
        if change == 'duplicate-' + kind: layers.append(layer)
    subject = {key: image[key] for key in ('mediaType', 'digest', 'size')}
    if change == 'wrong-oci-subject': subject['digest'] = 'sha256:' + '0' * 64
    att = {'schemaVersion': 2, 'mediaType': MANIFEST, 'artifactType': ATTESTATION,
           'config': descriptor({}, 'application/vnd.oci.empty.v1+json'), 'layers': layers, 'subject': subject}
    if change == 'missing-oci-subject': del att['subject']
    if change == 'legacy-empty': del att['subject']; del att['artifactType']
    reference = image['digest'] if change != 'wrong-index-reference' else 'sha256:' + '0' * 64
    att_descriptor = descriptor(att, MANIFEST, platform={'os': 'unknown', 'architecture': 'unknown'},
        annotations={'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': reference})
    manifests = [image, att_descriptor]
    if change == 'no-attestations': manifests = [image]
    root_descriptor = descriptor({'schemaVersion': 2, 'mediaType': INDEX, 'manifests': manifests}, INDEX)
    metadata = {'containerimage.digest': root_descriptor['digest'], 'containerimage.descriptor': root_descriptor}
    if change == 'metadata': metadata['containerimage.digest'] = 'sha256:' + '0' * 64
    blobs['index.json'] = json.dumps({'schemaVersion': 2, 'mediaType': INDEX, 'manifests': [root_descriptor]}).encode()
    path = root / 'image.tar'
    with tarfile.open(path, 'w') as tar:
        for name, data in blobs.items():
            info = tarfile.TarInfo(name); info.size = len(data); tar.addfile(info, io.BytesIO(data))
    return path, metadata, local


class ArchiveIntegrity(unittest.TestCase):
    def test_valid_bound_artifacts_and_explicit_subject(self):
        for change in [None, 'explicit-subject']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); archive, metadata, local = archive_fixture(root, change)
                record = inspect_archive(archive, root / 'result', metadata, local)
                self.assertEqual(len(record['attestationBindings']), 2)
                self.assertTrue(record['testedImageEquality']['layerDiffIdsVerified'])

    def test_missing_duplicate_misbound_and_different_image_fail_closed(self):
        changes = ['no-attestations', 'missing-sbom', 'missing-provenance', 'duplicate-sbom', 'duplicate-provenance',
                   'wrong-index-reference', 'wrong-oci-subject', 'wrong-statement-subject', 'missing-oci-subject',
                   'legacy-empty', 'unknown-predicate', 'annotation-type', 'metadata', 'rootfs', 'runtime', 'layer-bytes', 'descriptor-platform']
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); archive, metadata, local = archive_fixture(root, change)
                with self.assertRaises(ValueError): inspect_archive(archive, root / 'result', metadata, local)
                self.assertFalse((root / 'result').exists())


class ConverterAdmission(unittest.TestCase):
    def test_tampered_or_unapproved_source_never_starts_converter(self):
        for mutation in ['bytes', 'extra', 'symlink', 'revision', 'downloaded-bytes']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); source = root / 'source'; source.mkdir()
                data = {'inference.json': b'synthetic model', 'inference.pdiparams': b'synthetic weights'}
                for name, value in data.items(): (source / name).write_bytes(value)
                lock = {'source': 'PaddlePaddle/PP-DocLayout-S', 'source_revision': 'a' * 40,
                        'source_files_sha256': {k: hashlib.sha256(v).hexdigest() for k, v in data.items()}, 'graph_sha256': 'b' * 64}
                if mutation == 'bytes': (source / 'inference.json').write_bytes(b'tampered')
                if mutation == 'extra': (source / 'undeclared').write_bytes(b'x')
                if mutation == 'symlink': (source / 'inference.json').unlink(); (source / 'inference.json').symlink_to(source / 'inference.pdiparams')
                if mutation == 'revision': lock['source_revision'] = 'c' * 40
                lockfile = root / 'lock.json'; lockfile.write_text(json.dumps(lock))
                argv = ['export', '--model-dir', str(source), '--output', str(root / 'model.onnx'), '--revision', 'a' * 40]
                if mutation == 'downloaded-bytes': argv.append('--download')
                hub = SimpleNamespace(HfApi=lambda: SimpleNamespace(model_info=lambda *a, **k: SimpleNamespace(sha='a' * 40)),
                    snapshot_download=lambda *a, **k: (source / 'inference.json').write_bytes(b'tampered download'))
                with patch.dict(sys.modules, {'huggingface_hub': hub}), patch.object(export, 'SOURCE_LOCK', lockfile), patch.object(sys, 'argv', argv), patch.object(export.subprocess, 'run') as converter:
                    with self.assertRaises(ValueError): export.main()
                    converter.assert_not_called()

    def test_post_export_graph_lock_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'source'; source.mkdir(); output = root / 'model.onnx'
            for name in ['inference.json', 'inference.pdiparams']: (source / name).write_bytes(b'approved')
            lock = {'source': 'PaddlePaddle/PP-DocLayout-S', 'source_revision': 'a' * 40,
                    'source_files_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}, 'graph_sha256': 'b' * 64}
            lockfile = root / 'lock.json'; lockfile.write_text(json.dumps(lock))
            argv = ['export', '--model-dir', str(source), '--output', str(output), '--revision', 'a' * 40]
            with patch.object(export, 'SOURCE_LOCK', lockfile), patch.object(sys, 'argv', argv), patch.object(export.subprocess, 'run', side_effect=lambda *a, **k: output.write_bytes(b'wrong graph')) as converter:
                with self.assertRaisesRegex(ValueError, 'graph differs'): export.main()
                converter.assert_called_once()
                self.assertFalse(output.with_suffix('.provenance.json').exists())


class ContainerCleanup(unittest.TestCase):
    def test_cleanup_failure_is_loud_and_success_names_are_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / 'docker'
            docker.write_text("#!/usr/bin/env python3\nimport sys\nif sys.argv[1]=='rm':\n print('daemon unavailable',file=sys.stderr);sys.exit(1)\n")
            docker.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, 'cleanup was not confirmed'):
                run_container([str(docker), 'run', '--rm', 'image'], ['ok'])
            docker.write_text('#!/usr/bin/env python3\n')
            _, first = run_container([str(docker), 'run', '--rm', 'image'], ['ok'])
            _, second = run_container([str(docker), 'run', '--rm', 'image'], ['ok'])
            self.assertNotEqual(first, second)

    def test_native_hang_timeout_removes_daemon_container_by_unique_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); docker = root / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import sys,time
from pathlib import Path
root=Path(__file__).parent
if sys.argv[1]=='run':
 name=sys.argv[sys.argv.index('--name')+1]
 (root/(name+'.alive')).write_text('daemon running')
 (root/'events').write_text(name)
 time.sleep(60)
elif sys.argv[1]=='rm':
 name=sys.argv[-1]
 (root/(name+'.alive')).unlink(missing_ok=True)
 with (root/'events').open('a') as f:f.write('\\nremoved:'+name)
'''); docker.chmod(0o755)
            with self.assertRaises(subprocess.TimeoutExpired): run_container([str(docker), 'run', '--rm', 'image'], ['native-hang'], timeout=.4)
            events = (root / 'events').read_text().splitlines()
            self.assertTrue(events[0].startswith('docslurp-image-case-'))
            self.assertEqual(events[1], 'removed:' + events[0])
            self.assertEqual(list(root.glob('*.alive')), [])


if __name__ == '__main__': unittest.main()
