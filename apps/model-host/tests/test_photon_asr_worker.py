"""Provenance/bounds tests; these do not assert a GPU inference result."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
import photon_asr_worker as worker


class PhotonAsrTests(unittest.TestCase):
    def test_model_timestamps_are_offset_not_reinvented(self):
        result = {"text": "Hola", "segments": [{"start": 0.25, "end": 1.2, "text": "Hola",
                   "words": [{"start": 0.3, "end": 1.1, "word": "Hola"}]}]}
        row = worker.translate_segments(result, 30, 5)[0]
        self.assertEqual((row["start"], row["end"]), (30.25, 31.2))
        self.assertEqual(row["words"][0]["start"], 30.3)
        self.assertEqual(row["speakerAttribution"], "unresolved")

    def test_invalid_timestamps_and_missing_timestamps_fail_closed(self):
        invalid = [(-1, 1), (0, 6), (2, 1), (0, float("inf")), (float("nan"), 1)]
        for start, end in invalid:
            with self.assertRaises(ValueError):
                worker.translate_segments({"text": "Hola", "segments": [{"start": start, "end": end,
                                           "text": "Hola"}]}, 0, 5)
        with self.assertRaises(ValueError):
            worker.translate_segments({"text": "Hola", "segments": []}, 0, 5)
        self.assertEqual(worker.translate_segments({"text": "", "segments": []}, 0, 5), [])

    def test_bad_optional_alignment_preserves_segment_without_clamping(self):
        segment = {"start": 0, "end": 1, "text": "Hola mundo", "words": [
            {"start": 0, "end": 0.4, "word": "Hola"}, {"start": 0.5, "end": 2, "word": "mundo"}]}
        row = worker.translate_segments({"text": "Hola mundo", "segments": [segment]}, 30, 5)[0]
        self.assertEqual((row["start"], row["end"], row["text"]), (30, 31, "Hola mundo"))
        self.assertNotIn("words", row)  # No partial alignment survives the bad word.
        self.assertEqual(row["wordTimestampStatus"], "unavailable-invalid-model-output")
        self.assertEqual(segment["words"][1]["end"], 2)  # Input was not repaired/mutated.

    def test_malformed_optional_words_degrade_deterministically(self):
        cases = [False, {}, "word", [], [None], [False], ["word"], [{}],
                 [{"start": False, "end": 1, "word": "Hola"}],
                 [{"start": 0, "end": True, "word": "Hola"}],
                 [{"start": 0, "end": float("nan"), "word": "Hola"}],
                 [{"start": 0, "end": float("inf"), "word": "Hola"}],
                 [{"start": 0, "end": 0, "word": "Hola"}],
                 [{"start": -1, "end": 1, "word": "Hola"}],
                 [{"start": 0, "end": 1, "word": " "}],
                 [{"start": 0, "end": 1, "word": True}]]
        for words in cases:
            with self.subTest(words=words):
                row = worker.translate_segments({"text": "Hola", "segments": [
                    {"start": 0, "end": 1, "text": "Hola", "words": words}]}, 0, 5)[0]
                self.assertEqual(row["text"], "Hola")
                self.assertNotIn("words", row)
                self.assertEqual(row["wordTimestampStatus"], "unavailable-invalid-model-output")

    def test_required_segment_corruption_still_rejects(self):
        for segment in [None, False, [], {"start": False, "end": 1, "text": "Hola"},
                        {"start": 0, "end": True, "text": "Hola"},
                        {"start": 0, "end": 6, "text": "Hola", "words": []}]:
            with self.subTest(segment=segment), self.assertRaises(ValueError):
                worker.translate_segments({"text": "Hola", "segments": [segment]}, 0, 5)

    def test_absent_words_and_other_segments_remain_usable(self):
        rows = worker.translate_segments({"text": "Hola mundo", "segments": [
            {"start": 0, "end": 1, "text": "Hola", "words": [{"start": 0, "end": 2, "word": "Hola"}]},
            {"start": 1, "end": 2, "text": "mundo"}]}, 0, 5)
        self.assertEqual([row["text"] for row in rows], ["Hola", "mundo"])
        self.assertNotIn("wordTimestampStatus", rows[1])

    def test_no_implicit_download_or_missing_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                worker.validate_checkpoint(root, worker.ULTRA)
            for name in ("config.json", "tokenizer.json", "model.safetensors"):
                (root / name).write_text("fixture")
            self.assertEqual(worker.validate_checkpoint(root, worker.ULTRA), root.resolve())
            with self.assertRaises(ValueError):
                worker.validate_checkpoint(root, "unknown")


if __name__ == "__main__":
    unittest.main()
