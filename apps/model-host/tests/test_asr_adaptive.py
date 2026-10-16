"""Pure standard-library tests; importing the worker does not load any models."""
import importlib.util
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("asr_worker", Path(__file__).parents[1] / "src" / "asr_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class AdaptiveAsrTests(unittest.TestCase):
    def test_long_cohere_recording_reaches_existing_acoustic_splitter(self):
        rate = 16000
        samples = round(3639.852 * rate)
        worker.validate_recording_duration(samples, rate)
        windows = worker.acoustic_asr_windows([(0, samples / rate, "A")], samples, rate)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], samples)
        self.assertTrue(all(b - a <= rate * 20 for a, b in windows))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))

    def test_all_native_window_budgets_cover_long_recording_without_gaps(self):
        samples, rate = round(3639.852 * 16000), 16000
        for budget in (10, 20, 30, 60, 600):
            with self.subTest(budget=budget):
                windows = worker.frame_windows(samples, rate, budget)
                self.assertEqual(windows[0][0], 0)
                self.assertEqual(windows[-1][1], samples)
                self.assertTrue(all(b - a <= rate * budget for a, b in windows))
                self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))

    def test_shared_recording_safety_envelope_is_still_enforced(self):
        worker.validate_recording_duration(21600 * 16000, 16000)
        with self.assertRaisesRegex(ValueError, "six hours"):
            worker.validate_recording_duration(21600 * 16000 + 1, 16000)

    def test_context_is_bounded_and_not_mistaken_for_speech_or_identity(self):
        self.assertIsNone(worker.continuation_context([]))
        context = worker.continuation_context([{"speaker": "A", "text": "word " * 1000}])
        self.assertIn("Do not repeat", context)
        self.assertIn("speaker identity", context)
        self.assertLess(len(context), 2250)

    def test_vibevoice_offsets_and_namespaces_window_local_speakers(self):
        rows = [{"start_time": 1, "end_time": 2, "speaker_id": 0, "text": "hello"}]
        result = worker.offset_vibevoice_segments(rows, 600 * 16000, 10 * 16000, 16000, 1)
        self.assertEqual((result[0]["start"], result[0]["end"]), (601, 602))
        self.assertEqual(result[0]["speaker"], "window1:Speaker 0")
        rows[0]["end_time"] = 11
        with self.assertRaisesRegex(ValueError, "outside its audio window"):
            worker.offset_vibevoice_segments(rows, 0, 10 * 16000, 16000, 0)

    def test_microturn_has_real_context_without_invented_speaker(self):
        bounds = [(25.5796875, 25.5965625, "A")]
        windows = worker.acoustic_asr_windows(bounds, 60 * 16000, 16000)
        self.assertEqual(len(windows), 1)
        left, right = windows[0]
        self.assertEqual(right - left, 32000)
        self.assertLessEqual(left, 409275)
        self.assertGreaterEqual(right, 409545)
        provenance = worker.acoustic_provenance(left / 16000, right / 16000, bounds)
        self.assertEqual(provenance["speaker"], "A")
        self.assertEqual(provenance["acousticTurns"][0]["start"], bounds[0][0])

    def test_short_file_and_edge_turns_stay_inside_audio(self):
        self.assertEqual(worker.acoustic_asr_windows([(0.01, 0.03, "A")], 80, 100), [(0, 80)])
        self.assertEqual(worker.acoustic_asr_windows([(0, 0.01, "A")], 1000, 100), [(0, 200)])
        self.assertEqual(worker.acoustic_asr_windows([(9.99, 10, "A")], 1000, 100), [(800, 1000)])

    def test_overlapping_context_is_decoded_once_with_transparent_mixed_speakers(self):
        bounds = [(1, 1.02, "A"), (1.01, 1.05, "B"), (1.5, 1.6, "A")]
        windows = worker.acoustic_asr_windows(bounds, 1000, 100)
        self.assertEqual(len(windows), 1)
        left, right = windows[0]
        provenance = worker.acoustic_provenance(left / 100, right / 100, bounds)
        self.assertEqual(provenance["speaker"], "Speaker unresolved")
        self.assertEqual(provenance["acousticSpeakers"], ["A", "B"])
        self.assertEqual(provenance["speakerAssignment"], "unresolved-mixed-or-context")
        self.assertEqual(len(provenance["acousticTurns"]), 3)

    def test_long_groups_preserve_all_speech_with_no_overlap_or_tiny_tail(self):
        bounds = [(0, 40.01, "A"), (40, 40.03, "B"), (50, 50.01, "C")]
        windows = worker.acoustic_asr_windows(bounds, 6000, 100)
        for left, right in windows:
            self.assertGreaterEqual(right - left, 200)
            self.assertLessEqual(right - left, 2000)
        self.assertTrue(all(a[1] <= b[0] for a, b in zip(windows, windows[1:])))
        for start, end, _ in bounds:
            for sample in range(int(start * 100), math.ceil(end * 100)):
                self.assertEqual(sum(left <= sample < right for left, right in windows), 1)

    def test_eos_at_limit_is_complete_despite_decoder_prefix(self):
        self.assertTrue(worker.generation_finished([[4] + [10] * 511 + [3]], 1, 3, 2))
        self.assertFalse(worker.generation_finished([[4] + [10] * 512], 1, 3, 2))

    def test_prompt_eos_does_not_count_and_batch_padding_is_allowed(self):
        self.assertFalse(worker.generation_finished([[3, 10, 10]], 1, 3, 2))
        self.assertTrue(worker.generation_finished([[4, 10, 3, 2], [4, 10, 10, 3]], 1, [3, 5], 2))
        self.assertFalse(worker.generation_finished([[4, 10, 3, 2], [4, 10, 10, 10]], 1, 3, 2))
        self.assertFalse(worker.generation_finished([[4, 3, 10]], 1, 3, 2))

    def test_adaptive_children_cover_parent_without_truncated_parent_text(self):
        calls = []
        def decode(left, right):
            calls.append((left, right))
            return ("TRUNCATED", False) if right - left > 500 else (f"{left}:{right}", True)
        rows = worker.decode_bounded_interval(123, 2123, 100, "speaker", decode)
        self.assertEqual(len(calls), 7)
        self.assertEqual([row["text"] for row in rows], ["123:623", "623:1123", "1123:1623", "1623:2123"])
        self.assertEqual(rows[0]["start"], 1.23)
        self.assertEqual(rows[-1]["end"], 21.23)
        self.assertTrue(all(a["end"] == b["start"] for a, b in zip(rows, rows[1:])))

    def test_accepted_sibling_is_not_retried_when_other_side_needs_split(self):
        calls = []
        def decode(left, right):
            calls.append((left, right))
            return "complete", right <= 1000 or right - left <= 500
        worker.decode_bounded_interval(0, 2000, 100, "speaker", decode)
        self.assertEqual(calls, [(0, 2000), (0, 1000), (1000, 2000), (1000, 1500), (1500, 2000)])

    def test_exhaustion_is_bounded_and_reports_exact_failed_offset(self):
        calls = []
        def decode(left, right):
            calls.append((left, right))
            return "truncated", False
        with self.assertRaisesRegex(RuntimeError, '"startSeconds": 40.0.*"endSeconds": 42.5.*"depth": 3'):
            worker.decode_bounded_interval(4000, 6000, 100, "speaker", decode)
        self.assertEqual(len(calls), 4)

    def test_minimum_duration_prevents_unbounded_short_splits(self):
        calls = []
        def decode(left, right):
            calls.append((left, right))
            return "", False
        with self.assertRaisesRegex(RuntimeError, '"depth": 0'):
            worker.decode_bounded_interval(0, 100, 100, "speaker", decode)
        self.assertEqual(calls, [(0, 100)])

    def test_decoder_error_is_not_retried_as_token_exhaustion(self):
        def decode(*_args):
            raise MemoryError("resource limit")
        with self.assertRaises(MemoryError):
            worker.decode_bounded_interval(0, 2000, 100, "speaker", decode)


if __name__ == "__main__":
    unittest.main()
