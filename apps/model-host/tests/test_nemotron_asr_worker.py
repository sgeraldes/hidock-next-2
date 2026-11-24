"""Native CLI contract and process limits; no GPU or weights required."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

source = Path(__file__).parents[1] / "src" / "nemotron_asr_worker.py"
spec = importlib.util.spec_from_file_location("nemotron_asr_worker", source)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
from prepare_nemotron_asr import extract_runtime, download


class NemotronTests(unittest.TestCase):
    def test_segment_contains_overlapping_word_ends(self):
        row = worker.translate_result({"text": "uno dos", "words": [
            {"word": "uno", "start": 0.1, "end": 0.9},
            {"word": "dos", "start": 0.2, "end": 0.3},
        ]}, 10, 1)
        self.assertEqual(row["end"], 10.9)
        self.assertTrue(all(word["end"] <= row["end"] for word in row["words"]))

    def test_native_words_offset_without_speaker_guess(self):
        row = worker.translate_result({"text": "hola", "words": [{"word": "hola", "start": 0.2, "end": 0.8}]}, 30, 1)
        self.assertEqual(row["start"], 30.2)
        self.assertEqual(row["words"][0]["end"], 30.8)
        self.assertEqual(row["speakerAttribution"], "unresolved")
        self.assertEqual(row["timestampSource"], "model-word-timestamps")

    def test_missing_invalid_or_unordered_words_rejected(self):
        for words in [[], [{"word": "x", "start": -1, "end": 1}],
                      [{"word": "x", "start": 1, "end": 4}],
                      [{"word": "x", "start": 0.5, "end": 0.6}, {"word": "y", "start": 0.2, "end": 0.4}]]:
            with self.subTest(words=words), self.assertRaises(ValueError):
                worker.translate_result({"text": "x", "words": words}, 0, 2)
        self.assertIsNone(worker.translate_result({"text": "", "words": []}, 0, 2))

    def test_observed_streaming_tail_preserves_text_without_fake_word_alignment(self):
        result = {"text": "fixture ending", "duration": 44.79, "words": [
            {"word": "fixture", "start": 44.64, "end": 44.8},
            {"word": "ending", "start": 45.04, "end": 45.12},
        ]}
        row = worker.translate_result(result, 30, 44.79)
        self.assertEqual(row["text"], result["text"])
        self.assertEqual(row["start"], 30)
        self.assertAlmostEqual(row["end"], 74.79)
        self.assertEqual(row["timestampSource"], "audio-window")
        self.assertNotIn("words", row)
        self.assertAlmostEqual(row["timingWarning"]["tailOverrunSeconds"], 0.33)
        self.assertEqual(row["timingWarning"]["discardedWordTimings"], 2)

    def test_small_tail_no_longer_leaks_outside_audio_but_large_tail_still_fails(self):
        for end in (1.01, 1.25, 1.5):
            row = worker.translate_result({"text": "x", "words": [{"word": "x", "start": 0.5, "end": end}]}, 0, 1)
            self.assertEqual(row["end"], 1)
            self.assertNotIn("words", row)
        with self.assertRaises(ValueError):
            worker.translate_result({"text": "x", "words": [{"word": "x", "start": 0.5, "end": 1.501}]}, 0, 1)

    def test_real_child_json_and_stderr_are_separate(self):
        result = worker.run_cli([sys.executable, "-c", "import sys; print('diagnostic',file=sys.stderr); print('{\"text\":\"hola\"}')"])
        self.assertEqual(result, {"text": "hola"})

    def test_invalid_timestamp_diagnostic_omits_private_text(self):
        with self.assertRaises(ValueError) as caught:
            worker.translate_result({"text": "private meeting", "duration": 3,
                                     "words": [{"word": "private meeting", "start": 4, "end": 5}]}, 0, 3)
        self.assertIn('"index": 0', str(caught.exception))
        self.assertIn('"windowDuration": 3', str(caught.exception))
        self.assertNotIn("private meeting", str(caught.exception))

    def test_real_child_timeout_is_bounded(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            worker.run_cli([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.1)

    def test_real_child_output_cap(self):
        with self.assertRaisesRegex(RuntimeError, "bounded output"):
            worker.run_cli([sys.executable, "-c", "import sys; sys.stdout.write('x' * 3000000)"])

    def test_archive_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            archive = path / "runtime.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("../escape.exe", b"bad")
            with self.assertRaisesRegex(ValueError, "Unsafe archive"):
                extract_runtime(archive, path / "runtime")
            self.assertFalse((path / "escape.exe").exists())

    def test_download_rejects_unverified_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            fixture = path / "source"
            fixture.write_bytes(b"abc")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                download(fixture.as_uri(), path / "model", 3, "0" * 64)
            self.assertFalse((path / "model").exists())


if __name__ == "__main__":
    unittest.main()
