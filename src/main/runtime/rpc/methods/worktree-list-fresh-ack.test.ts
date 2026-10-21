import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeListResult } from '../../../../shared/runtime-types'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'

const found = WORKTREE_CATALOG_METHODS.find((entry) => entry.name === 'worktree.list')
if (!found || found.name !== 'worktree.list') {
  throw new Error('worktree.list method missing')
}
const listMethod = found

function listingResult(): RuntimeWorktreeListResult {
  return {
    worktrees: [],
    totalCount: 0,
    truncated: false,
    hostScope: { hostIds: [], omittedHostIds: [] }
  }
}

function context(listManagedWorktrees: ReturnType<typeof vi.fn>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handler context is structural; only clientCapabilities and runtime are read.
  return {
    clientCapabilities: undefined,
    runtime: { listManagedWorktrees }
  } as unknown as Parameters<typeof listMethod.handler>[1]
}

async function run(params: unknown, listManagedWorktrees: ReturnType<typeof vi.fn>) {
  const parsed = listMethod.params.parse(params)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the erased RpcMethodDeclaration returns unknown; the list handler returns RuntimeWorktreeListResult.
  return listMethod.handler(parsed, context(listManagedWorktrees)) as Promise<RuntimeWorktreeListResult>
}

describe('worktree.list fresh cache-bypass acknowledgement', () => {
  it('acknowledges freshCacheBypass only when the caller asked for fresh', async () => {
    const list = vi.fn(async () => listingResult())
    const result = await run({ fresh: true }, list)
    expect(list).toHaveBeenCalledWith(undefined, undefined, true, true)
    expect(result.freshCacheBypass).toBe(true)
  })

  it('threads an explicit repo through the fresh request', async () => {
    const list = vi.fn(async () => listingResult())
    await run({ repo: 'id:repo-a', fresh: true }, list)
    expect(list).toHaveBeenCalledWith('id:repo-a', undefined, true, true)
  })

  it('keeps legacy responses byte-compatible: no fresh flag, no ack field', async () => {
    const list = vi.fn(async () => listingResult())
    const legacy = await run({}, list)
    expect(list).toHaveBeenCalledWith(undefined, undefined, true, false)
    expect(legacy).not.toHaveProperty('freshCacheBypass')

    const explicitFalse = await run({ fresh: false }, list)
    expect(explicitFalse).not.toHaveProperty('freshCacheBypass')
  })

  it('treats a non-boolean fresh value as absent, like the other optional params', () => {
    expect(listMethod.params.parse({ fresh: 'yes' })).toMatchObject({ fresh: undefined })
  })
})
