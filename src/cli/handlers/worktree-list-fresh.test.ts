import { describe, expect, it } from 'vitest'
import { WORKTREE_HANDLERS } from './worktree'
import type { RuntimeClientError } from '../runtime-client'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'
type CallRecord = { method: string; params: Record<string, unknown> }

function handlerHarness(
  hostResult: Partial<RuntimeWorktreeListResult> | Error,
  flagValue: string | boolean = true
) {
  const calls: CallRecord[] = []
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (hostResult instanceof Error) {
        throw hostResult
      }
      return { result: { worktrees: [], totalCount: 0, truncated: false, ...hostResult } }
    }
  }
  const run = () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: HandlerContext is structural; the list handler reads only flags, client, json.
    WORKTREE_HANDLERS['worktree list']({
      flags: new Map(Object.entries({ fresh: flagValue })),
      client,
      json: true,
      cwd: '/tmp'
    } as unknown as Parameters<typeof WORKTREE_HANDLERS['worktree list']>[0])
  return { calls, run }
}

describe('worktree list --fresh', () => {
  it('forwards the fresh request and prints the acknowledged listing', async () => {
    const { calls, run } = handlerHarness({ freshCacheBypass: true })
    await expect(run()).resolves.toBeUndefined()
    expect(calls).toEqual([
      { method: 'worktree.list', params: { repo: undefined, limit: undefined, fresh: true } }
    ])
  })

  it('fails closed when an old host strips the fresh field and returns no acknowledgement', async () => {
    // Old-host simulation: zod strips the unknown `fresh` field, so the response
    // carries no `freshCacheBypass` even though the CLI asked for it.
    const { run } = handlerHarness({})
    await expect(run()).rejects.toMatchObject({
      code: 'fresh_unsupported',
      message: expect.stringContaining('--fresh')
    } satisfies Partial<RuntimeClientError>)
  })

  it('rejects --fresh with an attached value instead of silently ignoring it', async () => {
    // Parsers that accept `--fresh=x` hand the handler a string; without the
    // guard it would be treated as absent and the listing could come from cache.
    const { calls, run } = handlerHarness({ freshCacheBypass: true }, 'x')
    await expect(run()).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--fresh does not take a value'
    } satisfies Partial<RuntimeClientError>)
    expect(calls).toEqual([])
  })
})
