"""Bounded channel-preserving extraction. Input is immutable; no inference here."""
import argparse
import hashlib
import json
import os
import shutil
import struct
from pathlib import Path
import subprocess
import sys
import wave

MAX_SECONDS = 21600


def mpeg_frame_size(data):
    if len(data) < 4 or data[0] != 255 or data[1] & 224 != 224 or data[1] & 6 != 2:
        return None
    version = (data[1] >> 3) & 3
    index = data[2] >> 4
    rate_index = (data[2] >> 2) & 3
    if version == 1 or index in (0, 15) or rate_index == 3:
        return None
    rate = (44100, 48000, 32000)[rate_index] // (1 if version == 3 else 2 if version == 2 else 4)
    table = (0,32,40,48,56,64,80,96,112,128,160,192,224,256,320) if version == 3 else (0,8,16,24,32,40,48,56,64,80,96,112,128,144,160)
    return (144000 if version == 3 else 72000) * table[index] // rate + ((data[2] >> 1) & 1)


def source_payload(source):
    """Bounded RIFF parser; unwrap only proven MPEG, never a lone PCM sync pattern."""
    total = source.stat().st_size
    with source.open('rb') as file:
        head = file.read(12)
        if len(head) < 12:
            raise ValueError('Truncated audio header')
        if head[:4] != b'RIFF' or head[8:] != b'WAVE':
            return None
        declared = struct.unpack_from('<I', head, 4)[0] + 8
        end = declared if 12 <= declared <= total else total
        offset = 12
        for _ in range(4096):
            if offset + 8 > end:
                break
            file.seek(offset); chunk = file.read(8)
            size = struct.unpack_from('<I', chunk, 4)[0]; start = offset + 8
            if chunk[:4] == b'data':
                length = end - start if size in (0, 0xffffffff) else size
                if length < 4 or start + length > end:
                    raise ValueError('Invalid RIFF payload bounds')
                file.seek(start); data = file.read(min(length, 65536))
                skip = 0
                if data[:3] == b'ID3' and len(data) >= 10:
                    if data[3] not in (2,3,4) or any(x >= 128 for x in data[6:10]):
                        raise ValueError('Invalid wrapped ID3 header')
                    skip = 10 + sum(data[6+i] << (21-7*i) for i in range(4))
                    if skip + 4 > length or skip > 1024 * 1024:
                        raise ValueError('Wrapped ID3 tag exceeds bounded probe')
                    file.seek(start + skip); data = file.read(min(length-skip, 65536))
                frame = mpeg_frame_size(data)
                return (start, length) if frame and mpeg_frame_size(data[frame:frame+4]) else None
            if start + size > end:
                raise ValueError('Invalid RIFF chunk bounds')
            offset = start + size + size % 2
        raise ValueError('WAV data chunk unavailable within bounded scan')


def digest(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def split_audio(source, directory, ffmpeg):
    source = Path(source).resolve(strict=True)
    directory = Path(directory).resolve(strict=True)
    if not directory.is_dir() or any(directory.iterdir()):
        raise ValueError('Channel destination must be an empty owned directory')
    before = digest(source)
    payload = source_payload(source)
    # Worst-case two six-hour PCM16/16k tracks, plus an owned compressed payload and 1 GiB headroom.
    required = MAX_SECONDS * 16000 * 2 * 2 + (payload[1] if payload else 0) + 1024 ** 3
    if shutil.disk_usage(directory).free < required:
        raise ValueError('Insufficient temporary disk space for bounded channel extraction')
    decode_source = source
    if payload:
        decode_source = directory / 'mpeg-payload.mp3'
        with source.open('rb') as src, decode_source.open('xb') as target:
            src.seek(payload[0]); remaining = payload[1]
            while remaining:
                data = src.read(min(65536, remaining))
                if not data:
                    raise ValueError('Truncated wrapped MPEG payload')
                target.write(data); remaining -= len(data)
    def decode(target, extra):
        command = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
                   '-i', str(decode_source), '-map', '0:a:0', '-vn', '-filter_threads', '1', '-threads', '1',
                   *extra, '-ar', '16000', '-c:a', 'pcm_s16le', str(target)]
        with (directory / 'decode.log').open('wb') as log:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=log, timeout=120, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise RuntimeError(f'Channel decode failed with exit {result.returncode}')
    probe = directory / 'probe.wav'
    decode(probe, ['-t', '0.01'])
    with wave.open(str(probe)) as audio:
        channels = audio.getnchannels()
    if channels not in (1, 2):
        raise ValueError('Separate ASR accepts mono or stereo audio only')
    tracks = []
    frames = None
    for index in range(channels):
        target = directory / f'channel-{index}.wav'
        decode(target, ['-t', str(MAX_SECONDS + 1), '-af', f'pan=mono|c0=c{index}'])
        with wave.open(str(target)) as audio:
            count = audio.getnframes()
            if audio.getnchannels() != 1 or audio.getframerate() != 16000 or not 0 < count <= MAX_SECONDS * 16000:
                raise ValueError('Invalid or overlong channel audio')
        if frames is not None and count != frames:
            raise ValueError('Decoded channel durations differ')
        frames = count
        tracks.append(str(target))
    if digest(source) != before:
        raise ValueError('Source audio changed during channel extraction')
    return dict(channels=channels, durationSeconds=frames / 16000, sourceSha256=before, tracks=tracks)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--worker-dir', required=True)
    args = parser.parse_args()
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    apply_resource_policy()
    ffmpeg = os.environ.get('FFMPEG_PATH')
    if not ffmpeg:
        raise RuntimeError('Managed FFmpeg is required')
    print(json.dumps(split_audio(args.audio, args.output_dir, ffmpeg), allow_nan=False))
