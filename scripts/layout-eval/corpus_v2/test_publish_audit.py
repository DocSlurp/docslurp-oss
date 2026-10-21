import json
import os
from pathlib import Path
import tempfile
import unittest

from publish_audit import audit, sha


class PublishAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.root = Path(self.temp.name)
        for folder in ("sources", "images", "references", "contracts", "expected", "assets"):
            (self.root / folder).mkdir()
        self.source = {"id": "test", "provenance": {"kind": "deliberately-authored-editorial-composition"},
                       "commands": [], "regions": [],
                       "prose_contract": {"path": "contracts/test.json"},
                       "expected_markdown": {"path": "expected/test.md"}}
        for folder, suffix in (("images", "png"), ("references", "json"), ("contracts", "json"), ("expected", "md")):
            (self.root / folder / ("test." + suffix)).write_text("fixture")
        self.clearances = {"contribution_release": {"license": "CC-BY-4.0", "approved_by": "test", "attribution": "test", "original_content_scope": "fixture"}}

    def tearDown(self):
        self.temp.cleanup()

    def run_audit(self):
        (self.root / "sources/test.json").write_text(json.dumps(self.source))
        return audit(self.root, self.clearances)

    def test_missing_release_fails_closed(self):
        self.clearances = {}
        result = self.run_audit()
        self.assertEqual(result["rights_ready_count"], 0)

    def test_unverified_insert_does_not_inherit_page_release(self):
        asset = self.root / "assets/insert.png"
        asset.write_bytes(b"unverified")
        self.source["commands"] = [{"op": "image", "path": str(asset)}]
        result = self.run_audit()
        self.assertEqual(result["rights_ready_count"], 0)
        self.assertTrue(any("unverified_dependency_license" in issue for issue in result["excluded_entries"][0]["rights_issues"]))

    def test_changed_rights_evidence_revokes_clearance(self):
        asset = self.root / "assets/insert.png"
        asset.write_bytes(b"cleared")
        proof = self.root / "assets/proof.json"
        proof.write_text("original proof")
        self.source["commands"] = [{"op": "image", "path": str(asset)}]
        self.clearances["dependencies"] = [{"sha256": sha(asset), "license": "CC0-1.0", "attribution": "Museum", "modifications": "cropped", "reviewed_by": "reviewer", "reviewed_at": "2026-10-20", "evidence": [{"path": str(proof), "sha256": sha(proof)}]}]
        self.assertEqual(self.run_audit()["rights_ready_count"], 1)
        proof.write_text("changed proof")
        self.assertEqual(self.run_audit()["rights_ready_count"], 0)

    def test_rights_ready_is_not_label_or_release_ready(self):
        result = self.run_audit()
        self.assertEqual(result["rights_ready_count"], 1)
        self.assertEqual(result["publish_entries"][0]["label_evidence_status"], "blocked-or-stale")
        self.assertFalse(result["publication_performed"])


if __name__ == "__main__":
    unittest.main()
