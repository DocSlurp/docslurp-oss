"""Caller-selected evidence allowlist, isolated from corpus inputs and labels.

The index is trusted coordinator configuration supplied separately from approval
data. Original paths are aliases to exact copied evidence bytes inside the bundle.
"""
import json
from pathlib import Path
import re

from contract import file_hash


class EvidenceScope:
    def __init__(self, index_path, protected_roots=()):
        index_path = Path(index_path).absolute()
        self.root = index_path.parent.resolve()
        if not index_path.resolve().is_relative_to(self.root):
            raise ValueError('evidence-index-symlink-escape')
        for root in protected_roots:
            root = Path(root).resolve()
            if self.root.is_relative_to(root) or root.is_relative_to(self.root):
                raise ValueError('evidence-scope-overlaps-corpus')
        self.index = json.loads(index_path.read_text())
        if self.index.get('schema') != 'mixed-pdf-evidence-scope@1':
            raise ValueError('unsupported-evidence-scope')
        self.index_hash = file_hash(index_path)
        self.files = self.index['files']
        self.aliases = self.index.get('aliases', {})
        for key, digest in self.files.items():
            path = Path(key)
            if path.is_absolute() or '..' in path.parts or not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
                raise ValueError('invalid-evidence-allowlist')
        if any(key not in self.files for key in self.aliases.values()):
            raise ValueError('unknown-evidence-alias-target')
        self.score_hash = self.files['score-script.py']
        self.verify_file(self.root/'score-script.py', self.score_hash)

    def authorized_path(self, requested, expected=None):
        requested = Path(requested).absolute()
        key = self.aliases.get(str(requested))
        if key is None and requested.is_relative_to(self.root):
            key = str(requested.relative_to(self.root))
        if key not in self.files or (expected is not None and expected != self.files[key]):
            raise ValueError('evidence-path-or-digest-not-authorized')
        actual = (self.root/key).resolve()
        if not actual.is_relative_to(self.root):
            raise ValueError('evidence-symlink-escape')
        return actual, self.files[key]

    def verify_file(self, path, expected):
        actual, digest = self.authorized_path(path, expected)
        if file_hash(actual) != digest:
            raise ValueError('changed-approval-evidence')
        return actual

    def load(self, entry):
        return json.loads(self.verify_file(entry['path'], entry['sha256']).read_text())

    def load_file(self, path):
        actual, digest = self.authorized_path(path)
        return self.load(dict(path=str(actual), sha256=digest))

    def reviewer(self, report_digest, stage):
        item = self.index.get('reviewStages', {}).get(report_digest, {})
        if item.get('stage') != stage or not isinstance(item.get('reviewerId'), str) or not item['reviewerId']:
            raise ValueError('review-stage-not-authorized')
        return item['reviewerId']
