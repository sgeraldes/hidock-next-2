// @vitest-environment node
import { expect, it } from 'vitest'
import { assertRecordingManifestBinding, parseRecordingManifest, type RecordingClockEvidence } from '../recording-manifest'
const sha = 'a'.repeat(64)
const fixture = () => ({schemaVersion: 1, recordingId:'device-id', contentGeneration:'generation-1', state:'finalized',
  file:{name:'test.wav', byteLength:64044, sha256:sha}, audio:{container:'wav', codec:'pcm_s16le',
    sampleRateHz:16000,channels:2,bitsPerSample:16,clock:null,
    sourceMap:[{channelIndex:0,role:'unknown'},{channelIndex:1,role:'unknown'}]}, markers:[]})
const measured = () => ({sha256:sha,byteLength:64044,layout:{container:'wav' as const,codec:'pcm_s16le',channels:2,
  sampleRate:16000,durationSeconds:1,durationSource:'decoded-frames' as const,originalSha256:sha}})
it('retains unknown roles and explicit unknown clock without creating provenance', () => {
  const value=parseRecordingManifest(JSON.stringify(fixture()))
  expect(value.audio.clock).toBeNull()
  expect(value.audio.sourceMap.map(row=>row.role)).toEqual(['unknown','unknown'])
  expect(value).not.toHaveProperty('evidence')
  expect(()=>assertRecordingManifestBinding(value,measured())).not.toThrow()
})
it.each(['hash','size','channels','rate','container','codec'])('rejects a mismatched %s binding', field => {
  const value=parseRecordingManifest(JSON.stringify(fixture())), observed=measured()
  if(field==='hash')observed.sha256='b'.repeat(64)
  if(field==='size')observed.byteLength++
  if(field==='channels')observed.layout.channels=1
  if(field==='rate')observed.layout.sampleRate=48000
  if(field==='container')observed.layout.container='mp3' as 'wav'
  if(field==='codec')observed.layout.codec='mp3'
  expect(()=>assertRecordingManifestBinding(value,observed)).toThrow('does not match')
})
it.each([64,96,128,160])('distinguishes total MP3 %i kbps from WAV bits/sample', bitrateKbps=>{
  const input:any=fixture(); input.audio.container='mp3'; input.audio.codec='mp3';
  delete input.audio.bitsPerSample; input.audio.bitrateKbps=bitrateKbps
  expect(parseRecordingManifest(JSON.stringify(input)).audio.bitrateKbps).toBe(bitrateKbps)
  input.audio.bitsPerSample=16
  expect(()=>parseRecordingManifest(JSON.stringify(input))).toThrow()
})
it.each(['version','duplicate-channel','missing-digest','invented-field','traversal','duplicate-marker','unmeasured-frame'])('rejects invalid contract %s', kind=>{
  const input:any=fixture()
  if(kind==='version')input.schemaVersion=2
  if(kind==='duplicate-channel')input.audio.sourceMap[1].channelIndex=0
  if(kind==='missing-digest')delete input.file.sha256
  if(kind==='invented-field')input.firmwareVerified=true
  if(kind==='traversal')input.file.name='../test.wav'
  if(kind==='duplicate-marker')input.markers=[0,1].map(()=>({markerId:'same',type:'manual',position:{unit:'legacy-ms',value:1}}))
  if(kind==='unmeasured-frame')input.markers=[{markerId:'frame',type:'manual',position:{unit:'capture-frame',value:1}}]
  expect(()=>parseRecordingManifest(JSON.stringify(input))).toThrow()
})
it('keeps an empty open capture structurally valid but refuses final association',()=>{
  const input:any=fixture(); input.state='open'; input.file.byteLength=0; delete input.file.sha256
  const value=parseRecordingManifest(JSON.stringify(input))
  expect(()=>assertRecordingManifestBinding(value,measured())).toThrow('Open recording')
})
it('caps the untrusted payload before parsing',()=>{
  expect(()=>parseRecordingManifest(' '.repeat(65537))).toThrow('64 KiB')
})
it('retains a measured capture-frame marker and rejects one beyond that clock',()=>{
  const input:any=fixture()
  input.audio.clock={sampleRateHz:16000,frameCount:16000,encoderDelayFrames:0,encoderPaddingFrames:0}
  input.markers=[{markerId:'marker-1',type:'manual',label:'Inicio',position:{unit:'capture-frame',value:8000}}]
  expect(parseRecordingManifest(JSON.stringify(input)).markers[0].position.value).toBe(8000)
  input.markers[0].position.value=16001
  expect(()=>parseRecordingManifest(JSON.stringify(input))).toThrow()
})
it('retains legacy milliseconds without fabricating a sample clock',()=>{
  const input:any=fixture()
  input.markers=[{markerId:'legacy-1',type:'manual',position:{unit:'legacy-ms',value:900}}]
  const value=parseRecordingManifest(JSON.stringify(input))
  expect(value.audio.clock).toBeNull()
  expect(()=>assertRecordingManifestBinding(value,measured())).not.toThrow()
  value.markers[0].position.value=1001
  expect(()=>assertRecordingManifestBinding(value,measured())).toThrow('duration')
})
it('bounds identifiers by UTF-8 bytes rather than JavaScript character count',()=>{
  const input:any=fixture(); input.recordingId='é'.repeat(65)
  expect(()=>parseRecordingManifest(JSON.stringify(input))).toThrow()
  input.recordingId='é'.repeat(64)
  expect(parseRecordingManifest(JSON.stringify(input)).recordingId).toBe(input.recordingId)
})
it('retains several native legacy markers with no invented ID/type',()=>{
  const input:any=fixture()
  input.markers=[100,700].map(value=>({markerId:null,type:'unknown',position:{unit:'legacy-ms',value}}))
  const value=parseRecordingManifest(JSON.stringify(input))
  expect(value.markers.every(row=>row.markerId===null && row.type==='unknown')).toBe(true)
  expect(()=>assertRecordingManifestBinding(value,measured())).not.toThrow()
})
it('requires a persistent marker ID for capture-frame positions',()=>{
  const input:any=fixture()
  input.audio.clock={sampleRateHz:16000,frameCount:16000,encoderDelayFrames:0,encoderPaddingFrames:0}
  input.markers=[{markerId:null,type:'unknown',position:{unit:'capture-frame',value:100}}]
  expect(()=>parseRecordingManifest(JSON.stringify(input))).toThrow()
})
it.each(['missing','source-hash','frameCount','sampleRateHz','encoderDelayFrames','encoderPaddingFrames','wrong-source'])('rejects claimed capture clock with %s independent evidence',kind=>{
  const input:any=fixture()
  input.audio.clock={sampleRateHz:16000,frameCount:16000,encoderDelayFrames:0,encoderPaddingFrames:0}
  const value=parseRecordingManifest(JSON.stringify(input))
  const proof:RecordingClockEvidence={originalSha256:sha,evidenceId:'actual-pcm-measurement',source:'pcm-frame-measurement',
    clock:{...input.audio.clock}}
  if(kind==='source-hash')proof.originalSha256='b'.repeat(64)
  if(kind==='wrong-source')proof.source='independent-encoder-calibration'
  if(['frameCount','sampleRateHz','encoderDelayFrames','encoderPaddingFrames'].includes(kind))
    proof.clock[kind as keyof typeof proof.clock]++
  expect(()=>assertRecordingManifestBinding(value,{...measured(),clockEvidence:kind==='missing'?undefined:proof})).toThrow('independent')
})
it('matches independently measured PCM frames with zero encoder delay/padding',()=>{
  const input:any=fixture()
  input.audio.clock={sampleRateHz:16000,frameCount:16000,encoderDelayFrames:0,encoderPaddingFrames:0}
  const value=parseRecordingManifest(JSON.stringify(input))
  expect(()=>assertRecordingManifestBinding(value,{...measured(),clockEvidence:{originalSha256:sha,
    evidenceId:'pcm-test',source:'pcm-frame-measurement',clock:{...input.audio.clock}}})).not.toThrow()
})
it('refuses a non-null MPEG clock, calibrated or not, because v1 cannot relate it to decoded duration; a null clock binds',()=>{
  const input:any=fixture(); input.audio.container='mp3';input.audio.codec='mp3';delete input.audio.bitsPerSample
  input.audio.bitrateKbps=128
  const observed=measured()
  const layout={...observed.layout,container:'mp3' as const,codec:'mp3'}
  expect(()=>assertRecordingManifestBinding(parseRecordingManifest(JSON.stringify(input)),{...observed,layout})).not.toThrow()
  input.audio.clock={sampleRateHz:16000,frameCount:16000,encoderDelayFrames:576,encoderPaddingFrames:128}
  const value=parseRecordingManifest(JSON.stringify(input))
  const proof:RecordingClockEvidence={originalSha256:sha,evidenceId:'encoder-calibration-test',
    source:'independent-encoder-calibration',clock:{...input.audio.clock}}
  expect(()=>assertRecordingManifestBinding(value,{...observed,layout,clockEvidence:proof})).toThrow('null clock')
  proof.source='pcm-frame-measurement'
  expect(()=>assertRecordingManifestBinding(value,{...observed,layout,clockEvidence:proof})).toThrow('null clock')
})
