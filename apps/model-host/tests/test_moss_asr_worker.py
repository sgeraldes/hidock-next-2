"""MOSS output integrity tests; these do not claim CUDA readiness."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from moss_asr_worker import parse_result, generation_finished, diarization_metadata
from prepare_moss_asr import MODEL, REVISION, REQUIRED, validate_checkpoint


class MossTests(unittest.TestCase):
    def test_complete_unlabeled_transcript_preserves_text_without_inventing_identity(self):
        rows = parse_result('[0.1]Hola.[1.2][1.2]Sí, [laughter] gracias.[1.9]', 30, 2, 'window-1')
        self.assertEqual([row['text'] for row in rows], ['Hola.', 'Sí, [laughter] gracias.'])
        self.assertEqual(rows[0]['start'], 30.1)
        for row in rows:
            self.assertNotIn('modelSpeakerLabel', row)
            self.assertNotIn('speakerScope', row)
            self.assertEqual(row['speaker'], 'Speaker unresolved')
            self.assertEqual(row['diarizationStatus'], 'unavailable')
            self.assertEqual(row['speakerConfidence'], 0)
        self.assertEqual(diarization_metadata(rows)['diarizationStatus'], 'degraded')
        self.assertEqual(diarization_metadata(rows)['diarizationUnavailableSegments'], 2)

    def test_unlabeled_partial_mixed_and_invalid_times_rejected(self):
        for text in ('[0]Hola[1] trailing', '[0]unfinished', '[0][S01]Hola[1][1]Sí[2]',
                     '[0]Hola[1][1][S02]Sí[2]', '[0][Sxx]Hola[1]', '[0]Hola[2.1]', '[1]Hola[1]',
                     '[0]Hola[1][unfinished'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_result(text, 0, 2, 'a')

    def test_native_times_and_window_scoped_speakers(self):
        rows = parse_result("[0.1][S01]Hola.[1.2][0.9][S02]Sí.[1.7]", 30, 2, "window-1")
        self.assertEqual([row["start"] for row in rows], [30.1, 30.9])
        self.assertEqual(rows[0]["modelSpeakerLabel"], "S01")
        self.assertEqual(rows[0]["speaker"], "Speaker unresolved")
        self.assertEqual(rows[0]["speakerScope"], "window-1")
        self.assertEqual(rows[0]["timestampSource"], "model")

    def test_annotations_preserved(self):
        self.assertEqual(parse_result("[0][S01][laughter]Hola[1]", 0, 2, "a")[0]["text"],
                         "[laughter]Hola")

    def test_never_silently_drop_malformed_tail(self):
        for text in ("junk[0][S01]Hola[1]", "[0][S01]Hola[1] trailing", "[0][S01]unfinished"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_result(text, 0, 2, "a")

    def test_failure_diagnostics_expose_structure_not_speech(self):
        text = '[0][S01]Valid speech[1][1.1][S02]private unfinished words'
        with self.assertRaises(ValueError) as caught:
            parse_result(text, 0, 2, 'a')
        message = str(caught.exception)
        self.assertNotIn('private', message)
        self.assertNotIn('Valid speech', message)
        details = json.loads(message.split('; structure=', 1)[1])
        self.assertEqual(details['parsedSegments'], 1)
        self.assertEqual(details['tailGrammarMarkers'], ['[1.1]', '[S02]'])
        self.assertEqual(len(details['sha256']), 64)

    def test_invalid_timing_rejected(self):
        for text in ("[0][S01]Hola[2.1]", "[1][S01]Hola[1]", "[2][S01]Hola[1]"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_result(text, 0, 2, "a")

    def test_eos_required(self):
        self.assertFalse(generation_finished([[10, 20, 21]], 1, 99, 0))
        self.assertTrue(generation_finished([[10, 20, 99]], 1, 99, 0))
        self.assertFalse(generation_finished([[10, 99, 20]], 1, 99, 0))

    def test_checkpoint_pinning_and_completeness(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in REQUIRED:
                (root / name).write_text("fixture", encoding="utf-8")
            path = root / "hidock-manifest.json"
            path.write_text(json.dumps({"model": MODEL, "revision": REVISION}), encoding="utf-8")
            self.assertEqual(validate_checkpoint(root)["revision"], REVISION)
            path.write_text(json.dumps({"model": MODEL, "revision": "main"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_checkpoint(root)
            (root / REQUIRED[0]).unlink()
            with self.assertRaises(ValueError):
                validate_checkpoint(root)


if __name__ == "__main__":
    unittest.main()
