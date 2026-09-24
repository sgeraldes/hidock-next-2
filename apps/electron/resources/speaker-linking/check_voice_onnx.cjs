// Runs the exported voice models on CPU and DirectML with the app's own
// onnxruntime-node, and says how fast they are and whether both agree.
//
//   node resources/speaker-linking/check_voice_onnx.cjs <models folder> <audio.f32>
//
// <audio.f32>: 16 kHz mono float32 PCM, at least 60 s, e.g.
//   ffmpeg -ss 600 -t 60 -i recording.wav -ac 1 -ar 16000 -f f32le audio.f32
// Measured 24-sep-2026 on an RX 6600 XT: embeddings 0.6 ms per second of audio
// on DirectML (CPU 5.7 ms), segmentation 1.6 ms on CPU (DirectML 4.0 ms).
const fs = require('fs')
const path = require('path')
const ort = require('onnxruntime-node')

const [dir, pcm] = process.argv.slice(2)
const raw = fs.readFileSync(pcm)
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
const SR = 16000
const cosine = (a, b) => {
  let d = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2 }
  return d / Math.sqrt(x * y)
}

async function run(file, makeInput, outputName) {
  const results = {}
  for (const ep of ['cpu', 'dml']) {
    try {
      const session = await ort.InferenceSession.create(path.join(dir, file), { executionProviders: [ep] })
      await session.run(makeInput(0)) // warm-up (DirectML compiles here)
      const start = performance.now()
      const outputs = []
      for (let i = 0; i < 6; i++) outputs.push(Array.from((await session.run(makeInput(i)))[outputName].data))
      const ms = performance.now() - start
      results[ep] = outputs
      console.log(`${file} ${ep}: ${(ms / 60).toFixed(1)} ms per second of audio`)
    } catch (e) {
      console.log(`${file} ${ep}: failed: ${String(e.message).slice(0, 200)}`)
    }
  }
  if (results.cpu && results.dml) {
    console.log(`${file} cpu vs dml cosine per segment: ${results.cpu.map((o, i) => cosine(o, results.dml[i]).toFixed(5)).join(' ')}`)
  }
}

;(async () => {
  const chunk = (i) => audio.slice(i * 10 * SR, (i + 1) * 10 * SR)
  await run('wespeaker-resnet34-lm.onnx', (i) => ({ waveforms: new ort.Tensor('float32', chunk(i), [1, 10 * SR]) }), 'embeddings')
  await run('segmentation-3.0.onnx', (i) => ({ waveforms: new ort.Tensor('float32', chunk(i), [1, 1, 10 * SR]) }), 'activations')
})()
