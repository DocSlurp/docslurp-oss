import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/sign-document-vm.yml', import.meta.url), 'utf8');
const block = workflow.match(/          python3 - <<'PY'\n([\s\S]*?)          PY\n/)?.[1];
assert.ok(block, 'test the exact verifier shipped inline without checking out code in the signing job');
const verifier = block.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');

test('signing is manual, main-only, public-only, fixed-digest and separate from build provenance', () => {
  assert.equal(workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1], '  workflow_dispatch:\n');
  assert.match(workflow, /github\.repository == 'DocSlurp\/docslurp-oss'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event\.repository\.private == false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04\n    timeout-minutes: 6/);
  assert.match(workflow, /permissions: \{\}/);
  assert.equal(workflow.match(/^    permissions:\n([\s\S]*?)^    env:/m)?.[1], '      contents: read\n      packages: write\n      id-token: write\n');
  assert.match(workflow, /IMAGE: ghcr\.io\/docslurp\/worker-document-vm\n/);
  assert.match(workflow, /IMAGE_DIGEST: sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21/);
  assert.match(workflow, /INDEX_DIGEST: sha256:fbbdd7f307ff8ccf49c3fd74e7fc448b5c4eda8878bfb1accf0920669b39b3ee/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|attest-build-provenance)|docker\/(?:build-push-action|setup-buildx-action)|workflow_call|continue-on-error|upload-artifact|inputs\./);
  const uses = [...workflow.matchAll(/- uses: ([^\n]+)/g)].map(match => match[1]);
  assert.equal(uses.length, 2);
  for (const use of uses) assert.match(use, /^(?:sigstore\/cosign-installer|docker\/login-action)@[a-f0-9]{40} # /);
  assert.ok(workflow.indexOf('name: Verify remote reviewed BuildKit evidence') < workflow.indexOf('name: Sign the existing reviewed image digest'));
  assert.match(workflow, /cosign-release: v3\.0\.6/);
  assert.match(workflow, /timeout 90s cosign sign --yes "\$\{IMAGE\}@\$\{IMAGE_DIGEST\}"/);
  assert.match(workflow, /IDENTITY: https:\/\/github\.com\/DocSlurp\/docslurp-oss\/\.github\/workflows\/sign-document-vm\.yml@refs\/heads\/main/);
  assert.match(workflow, /--certificate-identity "\$\{IDENTITY\}"/);
  assert.match(workflow, /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  assert.doesNotMatch(workflow, /--certificate-identity-regexp|--insecure|--insecure-ignore/);
});

