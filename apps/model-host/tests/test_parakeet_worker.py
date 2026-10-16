"""Budget and provenance regression tests without importing a model runtime."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
import shutil
import wave
import os

spec = importlib.util.spec_from_file_location("parakeet_worker", Path(__file__).parents[1] / "src/parakeet_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ParakeetWorkerTests(unittest.TestCase):
    def test_exact_silence_does_not_discard_the_smallest_pcm_sample(self):
        self.assertFalse(worker.has_nonzero_samples([0.0, -0.0]))
        self.assertFalse(worker.has_nonzero_samples(bytes(16000)))
        self.assertTrue(worker.has_nonzero_samples([0.0, 1 / 32768]))
        self.assertTrue(worker.has_nonzero_samples([0.0, -1 / 32768]))
        self.assertTrue(worker.has_nonzero_samples(b'\x00\x00\x01\x00'))
        class Array:
            def any(self):
                return True
        self.assertTrue(worker.has_nonzero_samples(Array()))

    def test_silence_split_preserves_every_frame_with_bounded_reads(self):
        class Audio:
            position = 0
            reads = []
            def __len__(self):
                return 6100
            def seek(self, position):
                self.position = position
            def read(self, count, **_kwargs):
                self.reads.append(count)
                return [0.0 if 2920 <= i < 2950 else 0.5
                        for i in range(self.position, self.position + count)]
        audio = Audio()
        windows = list(worker.silence_aware_windows(audio, 100, 31))
        self.assertTrue(2920 <= windows[0][1] < 2950)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], len(audio))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))
        self.assertTrue(all(0 < b - a <= 3100 for a, b in windows))
        self.assertTrue(all(count <= 200 for count in audio.reads))

    def test_continuous_speech_keeps_bounded_cut(self):
        class Audio:
            def __len__(self):
                return 6100
            def seek(self, position):
                pass
            def read(self, count, **_kwargs):
                return [0.5] * count
        self.assertEqual(list(worker.silence_aware_windows(Audio(), 100, 31)), [(0, 3050), (3050, 6100)])

    def test_hour_windows_cover_audio_once_and_bound_memory(self):
        frames = 3599 * 16000 + 5
        windows = worker.frame_windows(frames, 16000)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], frames)
        self.assertTrue(all(0 < end - start <= 30 * 16000 for start, end in windows))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))

    def test_no_tiny_tail_and_short_audio_preserved(self):
        self.assertEqual(worker.frame_windows(31, 1), [(0, 15), (15, 31)])
        self.assertEqual(worker.frame_windows(1, 16000), [(0, 1)])

    def test_reject_invalid_or_overlong_audio(self):
        for frames, rate in [(0, 16000), (16000, 0), ((worker.MAX_AUDIO_SECONDS + 1) * 16000, 16000)]:
            with self.assertRaises(ValueError):
                worker.frame_windows(frames, rate)

    def test_long_meeting_keeps_complete_coverage_with_bounded_windows(self):
        frames = 90 * 60 * 16000
        windows = worker.frame_windows(frames, 16000)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], frames)
        self.assertTrue(all(right - left <= 30 * 16000 for left, right in windows))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))

    def test_silence_no_fabricated_transcript_and_speakers_unresolved(self):
        self.assertIsNone(worker.result_segment("  ", 0, 5))
        row = worker.result_segment(" Hola ", 1, 5)
        self.assertEqual(row["text"], "Hola")
        self.assertEqual(row["timestampSource"], "audio-window")
        self.assertEqual(row["speakerAttribution"], "unresolved")
        self.assertEqual(row["speakerConfidence"], 0)

    def test_preparation_must_be_complete_no_runtime_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                worker.model_files(root)
            for name in worker.MODEL_FILES:
                (root / name).write_bytes(b"fixture")
            self.assertEqual(len(worker.model_files(root)), 4)
            (root / worker.MODEL_FILES[0]).write_bytes(b"")
            with self.assertRaises(FileNotFoundError):
                worker.model_files(root)

    def test_factories_do_not_choose_cuda_or_load_other_family(self):
        calls = []
        runtime = SimpleNamespace(OfflineRecognizer=SimpleNamespace(
            from_transducer=lambda **kwargs: calls.append(("parakeet", kwargs)),
            from_qwen3_asr=lambda **kwargs: calls.append(("qwen", kwargs))))
        worker.make_recognizer(runtime, worker.MODEL, {x: x for x in worker.MODEL_FILES}, 3)
        worker.make_recognizer(runtime, worker.QWEN_MODEL, {x: x for x in worker.QWEN_FILES}, 2)
        self.assertEqual([call[0] for call in calls], ["parakeet", "qwen"])
        self.assertEqual([call[1]["provider"] for call in calls], ["cpu", "cpu"])
        self.assertEqual(calls[1][1]["max_new_tokens"], 512)
        self.assertEqual(calls[1][1]["num_threads"], 2)

    def test_qwen_missing_runtime_fails_explicitly(self):
        with self.assertRaisesRegex(RuntimeError, "lacks Qwen3"):
            worker.make_recognizer(SimpleNamespace(OfflineRecognizer=object()), worker.QWEN_MODEL, {}, 1)

    @unittest.skipUnless(os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_real_ffmpeg_normalizes_and_removes_disk_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "stereo-48k.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(2)
                audio.setsampwidth(2)
                audio.setframerate(48000)
                audio.writeframes(b"\0" * (48000 * 4))
            with worker.normalized_audio(str(source)) as normalized:
                with wave.open(str(normalized), "rb") as audio:
                    self.assertEqual(audio.getframerate(), 16000)
                    self.assertEqual(audio.getnchannels(), 1)
                    self.assertEqual(audio.getnframes(), 16000)
            self.assertFalse(normalized.exists())


if __name__ == "__main__":
    unittest.main()
