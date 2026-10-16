import { openValidationClient } from './device-validation-client.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const client=await openValidationClient()
const directory=resolve('node_modules/.cache/completion630-runtime');await mkdir(directory,{recursive:true})
const evidence={observedAt:new Date().toISOString(),boundary:'built-renderer/UI/app-IPC/Windows-drive'}
try {
  await client.evaluate('(window.location.hash="/sync",true)')
  await new Promise(r=>setTimeout(r,1500))
  evidence.initial=await client.evaluate(`(()=>{const p=document.querySelector('[aria-label="Device drive"]');return {visible:!!p,buttons:p?Array.from(p.querySelectorAll('button')).map(b=>({text:b.textContent,disabled:b.disabled})):[]}})()`)
  if(!evidence.initial.visible)throw Error('Drive panel unavailable')
  await client.evaluate(`(()=>{const p=document.querySelector('[aria-label="Device drive"]'),b=Array.from(p.querySelectorAll('button')).find(v=>v.textContent.trim()==='Mount drive');if(!b||b.disabled)throw Error('Mount control unavailable');b.click();return true})()`)
  await new Promise(r=>setTimeout(r,1500))
  evidence.mounted=await client.evaluate(`(()=>{const p=document.querySelector('[aria-label="Device drive"]');p.scrollIntoView({block:'center'});const r=p.getBoundingClientRect();return {text:p.textContent,button: Array.from(p.querySelectorAll('button')).some(b=>b.textContent.trim()==='Unmount drive'&&!b.disabled),rectangle:{x:r.x,y:r.y,width:r.width,height:r.height}}})()`)
  const image=await client.call('Page.captureScreenshot',{format:'png',clip:{...evidence.mounted.rectangle,scale:1}})
  await writeFile(resolve(directory,'drive-panel.png'),Buffer.from(image.data,'base64'))
  await client.evaluate(`(()=>{const p=document.querySelector('[aria-label="Device drive"]'),b=Array.from(p.querySelectorAll('button')).find(v=>v.textContent.trim()==='Unmount drive');if(!b||b.disabled)throw Error('Unmount control unavailable');b.click();return true})()`)
  await new Promise(r=>setTimeout(r,500))
  evidence.after=await client.evaluate('window.electronAPI.jensen.getDeviceDriveStatus()')
  evidence.renderedLimit=evidence.mounted.text.includes('50,000,000 bytes')
  delete evidence.mounted.text
  evidence.passed=evidence.mounted.button&&evidence.renderedLimit&&!evidence.after.mounted
  console.log(JSON.stringify(evidence,null,2))
  if(!evidence.passed)process.exitCode=1
} finally {
  await client.evaluate('window.electronAPI.jensen.unmountDeviceDrive()').catch(()=>undefined)
  await writeFile(resolve(directory,'drive-panel-ui.json'),JSON.stringify(evidence,null,2));client.close()
}
