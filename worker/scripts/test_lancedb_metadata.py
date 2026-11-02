"""Native numeric worker tests. Run in the locked LanceDB dependency environment."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import lancedb
import pyarrow as pa
from lancedb.embeddings import get_registry
spec = importlib.util.spec_from_file_location("vector_backend_write", Path(__file__).with_name("vector_backend_write.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class PersistedMetadata(unittest.TestCase):
    def test_refuses_before_provider_restoration(self):
        registry = get_registry()
        with tempfile.TemporaryDirectory(prefix="python-lance-metadata-") as root:
            db = lancedb.connect(root)
            records = [{"text": "persisted", "vector": [1.0, 0.0]}]
            cases = [b"{", b"[]"] + [json.dumps([dict(name=name, source_column="text", vector_column="vector",
                model={"base_url": "http://169.254.169.254", "host": "http://127.0.0.1:1", "trust_remote_code": True})]).encode()
                for name in ("openai", "ollama", "sentence-transformers", "unknown")]
            with patch.object(socket.socket, "connect", side_effect=AssertionError("FORBIDDEN_NETWORK")) as network:
                for index, raw in enumerate(cases):
                    schema = pa.schema([("text", pa.string()), ("vector", pa.list_(pa.float32(), 2))], metadata={b"embedding_functions": raw})
                    table = db.create_table(f"hostile_{index}", schema=schema)
                    self.assertEqual(table.schema.metadata[b"embedding_functions"], raw)
                    with patch.dict(os.environ, {"LANCEDB_URI": root}), patch.object(type(registry), "_restore", side_effect=AssertionError("FORBIDDEN_PROVIDER_RESTORATION")) as restore:
                        with self.assertRaisesRegex(adapter.UnsupportedEmbeddingMetadata, "refuses persisted"):
                            adapter.write_lancedb(argparse.Namespace(collection=f"hostile_{index}"), {"records": records})
                        restore.assert_not_called()
                    self.assertEqual(table.count_rows(), 0)
                network.assert_not_called()
            self.assertFalse(registry._allowed_remote_code)
            self.assertFalse(registry._allowed_endpoints)

    def test_normal_numeric_writes(self):
        with tempfile.TemporaryDirectory(prefix="python-lance-numeric-") as root, patch.dict(os.environ, {"LANCEDB_URI": root}):
            args = argparse.Namespace(collection="normal")
            for vector in ([0.0, 1.0], [1.0, 0.0]):
                self.assertEqual(adapter.write_lancedb(args, {"records": [{"text": "numeric", "vector": vector}]})["records"], 1)
            self.assertEqual(lancedb.connect(root).open_table("normal").count_rows(), 2)

if __name__ == "__main__":
    unittest.main()