test('shipped verifier rejects tampering and cross-image attestation bindings without network', () => {
  const tests = `
import copy
import unittest
from unittest.mock import patch

def evidence():
    values = {
      INDEX: {'schemaVersion': 2, 'mediaType': INDEX_TYPE, 'manifests': [
        {'digest': IMAGE, 'size': 2771, 'mediaType': MANIFEST_TYPE, 'platform': {'architecture': 'amd64', 'os': 'linux'}},
        {'digest': ATTESTATION, 'size': 1112, 'mediaType': MANIFEST_TYPE, 'platform': {'architecture': 'unknown', 'os': 'unknown'},
         'annotations': {'vnd.docker.reference.digest': IMAGE, 'vnd.docker.reference.type': 'attestation-manifest'}}]},
      IMAGE: {'schemaVersion': 2, 'mediaType': MANIFEST_TYPE, 'config': {'digest': 'sha256:8f703218281562eac36ba0cd6af513daf9f2f0728bb357424734aba477b1697f'}},
      ATTESTATION: {'schemaVersion': 2, 'mediaType': MANIFEST_TYPE, 'artifactType': 'application/vnd.docker.attestation.manifest.v1+json',
        'subject': {'mediaType': MANIFEST_TYPE, 'digest': IMAGE, 'size': 2771}, 'layers': []},
    }
    for digest, size, predicate in LAYERS:
        values[ATTESTATION]['layers'].append({'digest': digest, 'size': size, 'mediaType': 'application/vnd.in-toto+json', 'annotations': {'in-toto.io/predicate-type': predicate}})
        values[digest] = {'_type': 'https://in-toto.io/Statement/v1', 'predicateType': predicate, 'subject': [],
          'predicate': {'spdxVersion': 'SPDX-2.3'} if predicate == 'https://spdx.dev/Document' else
            {'buildDefinition': {'buildType': 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md'}}}
    return values

class BindingTests(unittest.TestCase):
    def test_reviewed_shape(self):
        values = evidence()
        seen = []
        def get(kind, digest, size):
            seen.append((kind,digest,size))
            return values[digest]
        verify(get)
        self.assertEqual(len(seen), 5)
        self.assertEqual([entry[0] for entry in seen], ['manifests']*3 + ['blobs']*2)

    def test_wrong_bindings(self):
        mutations = [
          lambda v: v[INDEX]['manifests'][0].update(digest='sha256:'+'0'*64),
          lambda v: v[INDEX]['manifests'][1]['annotations'].update({'vnd.docker.reference.digest': 'sha256:'+'0'*64}),
          lambda v: v[INDEX]['manifests'].append(v[INDEX]['manifests'][0]),
          lambda v: v[ATTESTATION]['subject'].update(digest='sha256:'+'0'*64),
          lambda v: v[ATTESTATION]['layers'][0].update(digest='sha256:'+'0'*64),
          lambda v: v[ATTESTATION]['layers'].pop(),
          lambda v: v[LAYERS[0][0]].update(subject=[{'name': 'foreign'}]),
          lambda v: v[LAYERS[1][0]].update(predicateType='foreign'),
          lambda v: v[LAYERS[1][0]]['predicate']['buildDefinition'].update(buildType='GitHub Actions'),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                values = evidence()
                mutate(values)
                with self.assertRaises(ValueError): verify(lambda kind,digest,size: values[digest])

    def test_digest_and_size_are_checked_before_json(self):
        raw=b'{"reviewed":true}'
        digest='sha256:'+hashlib.sha256(raw).hexdigest()
        self.assertEqual(verified_json(raw,digest,len(raw)), {'reviewed': True})
        with self.assertRaises(ValueError): verified_json(raw+b' ',digest,len(raw)+1)
        with self.assertRaises(ValueError): verified_json(raw,digest,len(raw)+1)

    def test_blob_redirect_drops_authorization(self):
        class Response:
            headers={}
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,limit): return b'{}'
        class Opener:
            calls=[]
            def open(self,request,timeout):
                self.calls.append(request)
                if len(self.calls)==1:
                    raise urllib.error.HTTPError(request.full_url,307,'redirect',{'Location': 'https://pkg-containers.githubusercontent.com/blob?signed=secret'},None)
                return Response()
        opener=Opener()
        with patch.object(urllib.request,'build_opener',return_value=opener):
            self.assertEqual(read_url('https://ghcr.io/v2/fixed/blobs/fixed',{'Authorization':'Bearer private'},10,True), b'{}')
        self.assertEqual(opener.calls[0].get_header('Authorization'),'Bearer private')
        self.assertIsNone(opener.calls[1].get_header('Authorization'))

    def test_redirect_refuses_foreign_hosts_and_oversized_responses(self):
        class Opener:
            def open(self,request,timeout):
                raise urllib.error.HTTPError(request.full_url,307,'redirect',{'Location':'https://attacker.invalid/blob'},None)
        with patch.object(urllib.request,'build_opener',return_value=Opener()):
            with self.assertRaises(ValueError): read_url('https://ghcr.io/blob',{'Authorization':'private'},10,True)
        class Response:
            headers={}
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,limit): return b'x'*limit
        with patch.object(urllib.request,'build_opener',return_value=type('Opener',(),{'open': lambda *args, **kwargs: Response()})()):
            with self.assertRaises(ValueError): read_url('https://ghcr.io/blob',{},10)

unittest.main(argv=['workflow-contract'], exit=False)
`;
  const run = spawnSync('python3', ['-I', '-c', `__name__ = 'workflow_contract'\n${verifier}\n${tests}`], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /Ran 5 tests/);
  assert.match(run.stderr, /\nOK\n/);
});
