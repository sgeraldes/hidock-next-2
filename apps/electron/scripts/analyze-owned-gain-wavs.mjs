/** Scalar-only analysis of three controlled private physical gain fixtures. */
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
const folder=resolve('node_modules/.cache/completion630-runtime'),fixtures=[[32768,'1791815383966'],[16384,'1791815398111'],[0,'1791815412584']],rows=[]
for(const [gain,stamp]of fixtures){
 const b=await readFile(resolve(folder,`native-wav-upload2-${stamp}.private.wav`)),n=b.readUInt32LE(40)/4,rate=b.readUInt32LE(24)
 if(b.subarray(0,4).toString()!=='RIFF'||b.readUInt16LE(22)!==2||b.readUInt16LE(34)!==16||rate!==16000||!Number.isInteger(n)||44+n*4>b.length)throw Error('Invalid owned paired WAV')
 const peaks=[0,0],nonzero=[0,0],windows=[]
 for(let i=0;i<n;i++)for(let c=0;c<2;c++){const v=b.readInt16LE(44+4*i+2*c);peaks[c]=Math.max(peaks[c],Math.abs(v));if(v)nonzero[c]++}
 for(let start=rate;start+rate<=n;start+=rate/2){const projection=[];for(let c=0;c<2;c++){let a=0,z=0;for(let i=0;i<rate;i++){const v=b.readInt16LE(44+4*(start+i)+2*c),angle=2*Math.PI*1000*i/rate;a+=v*Math.cos(angle);z+=v*Math.sin(angle)}projection.push(2*Math.hypot(a,z)/rate)}windows.push({startSample:start,projectionPeakLsb:projection})}
 const max=Math.max(...windows.map(w=>w.projectionPeakLsb[1])),stable=windows.filter(w=>w.projectionPeakLsb[1]>=0.8*max).map(w=>w.projectionPeakLsb[1]).sort((a,b)=>a-b)
 rows.push({gainRightQ15:gain,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),frames:n,sampleRate:rate,peaks,nonzeroSamples:nonzero,stable1000HzRightPeakLsb:stable[Math.floor(stable.length/2)]??null,scalarWindows:windows})
}
const ratio=rows[1].stable1000HzRightPeakLsb/rows[0].stable1000HzRightPeakLsb
const evidence={observedAt:new Date().toISOString(),boundary:'controlled-physical-custom-WAV/readback/independent-scalar-DSP',rows,halfGainAmplitudeRatio:ratio,mutedLaneExactZero:rows[2].nonzeroSamples[1]===0,physicalSourceMappingScope:'Controlled HiDock UAC render-correlated B only; other modes unqualified',passed:Math.abs(ratio-0.5)<0.02&&rows[2].nonzeroSamples[1]===0&&rows[2].nonzeroSamples[0]>0}
await writeFile('../../research/rea/completion630-lab/runtime/upload2-wav-gain-analysis.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({halfGainAmplitudeRatio:ratio,mutedLaneExactZero:evidence.mutedLaneExactZero,rows:rows.map(({scalarWindows:_omitted,...r})=>r),passed:evidence.passed},null,2))
if(!evidence.passed)process.exitCode=1
