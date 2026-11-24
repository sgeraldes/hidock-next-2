// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { BrainAgentAccess } from '../brain-agent-access'
describe('explicit temporary agent grants', () => {
  it('starts empty and supports only explicit scoped grants, expiry and revocation', () => {
    let now = 100
    const access = new BrainAgentAccess(() => now)
    const token = 'synthetic-agent-token-'.repeat(3)
    expect(access.authenticate(token)).toBeNull()
    access.grant('fixture', token, ['knowledge:read'], 200)
    expect(access.authenticate(token)).toEqual(['knowledge:read'])
    expect(access.authenticate('another-fixture-token')).toBeNull()
    now = 200
    expect(access.authenticate(token)).toBeNull()
    access.grant('fixture', token, ['health:read'], 300)
    expect(access.revoke('fixture')).toBe(true)
    expect(access.authenticate(token)).toBeNull()
  })
})
