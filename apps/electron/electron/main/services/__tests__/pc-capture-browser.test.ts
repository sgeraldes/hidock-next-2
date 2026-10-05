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
import { scoreMeetingCandidates } from '../recording-match-scoring'

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
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta': '{"env":{"DEV":false,"PROD":true}}' } })
    expect(bundled.warnings).toEqual([])
    const css = await postcss([tailwind()]).process(readFileSync(resolve('src/index.css'), 'utf8'), { from: resolve('src/index.css') })
    const meterReport = `
      // Wait for actual analyser data and its rendered fill, rather than a fixed delay.
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const nodes = [...document.querySelectorAll('[role="meter"]')];
        ready = nodes.length === 2 && nodes.every(meter => {
          const level = Number(meter.getAttribute('aria-valuenow'));
          const width = meter.getBoundingClientRect().width;
          const filled = meter.firstElementChild.getBoundingClientRect().width;
          return level > 0.1 && width > 50 && Math.abs(filled / width - level) < 0.005;
        });
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!ready) throw new Error('Recording analyser data/rendered meter did not become ready');
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


it('recording detail decodes headerless stereo, shows lanes and failure, and mutes the real playback graph in Chromium', async () => {
  const best = scoreMeetingCandidates({ dateRecorded: '2026-10-05T10:20:00Z', durationSeconds: 600, contentText: 'Belcorp' }, [
    { meetingId: 'credible', subject: 'Retro Belcorp', startTime: '2026-10-05T09:00:00Z', endTime: '2026-10-05T10:00:00Z' }
  ])[0]
  expect(best).toMatchObject({ confidenceScore: 0.48, isBestMatch: true })
  const folder = mkdtempSync(join(tmpdir(), 'pc-detail-ui-'))
  try {
    const bundled = await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { SourceReader } from './src/features/library/components/SourceReader';
      import { useAudioPlayback } from './src/hooks/useAudioPlayback';
      import { useUIStore } from './src/store/useUIStore';
      import { connectStereoPlayback } from './src/lib/stereo-playback';
      window.uiStore = useUIStore; window.connectStereoPlayback = connectStereoPlayback;
      window.cacheEntry = null; window.retries = 0;
      window.electronAPI = { storage: { readRecording: async () => ({success: true, data: window.mediaBase64}) },
        waveform: { getCache: async () => window.cacheEntry, setCache: async (_id, peaks, duration, _size, channels) => { window.cacheEntry = {peaks, duration, channels}; return true } },
        recordings: { updateDuration: async () => ({success: true}), getCandidates: async () => ({success: true, data: [
          {meetingId:'weak',subject:'Colegio',confidenceScore:0.05}, {meetingId:'credible',subject:'Retro Belcorp',confidenceScore:${best.confidenceScore},isBestMatch:${best.isBestMatch}}
        ]}) }, projects: { getForKnowledge: async () => ({success:true,data:[]}) } };
      const recording = { id: 'detail', filename:'Recording 2026-10-05 01-30 12345678-1234-1234-1234-123456789abc.webm', localPath:'/Recording 2026-10-05 01-30 12345678-1234-1234-1234-123456789abc.webm', location:'local-only',
        size:1024, duration:0, dateRecorded:new Date(), transcriptionStatus:'error', transcriptionError:'Provider timed out', syncStatus:'synced' };
      window.detailTranscript = undefined;
      function Detail() { useAudioPlayback(); return <SourceReader recording={recording} transcript={window.detailTranscript} onPlay={() => window.__audioControls.play('detail',recording.localPath)}
        onStop={() => window.__audioControls.stop()} onTranscribe={() => window.retries++}/> }
      window.renderDetail = () => window.root.render(<Detail/>);
      window.mountDetail = () => { window.root = createRoot(document.body); window.root.render(<Detail/>); };
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
      alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta': '{"env":{"DEV":false,"PROD":true}}' } })
    expect(bundled.warnings).toEqual([])
    const css = await postcss([tailwind()]).process(readFileSync(resolve('src/index.css'), 'utf8'), { from: resolve('src/index.css') })
    const script = `(async () => {
      document.head.innerHTML = '<style>' + ${JSON.stringify(css.css)} + '</style>'; ${bundled.outputFiles[0].text}
      const context = new AudioContext({sampleRate:48000}); await context.resume();
      const merger = context.createChannelMerger(2); const destination = context.createMediaStreamDestination(); merger.connect(destination);
      const sources = [400,1000].map((frequency,channel) => { const oscillator=context.createOscillator(); oscillator.frequency.value=frequency;
        const gain=context.createGain(); gain.gain.value=channel ? 0.6 : 0.2; oscillator.connect(gain).connect(merger,0,channel); oscillator.start(); return oscillator; });
      const chunks=[]; const recorder=new MediaRecorder(destination.stream,{mimeType:'audio/webm;codecs=opus'});
      recorder.ondataavailable=event=>chunks.push(event.data); recorder.start(100);
      await new Promise(resolve=>setTimeout(resolve,2200)); await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop()});
      const encoded=await new Blob(chunks).arrayBuffer();
      window.mediaBase64=btoa(String.fromCharCode(...new Uint8Array(encoded)));
      const decoded=await context.decodeAudioData(encoded.slice(0));
      window.mountDetail(); await new Promise(resolve=>setTimeout(resolve,50));
      await window.__audioControls.loadWaveformOnly('detail','/Recording 2026-10-05 01-30 12345678-1234-1234-1234-123456789abc.webm');
      for(let i=0;i<100 && !document.querySelector('[data-testid="stereo-lanes"]');i++) await new Promise(resolve=>setTimeout(resolve,20));
      const lanes=[...document.querySelectorAll('[data-channel]')].map(lane=>({channel:lane.getAttribute('data-channel'), label:lane.textContent, canvas:!!lane.querySelector('canvas')}));
      const text=document.body.textContent;
      const before={lanes, sentimentPanel:!!document.querySelector('[data-testid="sentiment-panel"]'), muteIcon:!!document.querySelector('[aria-label="Mute Mic"] svg'), stereo:text.includes('Stereo · Mic left · System right'), failure:text.includes('Failed: Provider timed out'),
        retry:[...document.querySelectorAll('button')].some(b=>b.textContent==='Retry'), idleStop:[...document.querySelectorAll('button')].some(b=>b.textContent==='Stop'),
        weakCandidate:text.includes('Colegio'), credibleCandidate:text.includes('Retro Belcorp'), duration:window.uiStore.getState().waveformDuration,
        peaks:window.cacheEntry.channels.map(peaks=>Math.max(...peaks))};
      window.detailTranscript = {id:'t',recording_id:'detail',full_text:'Belcorp retrospective discussion'};
      window.renderDetail(); await new Promise(resolve=>setTimeout(resolve,100));
      const manualSuggestions = document.body.textContent.includes('Retro Belcorp · 48%') && document.body.textContent.includes('Colegio · 5%');
      const heldSuggestions = [];
      for (const validity_status of ['invalid','incomplete','doubtful']) {
        window.detailTranscript = {...window.detailTranscript,validity_status}; window.renderDetail();
        await new Promise(resolve=>setTimeout(resolve,50));
        heldSuggestions.push(document.querySelectorAll('[data-testid="meeting-candidate-chip"]').length);
      }
      window.detailTranscript = undefined; window.renderDetail(); await new Promise(resolve=>setTimeout(resolve,50));
      document.querySelector('[aria-label="Mute Mic"]').click(); await new Promise(resolve=>setTimeout(resolve,30));
      const mutedBeforePlay=window.uiStore.getState().playbackMutedChannels;
      const assignedTimes=[]; const nativeTime=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...nativeTime,set(value){
        window.playbackElement=this; assignedTimes.push({value, duration:String(this.duration),readyState:this.readyState}); nativeTime.set.call(this,value);
      }});
      await window.__audioControls.play('detail','/Recording 2026-10-05 01-30 12345678-1234-1234-1234-123456789abc.webm',0.25); await new Promise(resolve=>setTimeout(resolve,200));
      const during={duration:window.uiStore.getState().playbackDuration, nativeDuration:String(window.playbackElement.duration), playing:window.uiStore.getState().isPlaying,
        mutedLabel:!!document.querySelector('[aria-label="Unmute Mic"]')};
      window.__audioControls.pause(); await new Promise(resolve=>setTimeout(resolve,30));
      const pausedStop=[...document.querySelectorAll('button')].some(b=>b.textContent==='Stop');
      const seekErrors=[]; for(const time of [NaN,Infinity,-Infinity,-5,999,0.5]) {
        try { window.__audioControls.seek(time); } catch(error) { seekErrors.push(String(error)); }
      }
      window.__audioControls.resume(); await new Promise(resolve=>setTimeout(resolve,80));
      const resumed=window.uiStore.getState().isPlaying;
      window.__audioControls.stop();
      // Exercise the exact production splitter/gain graph with decoded WebM PCM in an OfflineAudioContext.
      const renders=[];
      for(const mute of [null,0,1]) { const offline=new OfflineAudioContext(2,decoded.length,decoded.sampleRate);
        const source=offline.createBufferSource(); source.buffer=decoded;
        const graph=window.connectStereoPlayback(offline,source,offline.destination); if(mute!==null) graph.setMuted(mute,true);
        source.start(); const result=await offline.startRendering(); renders.push([0,1].map(ch=>{const samples=result.getChannelData(ch);return Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length)})); graph.disconnect(); }
      sources.forEach(source=>source.stop()); destination.stream.getTracks().forEach(track=>track.stop()); await context.close();
      await new Promise(resolve=>setTimeout(resolve,450));
      const player=document.querySelector('[data-testid="waveform-player-full"]');
      const transportVisible=player.getBoundingClientRect().bottom <= player.parentElement.parentElement.getBoundingClientRect().bottom + 1;
      [...document.querySelectorAll('button')].find(button=>button.textContent==='Retry').click();
      Object.defineProperty(HTMLMediaElement.prototype,'currentTime',nativeTime);
      return {before, assignedTimes, seekErrors, resumed, manualSuggestions, heldSuggestions, during, mutedBeforePlay, pausedStop, renders, decodedDuration:decoded.duration, transportVisible, retries:window.retries};
    })()`
    const compactScript = `(async () => {
      document.documentElement.className='dark'; document.querySelector('[aria-label="Minimize Player"]').click();
      await new Promise(resolve=>setTimeout(resolve,450));
      const player=document.querySelector('[data-testid="waveform-player-pill"]');
      return {height:player.getBoundingClientRect().height, lanes:player.querySelectorAll('canvas').length,
        mic:player.textContent.includes('Mic'), system:player.textContent.includes('System')};
    })()`
    const payload = join(folder, 'detail.json'); writeFileSync(payload, JSON.stringify([script,compactScript,`(async () => {
      document.documentElement.className=''; document.querySelector('[aria-label="Expand Player"]').click();
      await new Promise(resolve=>setTimeout(resolve,450)); return {expanded:!!document.querySelector('[data-testid="waveform-player-full"]')};
    })()`]))
    const stdout = await runElectron(folder, payload, 'ui-stages')
    const reports = JSON.parse(stdout.split('PC_CAPTURE_RESULT=')[1].split('\n')[0]); const result = reports[0]
    console.log('Chromium recording detail:', JSON.stringify(reports))
    expect(reports[1]).toMatchObject({height:32, lanes:2, mic:true, system:true})
    expect(reports[2]).toEqual({expanded:true})
    expect(result.before.lanes).toHaveLength(2)
    expect(result.before).toMatchObject({sentimentPanel:false,muteIcon:true})
    expect(result.seekErrors).toEqual([])
    const nativeDuration = Number(result.assignedTimes[2].duration)
    expect(result.assignedTimes.map((entry: {value:number}) => entry.value)).toEqual([
      0.25,0,Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : result.decodedDuration,0.5
    ])
    expect(result.assignedTimes[0]).toMatchObject({duration:'Infinity'})
    expect(result.resumed).toBe(true)
    expect(result.before.lanes.every((lane: {canvas: boolean}) => lane.canvas)).toBe(true)
    expect(result.manualSuggestions).toBe(true)
    expect(result.heldSuggestions).toEqual([0,0,0])
    expect(result.before).toMatchObject({stereo:true,failure:true,retry:true,idleStop:false,weakCandidate:false,credibleCandidate:false})
    expect(result.before.duration).toBeGreaterThan(1.5)
    // Opus uses 20 ms frames (960 samples at 48 kHz); resampling can
    // round the final PCM sample. Bound decoded duration drift to one frame.
    expect(Math.abs(result.before.duration - result.decodedDuration)).toBeLessThanOrEqual(960 / 48000)
    expect(result.transportVisible).toBe(true)
    expect(result.retries).toBe(1)
    expect(result.before.peaks[1]).toBeGreaterThan(result.before.peaks[0] * 2)
    const duringNativeDuration = Number(result.during.nativeDuration)
    expect(result.during.duration).toBe(Number.isFinite(duringNativeDuration) && duringNativeDuration > 0 ? duringNativeDuration : result.before.duration)
    expect(result.during).toMatchObject({playing:true,mutedLabel:true})
    expect(result.mutedBeforePlay).toEqual([true,false])
    expect(result.pausedStop).toBe(false)
    expect(result.renders[1][0]).toBe(0); expect(result.renders[1][1]).toBeCloseTo(result.renders[0][1],5)
    expect(result.renders[2][1]).toBe(0); expect(result.renders[2][0]).toBeCloseTo(result.renders[0][0],5)
    if (process.env.PC_RECORDER_UI_ARTIFACTS) {
      const {copyFileSync,mkdirSync} = await import('fs'); mkdirSync(process.env.PC_RECORDER_UI_ARTIFACTS,{recursive:true})
      copyFileSync(join(folder,'stage-2.png'),join(process.env.PC_RECORDER_UI_ARTIFACTS,'detail.png'))
      copyFileSync(join(folder,'stage-1.png'),join(process.env.PC_RECORDER_UI_ARTIFACTS,'detail-dark-compact.png'))
    }
  } finally { rmSync(folder, { recursive: true }) }
}, 30000)

for (const failureAfter of [700, 1700]) {
  it(`real Chromium encoder error at ${failureAfter} ms imports the terminal chunk after stop`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pc-encoder-error-'))
    try {
      const compiled = ts.transpileModule(readFileSync(resolve('src/lib/pc-audio-capture.ts'), 'utf8').replace(/^export /gm, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
      }).outputText
      const payload = join(folder, 'error.js')
      writeFileSync(payload, compiled + `\n(async()=>{
 const context=new AudioContext();await context.resume();
 const sources=[400,1000].map(f=>{const osc=context.createOscillator();osc.frequency.value=f;const dest=context.createMediaStreamDestination();osc.connect(dest);osc.start();return {osc,stream:dest.stream}});
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>sources[0].stream,getDisplayMedia:async()=>sources[1].stream}});
 const RealRecorder=MediaRecorder;let media;
 window.MediaRecorder=class extends RealRecorder{constructor(...args){super(...args);media=this;}};
 const events=[],chunks=[],errors=[];let imported=false,finishBytes=0;
 const capture=new PcAudioCapture({start:async()=>'test',append:async(_id,index,data)=>{events.push(['append',index,data.length,imported]);if(imported)throw new Error('Unknown recording owner');chunks.push(data)},finish:async()=>{events.push(['finish']);finishBytes=chunks.reduce((n,c)=>n+c.length,0);imported=true;return {success:true}}},e=>{errors.push(e);events.push(['fail',e])});
 await capture.start();
 media.addEventListener('dataavailable',e=>events.push(['dataavailable',e.data.size]));
 media.addEventListener('error',e=>events.push(['error',e.error.name]));
 media.addEventListener('stop',()=>events.push(['stop']));
 await new Promise(r=>setTimeout(r,${failureAfter}));
 media.stream.removeTrack(media.stream.getAudioTracks()[0]);
 await new Promise(r=>setTimeout(r,1400));
 let stopError;try{await capture.stop()}catch(e){stopError=e.message}
 const encoded=await new Blob(chunks).arrayBuffer();let duration=null;try{duration=(await context.decodeAudioData(encoded)).duration}catch(e){}
 sources.forEach(s=>s.osc.stop());await context.close();
 return {events,errors,finishBytes,duration,stopError};
})()`)
      const stdout = await runElectron(folder, payload)
      const result = JSON.parse(stdout.split('PC_CAPTURE_RESULT=')[1].split('\n')[0])
      console.log('Chromium terminal encoder chunk:', JSON.stringify(result))
      expect(result.finishBytes).toBeGreaterThan(0)
      expect(result.duration).toBeGreaterThan((failureAfter - 200) / 1000)
      const events = result.events.map((event: unknown[]) => event[0])
      expect(events.indexOf('finish')).toBeGreaterThan(events.indexOf('stop'))
      expect(result.events.filter((event: unknown[]) => event[0] === 'append').every((event: unknown[]) => event[3] === false)).toBe(true)
    } finally { rmSync(folder, { recursive: true }) }
  }, 30000)
}
for (const operation of ['reload', 'restart', 'close']) {
  it(`real Electron ${operation} flushes and resumes the requested operation`, async () => {
    const stdout = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, [resolve('scripts/test-pc-recorder-unload.cjs'), operation], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
      let output = ''
      child.stdout.on('data', data => { output += data.toString() })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolveOutput(output) : reject(new Error(output)))
    })
    const result = JSON.parse(stdout.split('PC_UNLOAD_RESULT=')[1].split('\n')[0])
    console.log('Electron unload boundary:', JSON.stringify(result))
    expect(result.imports).toHaveLength(1)
    expect(result.imports[0].bytes).toBeGreaterThan(0)
    expect(result.files).toEqual([])
    expect(result.destroyed).toBe(operation === 'close')
    if (operation !== 'close') expect(result.events.filter((event: string) => event === 'NAVIGATION')).toHaveLength(2)
  }, 30000)
}
