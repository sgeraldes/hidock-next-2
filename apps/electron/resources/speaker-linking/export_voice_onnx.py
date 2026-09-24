"""Export the voice models of pyannote 3.1 to ONNX, for the onnx-local speaker engine.

Run with the speaker-linking Python environment (pyannote.audio 4.x, torch, onnx,
onnxruntime), with the models already in the Hugging Face cache:

    <venv>/python export_voice_onnx.py <output folder>

Writes wespeaker-resnet34-lm.onnx (speaker embeddings, 256-d, the space the voice
library is built in) and segmentation-3.0.onnx (who speaks when), and checks both
against PyTorch on the same audio. Measured 24-sep-2026: embeddings cosine 1.000000,
segmentation max difference 2e-5; on an RX 6600 XT through DirectML the embedder
runs at 0.6 ms per second of audio (CPU 5.7 ms).

Two things the plain export does not survive, and how this file gets around them:
- pyannote computes Kaldi filterbank features inside forward(); neither exporter
  converts them, so KaldiFbank rebuilds them from plain ops (framing, DC removal,
  pre-emphasis, Hamming window, a 512-point DFT as matrix products, torchaudio's own
  mel matrix, log, mean centring).
- unfold() does not export with a dynamic length; framing gathers sample indices
  instead (a conv1d with an identity kernel exports too, but DirectML rejects it).
"""

import math
import os
import sys

import numpy as np
import torch
import torchaudio.compliance.kaldi as kaldi

os.environ.setdefault('HF_HUB_OFFLINE', '1')
from pyannote.audio import Model  # noqa: E402

out_dir = sys.argv[1]
model = Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM').eval()
hp = model.hparams
assert hp.fbank_centering_span is None and hp.dither == 0.0 and hp.snip_edges and hp.round_to_power_of_two
assert hp.window_type == 'hamming' and not hp.use_energy and hp.num_mel_bins == 80

SR = 16000
WIN = int(SR * hp.frame_length / 1000)   # 400
HOP = int(SR * hp.frame_shift / 1000)    # 160
NFFT = 512
BINS = NFFT // 2 + 1


class KaldiFbank(torch.nn.Module):
    """torchaudio.compliance.kaldi.fbank with the defaults WeSpeaker uses, as plain ops."""

    def __init__(self):
        super().__init__()
        n = torch.arange(WIN, dtype=torch.float64)
        window = 0.54 - 0.46 * torch.cos(2 * math.pi * n / (WIN - 1))
        k = torch.arange(BINS, dtype=torch.float64)
        t = torch.arange(NFFT, dtype=torch.float64)
        angle = 2 * math.pi * torch.outer(t, k) / NFFT
        self.register_buffer('window', window.float())
        self.register_buffer('cos', torch.cos(angle).float())
        self.register_buffer('sin', torch.sin(angle).float())
        banks, _ = kaldi.get_mel_banks(hp.num_mel_bins, NFFT, float(SR), 20.0, 0.0, 100.0, -500.0, 1.0)
        banks = torch.nn.functional.pad(banks, (0, 1))  # 256 -> 257 bins, like kaldi.fbank
        self.register_buffer('banks', banks.float().t())  # (257, 80)
        # Offsets of one frame; each frame's start is added at run time.
        self.register_buffer('offsets', torch.arange(WIN).unsqueeze(0))  # (1, 400)

    def forward(self, wave):  # (batch, samples), already scaled by 2**15
        # Framing as a gather of sample indices: exports for any length and runs on
        # DirectML. (An identity-kernel conv1d also exported, but DirectML rejects
        # it with "The parameter is incorrect" at the batch sizes pyannote uses.)
        count = (wave.shape[1] - WIN) // HOP + 1
        starts = torch.arange(count, device=wave.device).unsqueeze(1) * HOP  # (T, 1)
        frames = wave[:, starts + self.offsets]                             # (B, T, 400)
        frames = frames - frames.mean(dim=2, keepdim=True)                  # remove DC
        prev = torch.cat([frames[:, :, :1], frames[:, :, :-1]], dim=2)
        frames = frames - 0.97 * prev                                       # pre-emphasis
        frames = frames * self.window
        frames = torch.nn.functional.pad(frames, (0, NFFT - WIN))
        re = frames @ self.cos
        im = frames @ self.sin
        power = re * re + im * im                                           # (B, T, 257)
        mel = power @ self.banks                                            # (B, T, 80)
        eps = torch.finfo(torch.float32).eps
        logmel = torch.log(torch.clamp(mel, min=eps))
        return logmel - logmel.mean(dim=1, keepdim=True)                    # centring


class Embedder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.fbank = KaldiFbank()
        self.resnet = m.resnet
        self.register_buffer('scale', torch.tensor(32768.0, dtype=torch.float32))

    def forward(self, waveforms):  # (batch, samples) float32 in [-1, 1] at 16 kHz
        feats = self.fbank(waveforms * self.scale)
        return self.resnet(feats)[1]


def pyannote_fbank(x):
    return model.compute_fbank(x.unsqueeze(1))


