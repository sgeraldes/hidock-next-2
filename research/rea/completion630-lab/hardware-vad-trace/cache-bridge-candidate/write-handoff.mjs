import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const repo='G:/Code/hidock-next-2';
const base='research/rea/completion630-lab/hardware-vad-trace';
const files=[
 'fresh-sample-candidate/vadt_core.h','fresh-sample-candidate/vadt_core.c',
 'fresh-sample-candidate/vadt_binding.h','fresh-sample-candidate/vadt_binding.c',
 'fresh-sample-candidate/vadt_csky_guard.c','fresh-sample-candidate/vadt_test.c',
 'fresh-sample-candidate/CONTRACT.md','fresh-sample-candidate/REPORT.md','fresh-sample-candidate/RUN.md',
 'lifecycle-followup/lifetime-fix/REPORT.md','command-binding/REPORT.md',
 'command-binding/namespace-proof/REPORT.md','object-tail-audit/REPORT.md',
 'command-binding/target-scheduler/REPORT.md','command-binding/target-scheduler/primary-mask-contract/REPORT.md',
 'sdk-codec/REPORT.md','cache-bridge-candidate/host-c-sdk-final-interop-1791892625179.json'
].map(p=>`${base}/${p}`).concat(['packages/jensen-protocol/src/native-vad-observation.ts','packages/jensen-protocol/src/native-vad-observation.test.ts']);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,p))).digest('hex');
const receipt=JSON.parse(fs.readFileSync(path.join(repo,base,'cache-bridge-candidate/host-c-sdk-final-interop-1791892625179.json'),'utf8'));
for(const [p,h] of Object.entries(receipt.sourceHashes)) if(sha(path.relative(repo,p))!==h) throw Error(`Interop source drift: ${p}`);
const snapshot={
 createdAt:new Date().toISOString(),kind:'source-review-handoff-not-target-qualification',
 sourcePins:{official630:'5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce',frozen393988:'b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f'},
 files:files.map(p=>({path:p,sha256:sha(p)})),
 observedBoundaries:{hostCompiledCToActualSdkParser:receipt.result,interopVectors:receipt.vectors.length,physicalVad:false,targetImageGenerated:false},
 agentReportedChecks:{coreHostChecks:118,coreHostFailures:0,sdkFocusedTests:66,sdkTypecheck:'passed',isolatedCskyCompilerCpuChoice:'ck803',actualSiliconModel:'unconfirmed'},
 proposal:{command:'0xf11a',allocated:false,requestBodyHex:'01',responseBodyBytes:32,statusByteIncluded:true,age:'unavailable',physicalVoiceInterpretation:'unknown',objectTailBytes:32},
 sourceFindings:{f11aExactFrozenChainCollision:'none-found-unsupported-default',directObjectTailOverlap:'none-in-13-retained-users',constructorEdits:'assembled-proposed-not-applied',nativeBinding:'unconnected-no-loader-hook-or-frame-handler',publicSdkExports:'absent',appIntegration:'absent'},
 remaining:['Native binding lifetime/readiness and same-core synchronization require independent review.','Exact 0xe000ec08 register-to-TSpending mapping and target CPU/VIC applicability remain unproven; vendor mask interpretation is compatibility evidence.','No generated image, native wrapper ABI/branch installation, live command or voice/source meaning qualification exists.','Heap alignment/allocation success and indirect provider bounds remain runtime/source qualification limits.'],
 hardware:{operationsThisHandoff:[],lastKnownFirmware:393988,liveIdentityQueriedForHandoff:false},
 git:{indexTouchedByThisWork:false,commitPushOwner:'original-H1E-root-session'}
};
const output=path.join(repo,base,'cache-bridge-candidate',`source-review-handoff-${Date.now()}.json`);
fs.writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,sha256:sha(path.relative(repo,output)),files:files.length,targetQualified:false}));
