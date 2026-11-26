"""Word timestamps from Parakeet tokens, without importing a model runtime."""
import importlib.util
import sys
from pathlib import Path
import unittest

SRC = Path(__file__).parents[1] / "src"
sys.path.insert(0, str(SRC))
spec = importlib.util.spec_from_file_location("align_worker", SRC / "align_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

B = "\u2581"


class WordsFromTokensTests(unittest.TestCase):
    def test_joins_subword_tokens_and_uses_tdt_durations(self):
        words = worker.words_from_tokens([B + "Ho", "la", ",", B + "Ma", "nuel"], [0.32, 0.40, 0.48, 0.64, 0.80],
                                         [0.08, 0.08, 0.0, 0.16, 0.24], offset=10.0, limit=20.0)
        self.assertEqual([w["word"] for w in words], ["Hola,", "Manuel"])
        self.assertAlmostEqual(words[0]["start"], 10.32)
        self.assertAlmostEqual(words[0]["end"], 10.48)
        self.assertAlmostEqual(words[1]["start"], 10.64)
        self.assertAlmostEqual(words[1]["end"], 11.04)

    def test_sherpa_onnx_1_13_tokens_mark_a_new_word_with_a_leading_space(self):
        # The pinned runtime turns the boundary mark into a space (CodeRabbit review of #198).
        words = worker.words_from_tokens([" Hola", ",", " Ma", "nuel", "."], [1.0, 1.3, 5.0, 5.2, 5.5],
                                         [0.2, 0.0, 0.2, 0.2, 0.0], offset=0.0, limit=10.0)
        self.assertEqual([w["word"] for w in words], ["Hola,", "Manuel."])
        self.assertAlmostEqual(words[0]["start"], 1.0)
        self.assertAlmostEqual(words[1]["start"], 5.0)
        self.assertAlmostEqual(words[1]["end"], 5.4)

    def test_without_durations_a_word_ends_where_the_next_begins(self):
        words = worker.words_from_tokens([B + "uno", B + "dos"], [1.0, 1.5], [], offset=0.0, limit=3.0)
        self.assertAlmostEqual(words[0]["end"], 1.5)
        self.assertAlmostEqual(words[1]["end"], 1.5 + worker.LAST_TOKEN_SECONDS)

    def test_first_token_without_boundary_marker_starts_a_word(self):
        words = worker.words_from_tokens(["hola", B + "que"], [0.1, 0.5], [], offset=0.0, limit=1.0)
        self.assertEqual([w["word"] for w in words], ["hola", "que"])

    def test_ends_stay_inside_the_window_and_after_the_start(self):
        words = worker.words_from_tokens([B + "fin"], [0.95], [0.5], offset=0.0, limit=1.0)
        self.assertAlmostEqual(words[0]["end"], 1.0)
        self.assertGreater(words[0]["end"], words[0]["start"])

    def test_punctuation_only_tokens_never_make_a_word(self):
        self.assertEqual(worker.words_from_tokens([B + ".", B + "?"], [0.1, 0.2], [], offset=0.0, limit=1.0), [])

    def test_tokens_without_timestamps_fail_loudly(self):
        # A sherpa build that gives no timestamps must not look like silence (Kiro review of #198).
        with self.assertRaisesRegex(ValueError, "timestamps"):
            worker.words_from_tokens([B + "hola"], [], [], offset=0.0, limit=1.0)

    def test_mismatched_lengths_are_refused(self):
        with self.assertRaises(ValueError):
            worker.words_from_tokens([B + "a", B + "b"], [0.1], [], offset=0.0, limit=1.0)

    def test_longest_clip_is_bounded(self):
        with self.assertRaises(ValueError):
            worker.check_duration(worker.MAX_ALIGN_SECONDS * 16000 + 16001, 16000)
        worker.check_duration(60 * 16000, 16000)


if __name__ == "__main__":
    unittest.main()
