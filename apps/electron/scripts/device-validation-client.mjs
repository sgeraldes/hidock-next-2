/** Development-only fixed-app API client. Never opens a separate device handle. */
export async function openValidationClient() {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const target = targets.find(t=>t.type==='page'&&t.url.startsWith('file:///G:/Code/hidock-next-2/apps/electron/out/renderer/index.html'))
  if(!target) throw Error('Expected local development application is unavailable')
  const socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok,fail)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',fail,{once:true})})
  let sequence=0
  const requests=new Map()
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),request=requests.get(message.id);if(request){requests.delete(message.id);clearTimeout(request.timer);message.error?request.fail(Error('Development API failed')):request.ok(message.result)}})
  async function call(method, params, timeout=120000) {
    const id=++sequence
    return new Promise((ok,fail)=>{const timer=setTimeout(()=>{requests.delete(id);fail(Error('Development API timed out'))},timeout);requests.set(id,{ok,fail,timer});socket.send(JSON.stringify({id,method,params}))})
  }
  return {
    call,
    async evaluate(expression, timeout=120000) {
      const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeout)
      if(result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text)
      return result.result.value
    },
    close(){socket.close();for(const request of requests.values()){clearTimeout(request.timer);request.fail(Error('Development client closed'))}requests.clear()}
  }
}
