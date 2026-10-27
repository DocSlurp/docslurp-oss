#!/usr/bin/env python3
"""Verify OCI identities, required attestation binding and tested rootfs/config."""
import argparse
import hashlib
import gzip
import io
import json
from pathlib import Path
import re
import tarfile

INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
ATTESTATION = 'application/vnd.docker.attestation.manifest.v1+json'
PREDICATES = {'https://spdx.dev/Document': 'sbom', 'https://slsa.dev/provenance/v1': 'provenance'}


def inspect_archive(archive, output, metadata, local_image):
    archive, output = Path(archive), Path(output)
    verified, images, attestations = [], [], []
    with tarfile.open(archive) as tar:
        names = tar.getnames()
        if len(names) != len(set(names)): raise ValueError('Duplicate archive members')
        def read(name):
            member = tar.getmember(name)
            if not member.isfile(): raise ValueError('Expected regular archive member')
            return tar.extractfile(member).read()
        def blob(descriptor):
            digest = descriptor['digest']
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest): raise ValueError('Invalid digest')
            data = read('blobs/sha256/' + digest.split(':')[1])
            if len(data) != descriptor['size'] or 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
                raise ValueError('OCI blob identity mismatch')
            verified.append(digest)
            return data
        index = json.loads(read('index.json'))
        if index.get('mediaType') != INDEX or len(index['manifests']) != 1:
            raise ValueError('Expected one exported root descriptor')
        root = index['manifests'][0]
        expected = metadata['containerimage.descriptor']
        if metadata['containerimage.digest'] != root['digest'] or any(root.get(k) != expected.get(k) for k in ('digest', 'mediaType', 'size')):
            raise ValueError('Build metadata does not bind exported index')
        def walk(descriptor, parent):
            manifest = json.loads(blob(descriptor))
            if descriptor['mediaType'] == INDEX:
                if manifest.get('mediaType') != INDEX: raise ValueError('Index media type mismatch')
                for child in manifest['manifests']: walk(child, descriptor['digest'])
                return
            if descriptor['mediaType'] != MANIFEST or manifest.get('mediaType') != MANIFEST:
                raise ValueError('Unexpected manifest media type')
            config = json.loads(blob(manifest['config']))
            layers = [(layer, blob(layer)) for layer in manifest['layers']]
            row = {'descriptor': descriptor, 'manifest': manifest, 'config': config, 'layers': layers, 'parent': parent}
            annotation = descriptor.get('annotations', {})
            if annotation.get('vnd.docker.reference.type') == 'attestation-manifest' or manifest.get('artifactType') == ATTESTATION:
                attestations.append(row)
            elif config.get('os') == 'linux': images.append(row)
            else: raise ValueError('Unexpected non-image/non-attestation manifest')
        walk(root, None)
        if len(images) != 1: raise ValueError('Expected exactly one Linux image')
        image = images[0]
        selected, config = image['descriptor'], image['config']
        if any(selected.get('platform', {}).get(k, '') != config.get(k, '') for k in ('os', 'architecture', 'variant')):
            raise ValueError('Image descriptor platform differs from config')
        if len(local_image) != 1: raise ValueError('Expected one tested local image')
        tested = local_image[0]
        if config['rootfs'] != {'type': tested['RootFS']['Type'], 'diff_ids': tested['RootFS']['Layers']}:
            raise ValueError('OCI rootfs differs from tested local image')
        if len(image['layers']) != len(config['rootfs']['diff_ids']): raise ValueError('Layer/diff ID count mismatch')
        for (layer, data), expected_diff in zip(image['layers'], config['rootfs']['diff_ids']):
            if layer['mediaType'] == 'application/vnd.oci.image.layer.v1.tar+gzip':
                with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
                    actual_diff = hashlib.file_digest(stream, 'sha256').hexdigest()
            elif layer['mediaType'] == 'application/vnd.oci.image.layer.v1.tar':
                actual_diff = hashlib.sha256(data).hexdigest()
            else: raise ValueError('Unsupported rootfs layer encoding')
            if 'sha256:' + actual_diff != expected_diff: raise ValueError('Layer bytes differ from declared diff ID')
        if config.get('config') != tested['Config']:
            raise ValueError('OCI runtime config differs from tested local image')
        for key, local_key in [('os', 'Os'), ('architecture', 'Architecture'), ('variant', 'Variant')]:
            if config.get(key, '') != tested.get(local_key, ''): raise ValueError('OCI platform differs from tested image')
        if metadata.get('containerimage.config.digest', image['manifest']['config']['digest']) != image['manifest']['config']['digest']:
            raise ValueError('Build metadata config mismatch')
        statements, bindings = {}, []
        for row in attestations:
            descriptor, manifest = row['descriptor'], row['manifest']
            annotation = descriptor.get('annotations', {})
            if row['parent'] != image['parent'] or annotation.get('vnd.docker.reference.type') != 'attestation-manifest' or annotation.get('vnd.docker.reference.digest') != selected['digest']:
                raise ValueError('Attestation index reference does not bind selected image')
            oci_subject = manifest.get('subject')
            if manifest.get('artifactType') == ATTESTATION:
                if row['config'] != {} or manifest['config']['mediaType'] != 'application/vnd.oci.empty.v1+json' or oci_subject is None:
                    raise ValueError('Invalid OCI attestation artifact')
            if oci_subject is not None and any(oci_subject.get(k) != selected.get(k) for k in ('digest', 'size', 'mediaType')):
                raise ValueError('OCI attestation subject does not bind selected image')
            for layer, data in row['layers']:
                if layer['mediaType'] != 'application/vnd.in-toto+json': raise ValueError('Unexpected attestation layer type')
                statement = json.loads(data)
                predicate = statement.get('predicateType')
                kind = PREDICATES.get(predicate)
                if kind is None or statement.get('_type') != 'https://in-toto.io/Statement/v1' or layer.get('annotations', {}).get('in-toto.io/predicate-type') != predicate:
                    raise ValueError('Invalid attestation statement/predicate type')
                if kind in statements: raise ValueError('Duplicate required attestation: ' + kind)
                subjects = statement.get('subject')
                # Empty subjects are accepted only for a BuildKit OCI artifact with
                # verified OCI subject AND index sibling/reference binding above.
                if subjects == []:
                    if manifest.get('artifactType') != ATTESTATION or oci_subject is None:
                        raise ValueError('Empty statement subject lacks OCI artifact binding')
                elif not isinstance(subjects, list) or len(subjects) != 1 or subjects[0].get('digest') != {'sha256': selected['digest'].split(':')[1]}:
                    raise ValueError('Statement subject does not bind selected image')
                content = statement.get('predicate')
                if not isinstance(content, dict): raise ValueError('Missing predicate content')
                if kind == 'sbom' and (content.get('SPDXID') != 'SPDXRef-DOCUMENT' or not content.get('spdxVersion', '').startswith('SPDX-')):
                    raise ValueError('Invalid SPDX predicate')
                if kind == 'provenance' and (not isinstance(content.get('buildDefinition'), dict) or not isinstance(content.get('runDetails'), dict)):
                    raise ValueError('Invalid SLSA provenance predicate')
                statements[kind] = statement
                bindings.append({'kind': kind, 'statementSubjectEmpty': subjects == [], 'imageManifestDigest': selected['digest'],
                                 'attestationManifestDigest': descriptor['digest'], 'layerDigest': layer['digest'],
                                 'binding': 'verified OCI subject and BuildKit index reference' if subjects == [] else 'verified statement subject and BuildKit index reference'})
        if set(statements) != {'sbom', 'provenance'}: raise ValueError('Exactly one SBOM and one provenance are required')
        digest = hashlib.sha256()
        with archive.open('rb') as handle:
            while chunk := handle.read(1024 * 1024): digest.update(chunk)
        record = {'archivePath': str(archive.resolve()), 'archiveBytes': archive.stat().st_size, 'archiveSha256': digest.hexdigest(),
                  'imageManifestDigest': selected['digest'], 'exportedIndexDigest': root['digest'],
                  'image': {'digest': selected['digest'], 'configDigest': image['manifest']['config']['digest'],
                            'layers': [{'digest': layer['digest'], 'bytes': layer['size']} for layer, _ in image['layers']]},
                  'attestationBindings': bindings, 'verifiedBlobCount': len(verified),
                  'testedImageEquality': {'rootfsDiffIdsEqual': True, 'runtimeConfigEqual': True, 'platformEqual': True,
                                         'layerDiffIdsVerified': True,
                                         'localImageId': tested['Id'], 'ociConfigDigest': image['manifest']['config']['digest']}}
    output.mkdir(parents=True, exist_ok=True)
    for kind, statement in statements.items():
        (output / (kind + '.json')).write_text(json.dumps(statement, indent=2) + '\n')
    (output / 'oci-index.json').write_text(json.dumps(index, indent=2) + '\n')
    (output / 'oci-record.json').write_text(json.dumps(record, indent=2) + '\n')
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    inspect_archive(args.archive, args.output,
                    json.loads((args.output / 'build-metadata.json').read_text()),
                    json.loads((args.output / 'local-image-inspect.json').read_text()))


if __name__ == '__main__': main()
