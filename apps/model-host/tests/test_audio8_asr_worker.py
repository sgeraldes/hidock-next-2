import hashlib
import io
from contextlib import redirect_stderr, redirect_stdout
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from audio8_asr_worker import load_model_pread, memory_snapshot, progress, supported_language, translate_result
from prepare_audio8_asr import MODEL, REVISION, SOURCE_REVISION, SOURCE_FILES, REQUIRED, validate_checkpoint


class Audio8Tests(unittest.TestCase):
    def test_pread_loader_uses_official_reader_and_strict_loading_report(self):
        reader = MagicMock()
        reader.__enter__.return_value = reader
        reader.keys.return_value = ['weight']
        model_class = MagicMock()
        model = MagicMock()
        model_class.from_pretrained.return_value = (model, {})
        def open_shard(path, **kwargs):
            reader.keys.return_value = ['vad'] if Path(path).name.startswith('semantic') else ['weight']
            return reader
        safe_open = MagicMock(side_effect=open_shard)
        mapping = json.dumps({'weight_map': {'weight': 'model.safetensors', 'vad': 'semantic_vad_heads.safetensors'}})
        with patch.dict(sys.modules, {'safetensors': SimpleNamespace(safe_open=safe_open)}), \
                patch.object(Path, 'read_text', return_value=mapping), redirect_stderr(io.StringIO()):
            load_model_pread(model_class, Path('fixture'), SimpleNamespace(bfloat16='bf16'))
            self.assertEqual(safe_open.call_args.kwargs['backend'], 'pread')
            self.assertIsNone(model_class.from_pretrained.call_args.args[0])
            self.assertTrue(model_class.from_pretrained.call_args.kwargs['output_loading_info'])
            self.assertEqual(set(model_class.from_pretrained.call_args.kwargs['state_dict']), {'weight', 'vad'})
            for key in ('missing_keys', 'unexpected_keys', 'mismatched_keys', 'error_msgs'):
                model_class.from_pretrained.return_value = (model, {key: ['bad']})
                with self.assertRaisesRegex(ValueError, key):
                    load_model_pread(model_class, Path('fixture'), SimpleNamespace(bfloat16='bf16'))

    @unittest.skipUnless(sys.platform == 'win32', 'Windows memory counters')
    def test_real_lightweight_memory_counters_without_loading_torch(self):
        before = 'torch' in sys.modules
        snapshot = memory_snapshot({'memoryMb': 16384})
        self.assertEqual(snapshot['policyMemoryMb'], 16384)
        self.assertGreater(snapshot['physicalTotalBytes'], 0)
        self.assertGreaterEqual(snapshot['globalCommitAvailableBytes'], 0)
        self.assertEqual(snapshot['globalCommitLimitBytes'], snapshot['globalCommitUsedBytes'] +
                         snapshot['globalCommitAvailableBytes'])
        self.assertEqual('torch' in sys.modules, before)

    def test_progress_preserves_stdout_protocol_and_ascii(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            progress('weights-load-start', path='C:/usu\u00e1rio')
        self.assertEqual(stdout.getvalue(), '')
        message = stderr.getvalue()
        self.assertTrue(message.isascii())
        self.assertEqual(json.loads(message.removeprefix('[Audio8] '))['stage'], 'weights-load-start')

    def test_explicit_language_gate(self):
        self.assertEqual(supported_language("en-US"), "en")
        self.assertEqual(supported_language("zh_CN"), "zh")
        for value in ("es", "es-AR", "auto", "", "fr"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                supported_language(value)

    def test_full_clock_schedule_preserves_text_without_inventing_word_times(self):
        rows, count = translate_result({"final_text": "Hello", "generated_token_ids": [1] * 386}, 480000, 30)
        self.assertEqual(count, 386)
        self.assertEqual((rows[0]["start"], rows[0]["end"]), (30, 60))
        self.assertEqual(rows[0]["timestampSource"], "audio-window")
        self.assertEqual(rows[0]["speaker"], "Speaker unresolved")
        self.assertNotIn("words", rows[0])

    def test_incomplete_or_excess_clock_output_rejected(self):
        for size in (0, 385, 387, 512):
            with self.subTest(size=size), self.assertRaises(ValueError):
                translate_result({"final_text": "Partial", "generated_token_ids": [1] * size}, 480000, 0)

    def test_partial_last_clock_and_empty_speech(self):
        self.assertEqual(translate_result({"final_text": "", "generated_token_ids": [1] * 24}, 16000, 0), ([], 24))

    def test_pinned_source_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in REQUIRED:
                (root / name).write_bytes(b"fixture")
            hashes = {}
            for name in SOURCE_FILES:
                path = root / "source/audio8_asr_infinite" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
                hashes[name] = hashlib.sha256(b"fixture").hexdigest()
            manifest = {"model": MODEL, "revision": REVISION, "sourceRevision": SOURCE_REVISION,
                        "sourceHashes": hashes}
            (root / "hidock-manifest.json").write_text(json.dumps(manifest))
            self.assertEqual(validate_checkpoint(root)["revision"], REVISION)
            (root / "source/audio8_asr_infinite/streaming_inference.py").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                validate_checkpoint(root)


if __name__ == "__main__":
    unittest.main()
