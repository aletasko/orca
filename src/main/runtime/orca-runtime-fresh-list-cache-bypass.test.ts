import { describe, expect, it } from 'vitest'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'
import { RuntimeResolvedWorktreeCache } from './runtime-resolved-worktree-cache'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'

function listingResult(): RuntimeWorktreeListResult {
  return { worktrees: [], totalCount: 0, truncated: false }
}

type Harness = {
  runtime: OrcaRuntimeWithListManagedWorktrees
  listCalls: unknown[][]
  resolvedInvalidations: number
  invalidatedRepoIds: string[]
}

function harness(repos: { id: string }[]): Harness {
  const state: Harness = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prototype instance stubbed with only the members listManagedWorktrees touches.
    runtime: Object.create(
      OrcaRuntimeWithListManagedWorktrees.prototype
    ) as OrcaRuntimeWithListManagedWorktrees,
    listCalls: [],
    resolvedInvalidations: 0,
    invalidatedRepoIds: []
  }
  Object.assign(state.runtime, {
    managedWorktreeQueries: {
      list: (...args: unknown[]) => {
        state.listCalls.push(args)
        return Promise.resolve(listingResult())
      }
    },
    store: { getRepos: () => repos },
    // Protected on the runtime chain; stubbed through assign so the harness stays untyped.
    invalidateResolvedWorktreeCache: () => {
      state.resolvedInvalidations += 1
    },
    invalidateWorktreeScanCacheForRepo: (repoId: string) => {
      state.invalidatedRepoIds.push(repoId)
    }
  })
  return state
}

describe('listManagedWorktrees fresh cache bypass', () => {
  it('invalidates the resolved snapshot and every repo scan cache when fresh', async () => {
    const state = harness([{ id: 'repo-a' }, { id: 'repo-b' }])
    await state.runtime.listManagedWorktrees(undefined, 200, true, true)
    expect(state.resolvedInvalidations).toBe(1)
    expect(state.invalidatedRepoIds).toEqual(['repo-a', 'repo-b'])
    expect(state.listCalls[0]).toEqual([undefined, 200, true])
  })

  it('covers folder workspaces, which live in the same repo scan caches', async () => {
    const state = harness([{ id: 'folder-repo' }])
    await state.runtime.listManagedWorktrees('id:folder-repo', 50, true, true)
    expect(state.invalidatedRepoIds).toEqual(['folder-repo'])
  })

  it('keeps the normal call cache-warm and does not thread fresh into the query', async () => {
    const state = harness([{ id: 'repo-a' }])
    await state.runtime.listManagedWorktrees('id:repo-a', 50)
    expect(state.resolvedInvalidations).toBe(0)
    expect(state.invalidatedRepoIds).toEqual([])
    expect(state.listCalls[0]).toEqual(['id:repo-a', 50, true])
  })

  it('bypassing the warm resolved cache picks up a changed Git scan', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    let scanRows = [{ id: 'repo-a::wt-old' }]
    const compute = () => {
      const rows = scanRows
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: row identity is what this test observes; full ResolvedWorktree fixtures are irrelevant.
      return Promise.resolve({
        worktrees: rows as unknown as ResolvedWorktree[],
        platformByRepoId: new Map()
      })
    }
    const ttlMs = 60_000
    await cache.getSnapshot(compute, ttlMs, 0)
    // Git scan changed underneath while the warm snapshot is still inside its TTL:
    // the warm cache still answers with the stale rows a normal listing would print.
    scanRows = [{ id: 'repo-a::wt-old' }, { id: 'repo-a::wt-new' }]
    await expect(cache.getSnapshot(compute, ttlMs, 0)).resolves.toHaveProperty('worktrees', [
      { id: 'repo-a::wt-old' }
    ])
    cache.invalidateResolved()
    await expect(cache.getSnapshot(compute, ttlMs, 0)).resolves.toHaveProperty('worktrees', [
      { id: 'repo-a::wt-old' },
      { id: 'repo-a::wt-new' }
    ])
  })
})
