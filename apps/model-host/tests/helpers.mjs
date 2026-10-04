import { EventEmitter } from 'events'

/** A request that looks enough like http.IncomingMessage for the handler. */
export function request({ method = 'GET', url = '/', headers = {}, body = '', local = true, host = 'localhost:8765' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  // Every real request carries a Host header, and the control page checks it.
  req.headers = { host, ...headers }
  req.socket = { remoteAddress: local ? '127.0.0.1' : '192.168.1.40' }
  req.destroy = () => req.emit('error', new Error('destroyed'))
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

export function response() {
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk) this.body += chunk
      this.done = true
    },
  })
  return res
}
