import array
import hashlib
import importlib.util
import math
from pathlib import Path
import subprocess
import struct
import tempfile
import unittest
import wave
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('split', Path(__file__).parents[1] / 'src/asr_channel_split.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
FFMPEG = Path(__file__).parents[2] / 'electron/node_modules/ffmpeg-static/ffmpeg.exe'


@unittest.skipUnless(FFMPEG.is_file(), 'Bundled FFmpeg unavailable')
class ChannelSplitTests(unittest.TestCase):
    def test_legacy_riff_mpeg_and_trailer_preserve_actual_stereo_and_duration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for channels in (1, 2):
                audio = root / f'{channels}.mp3'
                subprocess.run([str(FFMPEG), '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'sine=frequency=440:duration=2', '-ac', str(channels), '-b:a', '96k', str(audio)],
                    check=True, timeout=15)
                data = audio.read_bytes()
                # False PCM mono declaration must not override the MPEG stereo header.
                fmt = struct.pack('<HHIIHH', 1, 1, 16000, 32000, 2, 16)
                body = b'WAVEfmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(data)) + data
                wrapped = root / f'{channels}.wav'
                wrapped.write_bytes(b'RIFF' + struct.pack('<I', len(body)) + body + b'HiDock-clock-marker')
                output = root / f'out{channels}'; output.mkdir()
                manifest = module.split_audio(wrapped, output, str(FFMPEG))
                self.assertEqual(manifest['channels'], channels)
                self.assertAlmostEqual(manifest['durationSeconds'], 2, delta=.05)

    def test_low_disk_and_duration_limit_reject_without_large_fixtures(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'mono.wav'
            with wave.open(str(source), 'wb') as audio:
                audio.setparams((1,2,16000,0,'NONE','not compressed')); audio.writeframes(b'\0\0' * 32000)
            output = root / 'out'; output.mkdir()
            with patch.object(module.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 0})()):
                with self.assertRaisesRegex(ValueError, 'disk space'):
                    module.split_audio(source, output, str(FFMPEG))
            with patch.object(module, 'MAX_SECONDS', 1):
                with self.assertRaisesRegex(ValueError, 'overlong'):
                    module.split_audio(source, output, str(FFMPEG))

    def test_malformed_riff_bounds_and_chunk_scan_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'bad.wav'
            source.write_bytes(b'RIFF' + struct.pack('<I', 20) + b'WAVEdata' + struct.pack('<I', 100) + b'12345678')
            with self.assertRaisesRegex(ValueError, 'bounds'): module.source_payload(source)
            body = b'WAVE' + (b'JUNK' + struct.pack('<I', 0)) * 4097
            source.write_bytes(b'RIFF' + struct.pack('<I', len(body)) + body)
            with self.assertRaisesRegex(ValueError, 'bounded scan'): module.source_payload(source)
            # Odd-sized chunks consume their pad byte; a single MPEG-looking PCM value is not proof.
            pcm = b'\xff\xfb\x90\x00' + b'\0' * 1020
            body = b'WAVEJUNK' + struct.pack('<I', 1) + b'x\0data' + struct.pack('<I', len(pcm)) + pcm
            source.write_bytes(b'RIFF' + struct.pack('<I', len(body)) + body)
            self.assertIsNone(module.source_payload(source))

    def test_mono_stays_one_channel_and_multichannel_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for channels in (1, 3):
                source = root / f'{channels}.wav'
                with wave.open(str(source), 'wb') as out:
                    out.setparams((channels, 2, 16000, 0, 'NONE', 'not compressed'))
                    out.writeframes(b'\0\0' * 16000 * channels)
                output = root / f'out-{channels}'; output.mkdir()
                if channels == 1:
                    manifest = module.split_audio(source, output, str(FFMPEG))
                    self.assertEqual(manifest['channels'], 1)
                    self.assertEqual(len(manifest['tracks']), 1)
                else:
                    with self.assertRaises((ValueError, wave.Error)):
                        module.split_audio(source, output, str(FFMPEG))

    def test_real_wav_and_mp3_bitrates_preserve_opposite_phase_channels(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'stereo.wav'
            samples = array.array('h')
            for i in range(32000):
                value = int(12000 * math.sin(i * 2 * math.pi * 440 / 16000))
                samples.extend((value, -value))
            with wave.open(str(source), 'wb') as out:
                out.setparams((2, 2, 16000, 0, 'NONE', 'not compressed')); out.writeframes(samples.tobytes())
            for bitrate in (None, 64, 96, 128, 160):
                with self.subTest(bitrate=bitrate):
                    audio = source
                    if bitrate:
                        audio = root / f'{bitrate}.mp3'
                        subprocess.run([str(FFMPEG), '-loglevel', 'error', '-threads', '1', '-i', str(source),
                            '-codec:a', 'libmp3lame', '-b:a', f'{bitrate}k', str(audio)], check=True, timeout=15)
                    before = module.digest(audio)
                    output = root / f'out-{bitrate}'; output.mkdir()
                    manifest = module.split_audio(audio, output, str(FFMPEG))
                    self.assertEqual(manifest['channels'], 2)
                    self.assertAlmostEqual(manifest['durationSeconds'], 2, delta=.05)
                    channels = []
                    for track in manifest['tracks']:
                        with wave.open(track) as wav:
                            channels.append(array.array('h', wav.readframes(wav.getnframes())))
                    self.assertGreater(sum(v*v for v in channels[0]) / len(channels[0]), 1_000_000)
                    self.assertLess(sum(a*b for a,b in zip(*channels)), 0)
                    self.assertEqual(before, module.digest(audio))


if __name__ == '__main__': unittest.main()
