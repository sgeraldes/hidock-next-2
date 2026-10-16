import { createHash, timingSafeEqual } from 'crypto'

export const BRAIN_SCOPES = ['health:read', 'knowledge:read', 'graph:read', 'transcription:read', 'transcription:write', 'rag:read', 'rag:write', 'backend:control'] as const
export type BrainScope = typeof BRAIN_SCOPES[number]

/** Opt-in mechanism only. No credentials are generated, persisted or granted
 * on startup. An owner-controlled caller must supply an explicit grant.
 */
export class BrainAgentAccess {
  private grants = new Map<string, { digest: Buffer; scopes: BrainScope[]; expiresAt: number }>()
  constructor(private now: () => number = Date.now) {}
  grant(id: string, token: string, scopes: BrainScope[], expiresAt: number): void {
    if (!id || token.length < 32 || !scopes.length || scopes.some(scope => !BRAIN_SCOPES.includes(scope)) || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('Invalid explicit agent grant')
    this.grants.set(id, { digest: createHash('sha256').update(token).digest(), scopes: [...new Set(scopes)], expiresAt })
  }
  revoke(id: string): boolean { return this.grants.delete(id) }
  authenticate(token: string): readonly BrainScope[] | null {
    const digest = createHash('sha256').update(token).digest()
    for (const grant of this.grants.values()) {
      if (timingSafeEqual(grant.digest, digest) && grant.expiresAt > this.now()) return [...grant.scopes]
    }
    return null
  }
}
