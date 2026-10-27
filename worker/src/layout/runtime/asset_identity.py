"""Canonical identity for a complete, verified offline layout asset bundle."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

PREFIX = b'docslurp-layout-bundle-v1\n'
SHA256 = re.compile(r'^[0-9a-f]{64}$')


def canonical_bundle_sha256(files):
    if not isinstance(files, list) or not 1 <= len(files) <= 128:
        raise ValueError('Invalid model file manifest')
    entries = []
    seen = set()
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {'path', 'sha256'}:
            raise ValueError('Invalid model file entry')
        name, digest = entry['path'], entry['sha256']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9._/-]{1,1024}', name):
            raise ValueError('Invalid model asset path')
        parsed = PurePosixPath(name)
        if not parsed.parts or parsed.is_absolute() or '..' in parsed.parts or parsed.as_posix() != name or name in seen:
            raise ValueError('Noncanonical or duplicate model asset path')
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError('Invalid model asset SHA256')
        seen.add(name)
        entries.append({'path': name, 'sha256': digest})
    encoded = json.dumps(sorted(entries, key=lambda entry: entry['path']), sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(PREFIX + encoded).hexdigest()


def verify_asset_bundle(assets, files):
    """Verify every file and reject undeclared assets before any adapter loads."""
    bundle = canonical_bundle_sha256(files)
    root = Path(assets).resolve(strict=True)
    declared = {entry['path'] for entry in files}
    actual = set()
    for location in root.rglob('*'):
        if location.is_symlink(): raise ValueError('Symlink model assets are unsupported')
        if location.is_file(): actual.add(location.relative_to(root).as_posix())
        if len(actual) > 128: raise ValueError('Too many model asset files')
    if actual != declared: raise ValueError('Model manifest must cover exactly every offline asset')
    for entry in files:
        location = (root / entry['path']).resolve(strict=True)
        if not location.is_relative_to(root) or not location.is_file():
            raise ValueError('Invalid model asset path')
        digest = hashlib.sha256()
        with location.open('rb') as handle:
            while chunk := handle.read(1024 * 1024): digest.update(chunk)
        if digest.hexdigest() != entry['sha256']: raise ValueError('Offline model asset hash mismatch')
    return bundle
