#!/usr/bin/env python3
"""Verify OCI blob identities and retain manifests, provenance and SPDX SBOM.

Registry image pins use imageManifestDigest, not the config/Docker image ID or
the digest of this archive. No registry interaction is performed here.
"""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

archive, output = Path(sys.argv[1]), Path(sys.argv[2])
with tarfile.open(archive) as tar:
    def read(name):
        return tar.extractfile(name).read()

    index = json.loads(read('index.json'))
    verified = []

    def blob(descriptor):
        digest = descriptor['digest']
        if not digest.startswith('sha256:'): raise ValueError('Unsupported digest')
        data = read('blobs/sha256/' + digest.split(':')[1])
        if len(data) != descriptor['size'] or 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('OCI blob identity mismatch')
        verified.append(digest)
        return data

    images, attestations = [], []
    def walk(descriptor):
        data = blob(descriptor)
        manifest = json.loads(data)
        if 'manifests' in manifest:
            for child in manifest['manifests']: walk(child)
            return
        config = json.loads(blob(manifest['config']))
        layers = []
        for layer in manifest['layers']:
            layer_data = blob(layer)
            if layer['mediaType'] == 'application/vnd.in-toto+json':
                statement = json.loads(layer_data)
                kind = 'sbom' if 'spdx' in statement.get('predicateType', '').lower() else 'provenance'
                (output / (kind + '.json')).write_text(json.dumps(statement, indent=2) + '\n')
            layers.append({'digest': layer['digest'], 'bytes': layer['size']})
        row = {'digest': descriptor['digest'], 'configDigest': manifest['config']['digest'], 'layers': layers}
        if config.get('os') == 'linux': images.append(row)
        else: attestations.append(row)
    for descriptor in index['manifests']: walk(descriptor)
    if len(images) != 1: raise ValueError('Expected exactly one Linux image')
    (output / 'oci-index.json').write_text(json.dumps(index, indent=2) + '\n')
    # Stream archive hashing; the uncompressed archive can be large.
    digest = hashlib.sha256()
    with archive.open('rb') as handle:
        while chunk := handle.read(1024 * 1024): digest.update(chunk)
    (output / 'oci-record.json').write_text(json.dumps({'archivePath': str(archive.resolve()), 'archiveBytes': archive.stat().st_size,
        'archiveSha256': digest.hexdigest(), 'imageManifestDigest': images[0]['digest'], 'image': images[0],
        'attestations': attestations, 'verifiedBlobCount': len(verified)}, indent=2) + '\n')
