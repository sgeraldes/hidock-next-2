import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const official = fs.readFileSync('G:/Code/hidock-next-2/research/rea/h1e-6.3.0-verified/zephyr-decoded.bin');
const custom = fs.readFileSync('G:/Code/hidock-next-2/research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/system-decoded-NOTINSTALL.bin');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
if (sha(official) !== '5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce' || sha(custom) !== 'b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f') throw Error('Pinned source mismatch');
const hex = value => `0x${value.toString(16).padStart(8,'0')}`;
const spans = [
  [0x01021024,0x144,'state constructor and literals'],
  [0x01020f74,0x98,'state transition helper and literals'],
  [0x010217dc,0x90,'scheduler dispatch and literals'],
  [0x01090054,12,'clock low/high load and literal'],
  [0x0103312e,4,'main-loop scheduler call'],
  [0x0103316a,4,'main-loop state manager call']
].map(([address,bytes,description]) => {
  const offset = address-0x01000000;
  let differences=0;
  for(let i=0;i<bytes;i++) if(official[offset+i]!==custom[offset+i]) differences++;
  return {address:hex(address),bytes,description,differences,officialSha256:sha(official.subarray(offset,offset+bytes)),customSha256:sha(custom.subarray(offset,offset+bytes))};
});
const exactSites = [[0x01021054,2,'malloc size'],[0x0102109e,2,'zeroing size'],[0x01020b62,4,'native getter call'],[0x010217f4,2,'unsigned deadline comparison']].map(([address,length,purpose])=>({address:hex(address),purpose,bytes:official.subarray(address-0x01000000,address-0x01000000+length).toString('hex')}));
const parity={kind:'exact-source-byte-comparison',physicalVadTest:false,officialSha256:sha(official),customSha256:sha(custom),spans,exactSites};
fs.writeFileSync(path.join(root,'binding-source-parity.json'),JSON.stringify(parity,null,2)+'\n');
const cases=[
  {name:'overdue across wrap',deadline:0xfffffff0,now:0x10,expectedDue:true},
  {name:'future across wrap',deadline:0x22,now:0xfffffff5,expectedDue:false},
  {name:'ordinary future',deadline:1050,now:1000,expectedDue:false},
  {name:'exact deadline',deadline:1050,now:1050,expectedDue:true},
  {name:'ordinary overdue',deadline:1050,now:1060,expectedDue:true}
].map(test=>({...test,deadlineHex:hex(test.deadline),nowHex:hex(test.now),nativeUnsignedDue:test.now>=test.deadline,modularSignedDue:((test.now-test.deadline)|0)>=0}));
if(cases.some(test=>test.modularSignedDue!==test.expectedDue)) throw Error('Arithmetic oracle mismatch');
const wrap={kind:'source-condition-arithmetic-reproduction',physicalFirmwareExecution:false,sourceInstruction:exactSites[3],cases,limits:['Native dispatcher bytes were inspected and compared; these cases execute arithmetic, not C-SKY firmware.','Signed modular comparison requires bounded intervals and observation gaps shorter than half the counter range.','No scheduler patch is generated or applied.']};
fs.writeFileSync(path.join(root,'scheduler-wrap-arithmetic.json'),JSON.stringify(wrap,null,2)+'\n');
console.log(JSON.stringify({parityDifferences:spans.map(x=>({address:x.address,differences:x.differences})),nativeWrapMismatches:cases.filter(x=>x.nativeUnsignedDue!==x.expectedDue).map(x=>x.name),physicalVadTest:false}));
