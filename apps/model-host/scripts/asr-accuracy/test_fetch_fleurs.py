"""Validate corpus framing without downloading or decoding audio."""
import struct
import unittest

from fetch_fleurs import wav_frames


class WavMetadataTests(unittest.TestCase):
    def fixture(self, encoding=3, bits=32):
        alignment = bits // 8
        fmt = struct.pack('<HHIIHH', encoding, 1, 16000, 16000 * alignment, alignment, bits)
        body = b'WAVEfmt ' + struct.pack('<I', len(fmt)) + fmt
        body += b'data' + struct.pack('<I', alignment * 80) + bytes(alignment * 80)
        return b'RIFF' + struct.pack('<I', len(body)) + body

    def test_float32_and_pcm_preserve_frame_count(self):
        self.assertEqual(wav_frames(self.fixture()), 80)
        self.assertEqual(wav_frames(self.fixture(1, 16)), 80)

    def test_truncation_and_invalid_float_width_rejected(self):
        with self.assertRaises(ValueError): wav_frames(self.fixture()[:-1])
        with self.assertRaises(ValueError): wav_frames(self.fixture(3, 16))


if __name__ == '__main__':
    unittest.main()
