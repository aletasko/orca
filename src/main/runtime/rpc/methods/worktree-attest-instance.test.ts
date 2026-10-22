import { describe, expect, it, vi } from 'vitest'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'

const found = WORKTREE_CATALOG_METHODS.find((entry) => entry.name === 'worktree.attestInstance')
if (!found || found.name !== 'worktree.attestInstance') {
  throw new Error('worktree.attestInstance method missing')
}
const attestMethod = found

describe('worktree.attestInstance RPC', () => {
  it('requires a bounded non-empty instanceId', () => {
    expect(() => attestMethod.params.parse({})).toThrow()
    expect(() => attestMethod.params.parse({ instanceId: '' })).toThrow()
    expect(() => attestMethod.params.parse({ instanceId: 'x'.repeat(129) })).toThrow()
    expect(attestMethod.params.parse({ instanceId: 'inst-1' })).toEqual({ instanceId: 'inst-1' })
  })

  it('returns the runtime verdict unmodified', async () => {
    const verdict = { status: 'absent', authoritative: false, reason: 'unknown_instance' }
    const attest = vi.fn(async () => verdict)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handler context is structural; only runtime.attestWorktreeInstance is read.
    const context = { runtime: { attestWorktreeInstance: attest } } as unknown as Parameters<
      typeof attestMethod.handler
    >[1]
    await expect(attestMethod.handler({ instanceId: 'inst-1' }, context)).resolves.toBe(verdict)
    expect(attest).toHaveBeenCalledWith('inst-1')
  })
})
