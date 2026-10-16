"""Native diarization contract checks without GPU, model downloads or Outlook."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).parents[1] / "src" / "nemotron_diarization_worker.py"
spec = importlib.util.spec_from_file_location("nemotron_diarization_worker", source)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
import prepare_nemotron_diarization as preparation


class NativeDiarizationTests(unittest.TestCase):
    def test_native_one_based_ids_keep_overlap_without_fabricated_embeddings(self):
        result = worker.translate_result({"file": "private.wav", "segments": [
            {"start": 2, "end": 4, "speaker": 8},
            {"start": 0, "end": 3, "speaker": 1},
        ]}, 5)
        self.assertEqual(result["segments"][0], {"start": 0, "end": 3, "speaker": "SPEAKER_00"})
        self.assertEqual(result["segments"][1]["speaker"], "SPEAKER_07")
        self.assertEqual(result["speakers"], [])
        self.assertFalse(result["speakerEmbeddingsAvailable"])
        self.assertEqual(result["speakerIdentityScope"], "recording")
        self.assertNotIn("private.wav", json.dumps(result))

    def test_speech_duration_unions_overlapping_ranges(self):
        result = worker.translate_result({"segments": [
            {"start": 0, "end": 3, "speaker": 1},
            {"start": 2, "end": 4, "speaker": 1},
            {"start": 5, "end": 6, "speaker": 1},
        ]}, 6)
        self.assertEqual(result["diarizationSpeakers"], [{"label": "SPEAKER_00", "speechSeconds": 5}])

    def test_empty_audio_activity_is_not_a_fake_speaker(self):
        result = worker.translate_result({"segments": []}, 1)
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["diarizationSpeakers"], [])

    def test_rejects_bad_native_payloads_and_times(self):
        invalid = [None, {}, {"segments": None}, {"segments": [None]}]
        for patch_values in ({"speaker": 0}, {"speaker": 9}, {"speaker": True},
                             {"speaker": "1"}, {"start": -1}, {"start": float("nan")},
                             {"end": float("inf")}, {"end": True}, {"end": 4}, {"end": 0}):
            invalid.append({"segments": [{"start": 0, "end": 1, "speaker": 1, **patch_values}]})
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                worker.translate_result(payload, 3)

    def test_rejects_invalid_duration_before_native_inference(self):
        for duration in (0, -1, float("nan"), float("inf"), 21601):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                worker.translate_result({"segments": []}, duration)

    def test_intersects_only_padded_final_frame_and_preserves_raw_evidence(self):
        result = worker.translate_result({'segments': [{'start': 27.651, 'end': 30.01, 'speaker': 2}]}, 30)
        row = result['segments'][0]
        self.assertEqual(row['start'], 27.651)
        self.assertEqual(row['end'], 30)
        self.assertEqual(row['nativeEnd'], 30.01)
        self.assertEqual(row['timingAdjustment']['reason'], 'padded-final-frame')
        self.assertAlmostEqual(row['timingAdjustment']['endTrimSeconds'], .01)
        self.assertAlmostEqual(result['diarizationSpeakers'][0]['speechSeconds'], 2.349)

    def test_frame_projection_does_not_accept_large_or_wholly_outside_segments(self):
        for start, end in ((29, 30.011), (30, 30.01), (30.001, 30.01), (29, 30.08)):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                worker.translate_result({'segments': [{'start': start, 'end': end, 'speaker': 1}]}, 30)
        row = worker.translate_result({'segments': [{'start': 1, 'end': 2, 'speaker': 1}]}, 30)['segments'][0]
        self.assertNotIn('timingAdjustment', row)
        self.assertEqual(row['end'], 2)

    def test_final_frame_bound_includes_only_cli_millisecond_rounding(self):
        row = worker.translate_result({'segments': [{'start': 29, 'end': 30.0105, 'speaker': 1}]}, 30)['segments'][0]
        self.assertEqual(row['end'], 30)
        with self.assertRaises(ValueError):
            worker.translate_result({'segments': [{'start': 29, 'end': 30.0106, 'speaker': 1}]}, 30)

    def test_bad_segment_diagnostics_keep_bounds_without_private_payload(self):
        with self.assertRaises(ValueError) as caught:
            worker.translate_result({'segments': [{'start': 29.8, 'end': 30.08,
                                                   'speaker': 1, 'text': 'private text'}]}, 30)
        message = str(caught.exception)
        self.assertNotIn('private', message)
        details = json.loads(message.split('diagnostics=', 1)[1])
        self.assertEqual(details['index'], 0)
        self.assertEqual(details['start'], 29.8)
        self.assertEqual(details['end'], 30.08)
        self.assertEqual(details['duration'], 30)
        self.assertAlmostEqual(details['endMinusDuration'], 0.08)
        with self.assertRaises(ValueError) as caught:
            worker.translate_result({'segments': [{'start': float('nan'), 'end': 1,
                                                   'speaker': 'private label'}]}, 30)
        details = json.loads(str(caught.exception).split('diagnostics=', 1)[1])
        self.assertIsNone(details['start'])
        self.assertIsNone(details['speaker'])
        self.assertEqual(details['speakerType'], 'str')

    def test_command_requires_cuda_one_recording_and_chunked_preset(self):
        command = worker.build_command(Path("native.exe"), Path("model.gguf"), Path("audio.wav"))
        self.assertEqual(command[1:3], ["diarize", "audio.wav"])
        for flag, value in (("--device", "cuda:0"), ("--preset", "v3-offline"),
                            ("--format", "json"), ("--concurrency", "1")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertNotIn("--offline", command)
        self.assertIn("--no-batching", command)

    def test_unprepared_runtime_does_not_download(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(preparation, "download") as download:
            with self.assertRaisesRegex(ValueError, "runtime first"):
                preparation.prepare(Path(folder))
            download.assert_not_called()

    def test_manifest_and_weights_must_match_pinned_revision(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model = root / worker.MODEL_FILE
            model.write_bytes(b"fixture")
            executable = root / "native.exe"
            executable.write_bytes(b"exe")
            manifest = {"model": worker.MODEL, "revision": worker.REVISION,
                        "modelSha256": worker.MODEL_SHA, "modelBytes": 7,
                        "runtime": f"NeMo-Speech.cpp/{worker.VERSION}", "provider": "cuda",
                        "executableSha256": "exe-hash"}
            manifest_path = root / "hidock-manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            with patch.object(worker, "MODEL_SIZE", 7), patch.object(worker, "digest") as digest:
                digest.side_effect = lambda path: worker.MODEL_SHA if path == model else "exe-hash"
                self.assertEqual(worker.prepared_model(root, executable), model)
                manifest["revision"] = "unverified"
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "preparation required"):
                    worker.prepared_model(root, executable)


if __name__ == "__main__":
    unittest.main()
