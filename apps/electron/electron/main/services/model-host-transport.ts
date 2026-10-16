import { Agent, fetch as secureFetch } from 'undici'
import { X509Certificate } from 'crypto'

let trustedPem = ''
let agent: Agent | undefined

/** Trust is scoped to this service's requests, never installed as a system CA. */
export async function modelHostFetch(url: string, init: RequestInit, fetchFn: typeof fetch = fetch): Promise<Response> {
  const request = { ...init, redirect: 'error' as const }
  if (fetchFn !== fetch) return fetchFn(url, request)
  if (new URL(url).protocol === 'http:') return fetch(url, request)
  const { getConfig } = await import('./config')
  const pem = getConfig().transcription.modelHostCertificatePem || ''
  if (!pem) return fetch(url, request)
  // Reject malformed certificates before constructing a dispatcher. Standard
  // TLS hostname and expiry checks remain enabled for the pinned trust anchor.
  new X509Certificate(pem)
  if (pem !== trustedPem || !agent) {
    const old = agent
    agent = new Agent({ connect: { ca: pem } })
    trustedPem = pem
    void old?.close()
  }
  return secureFetch(url, { ...request, dispatcher: agent } as Parameters<typeof secureFetch>[1]) as unknown as Promise<Response>
}
