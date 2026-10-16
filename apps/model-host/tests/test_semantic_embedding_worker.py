import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from prepare_semantic_embeddings import FILES, create_manifest, load_manifest
from semantic_embedding_worker import validate_request


class SemanticTests(unittest.TestCase):
    def test_worker_imports_sibling_in_isolated_python_without_script_path(self):
        worker = Path(__file__).resolve().parents[1] / "src" / "semantic_embedding_worker.py"
        result = subprocess.run([sys.executable, "-I", str(worker), "--help"],
                                capture_output=True, text=True, timeout=15, cwd=tempfile.gettempdir())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--model-dir", result.stdout)

    def test_request_quotas_and_explicit_role(self):
        self.assertEqual(validate_request({"purpose": "query", "texts": ["hello"]})["texts"], ["hello"])
        for request in ({"texts": ["hello"]}, {"purpose": "query", "texts": [""]},
                        {"purpose": "passage", "texts": ["x"] * 17},
                        {"purpose": "query", "texts": ["x" * 16001]}):
            with self.assertRaises(ValueError):
                validate_request(request)

    def test_full_asset_hash_identity_and_changed_asset_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "onnx").mkdir()
            for name in FILES:
                (root / name).write_bytes(name.encode())
            first = create_manifest(root)
            (root / "hidock-semantic-manifest.json").write_text(json.dumps(first), encoding="utf-8")
            self.assertEqual(load_manifest(root)["spaceId"], first["spaceId"])
            (root / "tokenizer.json").write_text("different tokenizer", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_manifest(root)
            self.assertNotEqual(create_manifest(root)["spaceId"], first["spaceId"])


if __name__ == "__main__":
    unittest.main()