emb = Embedder(model).eval()
torch.manual_seed(0)
for secs in (3, 9):
    x = torch.randn(1, SR * secs) * 0.05
    with torch.inference_mode():
        a = pyannote_fbank(x)
        b = emb.fbank(x * 32768.0)
        ra = model(x.unsqueeze(1))
        rb = emb(x)
    print(f'{secs}s fbank frames {tuple(a.shape)} vs {tuple(b.shape)}; max abs diff {float((a - b).abs().max()):.5f}')
    cos = float(torch.nn.functional.cosine_similarity(ra, rb).item())
    print(f'{secs}s embedding cosine(pyannote, rebuilt) = {cos:.6f}')

path = os.path.join(out_dir, 'wespeaker-resnet34-lm.onnx')
x = torch.randn(1, SR * 5) * 0.05
torch.onnx.export(emb, (x,), path, input_names=['waveforms'], output_names=['embeddings'],
                  dynamic_axes={'waveforms': {0: 'batch', 1: 'samples'}, 'embeddings': {0: 'batch'}},
                  opset_version=17, dynamo=False)
print('exported', path, round(os.path.getsize(path) / 1e6, 1), 'MB')

import onnxruntime as ort  # noqa: E402

sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
for secs in (4, 15):
    xa = (np.random.randn(1, SR * secs) * 0.05).astype(np.float32)
    with torch.inference_mode():
        ref = model(torch.from_numpy(xa).unsqueeze(1)).numpy()
    got = sess.run(None, {'waveforms': xa})[0]
    cos = float((ref * got).sum() / (np.linalg.norm(ref) * np.linalg.norm(got)))
    print(f'{secs}s ONNX (cpu) vs pyannote embedding cosine = {cos:.6f}')

# --- segmentation-3.0 ---

seg_model = Model.from_pretrained('pyannote/segmentation-3.0').eval()
print('seg_model class:', type(seg_model).__name__, '| receptive chunk:', getattr(seg_model.specifications, 'duration', None), 's')

x = torch.randn(1, 1, 16000 * 10) * 0.05
with torch.inference_mode():
    ref = seg_model(x)
print('torch output shape:', tuple(ref.shape))

path = os.path.join(out_dir, 'segmentation-3.0.onnx')
torch.onnx.export(seg_model, (x,), path, input_names=['waveforms'], output_names=['activations'],
                  dynamic_axes={'waveforms': {0: 'batch', 2: 'samples'}, 'activations': {0: 'batch', 1: 'frames'}},
                  opset_version=17, dynamo=False)
print('exported', path, round(os.path.getsize(path) / 1e6, 1), 'MB')


sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
xa = (np.random.randn(1, 1, 16000 * 10) * 0.05).astype(np.float32)
with torch.inference_mode():
    r = seg_model(torch.from_numpy(xa)).numpy()
o = sess.run(None, {'waveforms': xa})[0]
print('shapes', r.shape, o.shape, '| max abs diff', float(np.abs(r - o).max()))

# --- the embedder as the diarization pipeline calls it: with per-frame masks ---
#
# pyannote 3.1 embeds each (chunk, local speaker) pair by passing the whole chunk
# and that speaker's activity as `weights` to the statistics pooling. The export
# above has no mask, so it only reproduces whole-clip embeddings. This one takes
# the same (waveforms, weights) the pipeline passes to `_embedding.model_`.


class MaskedEmbedder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.fbank = KaldiFbank()
        self.resnet = m.resnet
        self.register_buffer('scale', torch.tensor(32768.0, dtype=torch.float32))

    def forward(self, waveforms, weights):  # (batch, samples), (batch, mask frames)
        feats = self.fbank(waveforms * self.scale)
        return self.resnet(feats, weights=weights)[1]


masked = MaskedEmbedder(model).eval()
path = os.path.join(out_dir, 'wespeaker-resnet34-lm-masked.onnx')
x = torch.randn(2, SR * 10) * 0.05
w = (torch.rand(2, 589) > 0.4).float()
torch.onnx.export(masked, (x, w), path, input_names=['waveforms', 'weights'], output_names=['embeddings'],
                  dynamic_axes={'waveforms': {0: 'batch', 1: 'samples'}, 'weights': {0: 'batch', 1: 'mask_frames'},
                                'embeddings': {0: 'batch'}},
                  opset_version=17, dynamo=False)
print('exported', path, round(os.path.getsize(path) / 1e6, 1), 'MB')

sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
for trial in range(3):
    xa = (np.random.randn(3, SR * 10) * 0.05).astype(np.float32)
    wa = (np.random.rand(3, 589) > 0.3 + 0.2 * trial).astype(np.float32)
    with torch.inference_mode():
        ref = model(torch.from_numpy(xa).unsqueeze(1), weights=torch.from_numpy(wa)).numpy()
    got = sess.run(None, {'waveforms': xa, 'weights': wa})[0]
    cos = min(float((r * g).sum() / (np.linalg.norm(r) * np.linalg.norm(g))) for r, g in zip(ref, got))
    print(f'masked trial {trial}: worst cosine vs pyannote = {cos:.6f}')
