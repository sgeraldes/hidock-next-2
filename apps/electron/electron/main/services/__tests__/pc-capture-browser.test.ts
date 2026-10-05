/** @vitest-environment node */
import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import ts from 'typescript'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { expect, it } from 'vitest'

async function runElectron(folder: string, payload: string, mode?: string): Promise<string> {
  const electron = readFileSync(resolve('node_modules/electron/path.txt'), 'utf8').trim()
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(resolve('node_modules/electron/dist', electron), [
      resolve('scripts/test-pc-capture.cjs'), folder, payload, ...(mode ? [mode] : [])
    ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Chromium test timed out')) }, 25000)
    child.stdout.on('data', data => { output += data.toString() })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); if (code === 0) resolveOutput(output); else reject(new Error(`Electron exited ${code}: ${output}`)) })
  })
}

it('real capture graph and Opus encoder keep mic 400 Hz left and system 1000 Hz right below -30 dB crosstalk, with independent RMS meters', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pc-capture-browser-'))
  try {
    const source = readFileSync(resolve('src/lib/pc-audio-capture.ts'), 'utf8')
    const compiled = ts.transpileModule(source.replace(/^export /gm, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText
    const script = `${compiled}\n(async () => {
      const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
      const sources = [400, 1000].map((frequency, index) => {
        const oscillator = context.createOscillator(); oscillator.frequency.value = frequency;
        const gain = context.createGain(); gain.gain.value = index === 0 ? 0.2 : 0.6;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination); oscillator.start();
        return { oscillator, stream: destination.stream };
      });
      Object.defineProperty(navigator, 'mediaDevices', { value: {
        getUserMedia: async () => sources[0].stream,
        getDisplayMedia: async () => sources[1].stream
      }});
      const chunks = []; const errors = [];
      const capture = new PcAudioCapture({ start: async () => 'test',
        append: async (_id, _index, data) => chunks.push(data), finish: async () => ({ success: true })
      }, message => errors.push(message));
      await capture.start(); await new Promise(resolve => setTimeout(resolve, 2400));
      const levels = capture.levels(); await capture.stop();
      const encoded = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer();
      const decoded = await context.decodeAudioData(encoded);
      const amplitude = (samples, frequency) => {
        const start = Math.round(decoded.sampleRate * 0.3);
        const count = Math.round(decoded.sampleRate);
        let real = 0, imaginary = 0;
        for (let i = 0; i < count; i++) {
          const angle = 2 * Math.PI * frequency * i / decoded.sampleRate;
          real += samples[start + i] * Math.cos(angle);
          imaginary += samples[start + i] * Math.sin(angle);
        }
        return 2 * Math.hypot(real, imaginary) / count;
      };
      const tones = [0, 1].map(channel => [400, 1000].map(f => amplitude(decoded.getChannelData(channel), f)));
      sources.forEach(source => source.oscillator.stop()); await context.close();
      return { channels: decoded.numberOfChannels, duration: decoded.duration, levels, tones, errors };
    })()`
    const payload = join(folder, 'test.js'); writeFileSync(payload, script)
    const stdout = await runElectron(folder, payload)
    const result = JSON.parse(stdout.split('PC_CAPTURE_RESULT=')[1].split('\n')[0])
    console.log('Chromium capture boundary:', JSON.stringify(result))
    expect(result.errors).toEqual([])
    expect(result.channels).toBe(2)
    expect(result.duration).toBeGreaterThan(1.5)
    // A 256-sample window need not contain an integer number of periods.
    expect(Math.abs(result.levels[0] - 0.2 / Math.sqrt(2))).toBeLessThan(0.01)
    expect(Math.abs(result.levels[1] - 0.6 / Math.sqrt(2))).toBeLessThan(0.02)
    expect(result.tones[0][0]).toBeGreaterThan(0.15)
    expect(result.tones[1][1]).toBeGreaterThan(0.5)
    expect(20 * Math.log10(result.tones[0][1] / result.tones[0][0])).toBeLessThan(-30)
    expect(20 * Math.log10(result.tones[1][0] / result.tones[1][1])).toBeLessThan(-30)
  } finally { rmSync(folder, { recursive: true }) }
}, 30000)

it('renders the real recording bar with visible light/dark meters and exercises saved, Open, timeout and dismiss in Chromium', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pc-recorder-ui-'))
  try {
    const bundled = await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { MemoryRouter, useLocation } from 'react-router-dom';
      import { RecordingBar } from './src/components/layout/PcRecording';
      import { usePcRecorderStore } from './src/store/usePcRecorderStore';
      function Location() { return <output id="location">{useLocation().pathname}</output> }
      window.recorderStore = usePcRecorderStore;
      window.savedChunks = []; window.finishCalls = 0;
      window.electronAPI = { pcRecorder: { start: async () => 'ui-test', append: async (_id, _index, data) => window.savedChunks.push(data),
        finish: async () => { window.finishCalls++; return { success: true } } } };
      createRoot(document.body).render(<MemoryRouter><RecordingBar/><Location/></MemoryRouter>);
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"' } })
    const css = await postcss([tailwind()]).process(readFileSync(resolve('src/index.css'), 'utf8'), { from: resolve('src/index.css') })
    const meterReport = `
      const meters = [...document.querySelectorAll('[role="meter"]')].map(meter => ({
        label: meter.getAttribute('aria-label'), level: Number(meter.getAttribute('aria-valuenow')),
        track: getComputedStyle(meter).backgroundColor, fill: getComputedStyle(meter.firstElementChild).backgroundColor,
        width: meter.getBoundingClientRect().width, filled: meter.firstElementChild.getBoundingClientRect().width
      })); return { theme: document.documentElement.className || 'light', meters };`
    const scripts = [
      `(async () => { document.head.innerHTML = '<style>' + ${JSON.stringify(css.css)} + '</style>'; ${bundled.outputFiles[0].text}
        const context = new AudioContext(); await context.resume(); window.toneContext = context;
        const streams = [400, 1000].map((frequency, index) => {
          const oscillator = context.createOscillator(); oscillator.frequency.value = frequency;
          const gain = context.createGain(); gain.gain.value = (index === 0 ? 0.2 : 0.4) * Math.sqrt(2);
          const destination = context.createMediaStreamDestination(); oscillator.connect(gain).connect(destination); oscillator.start();
          return destination.stream;
        });
        Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => streams[0], getDisplayMedia: async () => streams[1] } });
        window.recorderStore.getState().open(); await new Promise(resolve => setTimeout(resolve, 50));
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Record').click();
        await new Promise(resolve => setTimeout(resolve, 500)); ${meterReport} })()`,
      `(async () => { document.documentElement.className = 'dark'; await new Promise(resolve => setTimeout(resolve, 100)); ${meterReport} })()`,
      `(async () => {
        document.querySelector('[aria-label="Dismiss recording bar"]').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const dismissed = !document.querySelector('[aria-label="PC recording"]');
        const continuedRecording = window.recorderStore.getState().status === 'recording' && window.finishCalls === 0;
        window.recorderStore.getState().open();
        await new Promise(resolve => setTimeout(resolve, 50));
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop').click();
        for (let i = 0; i < 50 && window.recorderStore.getState().status !== 'saved'; i++) await new Promise(resolve => setTimeout(resolve, 20));
        const saved = document.body.textContent.includes('Saved to Library');
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Open').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const opened = document.querySelector('#location').textContent;
        await new Promise(resolve => setTimeout(resolve, 5100));
        await window.toneContext.close();
        return { dismissed, continuedRecording, saved, opened, imported: window.finishCalls === 1 && window.savedChunks.length > 0,
          hidden: !document.querySelector('[aria-label="PC recording"]'),
          status: window.recorderStore.getState().status, elapsed: window.recorderStore.getState().elapsed };
      })()`
    ]
    const payload = join(folder, 'ui.json'); writeFileSync(payload, JSON.stringify(scripts))
    const stdout = await runElectron(folder, payload, 'ui-stages')
    const result = JSON.parse(stdout.split('PC_CAPTURE_RESULT=')[1].split('\n')[0])
    console.log('Chromium recording UI:', JSON.stringify(result))
    for (const theme of result.slice(0, 2)) {
      expect(theme.meters).toHaveLength(2)
      for (const [index, meter] of theme.meters.entries()) {
        expect(meter.width).toBeGreaterThan(50)
        expect(meter.level).toBeCloseTo(index === 0 ? 0.2 : 0.4, 1)
        expect(meter.filled / meter.width).toBeCloseTo(meter.level, 2)
        expect(meter.fill).not.toBe(meter.track)
      }
    }
    expect(result[0].meters[0].fill).not.toBe(result[1].meters[0].fill)
    expect(result[2]).toEqual({ dismissed: true, continuedRecording: true, saved: true, imported: true, opened: '/library', hidden: true, status: 'idle', elapsed: 0 })
    // Preserve a single bounded inspection run when explicitly requested.
    if (process.env.PC_RECORDER_UI_ARTIFACTS) {
      const { copyFileSync, mkdirSync } = await import('fs')
      mkdirSync(process.env.PC_RECORDER_UI_ARTIFACTS, { recursive: true })
      for (const index of [0, 1]) copyFileSync(join(folder, `stage-${index}.png`), join(process.env.PC_RECORDER_UI_ARTIFACTS, `stage-${index}.png`))
    }
  } finally { rmSync(folder, { recursive: true }) }
}, 30000)
