import { readFile } from 'node:fs/promises'
const path=process.argv[2]
if(!path?.startsWith('node_modules/.cache/completion630-runtime/native-wav-upload2-')||!path.endsWith('.private.wav'))throw Error('Owned native WAV required')
const b=await readFile(path),length=b.readUInt32LE(40),n=length/4,s=[0,0],q=[0,0],peak=[0,0],clipped=[0,0];let xy=0,equal=0
if(b.subarray(0,4).toString()!=='RIFF'||b.readUInt16LE(22)!==2||b.readUInt16LE(34)!==16||length%4||44+length>b.length)throw Error('Exact stereo PCM16 required')
for(let i=0;i<n;i++){const a=b.readInt16LE(44+i*4),c=b.readInt16LE(46+i*4);for(const [j,v]of [[0,a],[1,c]]){s[j]+=v;q[j]+=v*v;peak[j]=Math.max(peak[j],Math.abs(v));if(v===-32768||v===32767)clipped[j]++}xy+=a*c;if(a===c)equal++}
const den=Math.sqrt((n*q[0]-s[0]**2)*(n*q[1]-s[1]**2))
console.log(JSON.stringify({frames:n,sampleRate:b.readUInt32LE(24),seconds:n/b.readUInt32LE(24),rms:q.map(v=>Math.sqrt(v/n)),peak,clipped,equalFrameFraction:equal/n,correlation:den?(n*xy-s[0]*s[1])/den:null,physicalSourcesUncalibrated:true}))
