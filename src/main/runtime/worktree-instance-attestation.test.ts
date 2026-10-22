import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunnerModule from '../git/runner'
import type * as GitOptionsModule from '../project-runtime-git-options'
import type * as SparseCacheModule from '../git/worktree-sparse-checkout-cache'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { RuntimeWorktreeInstanceAttestation } from '../../shared/runtime-worktree-contracts'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'
import { listInstanceIdsAtPath } from './worktree-instance-attestation'
import {
  WORKTREE_RUNTIME_EPOCH,
  bumpWorktreeGenerationBeforeMutation,
  getWorktreeInstanceGeneration,
  isWorktreeMutationInFlight,
  setWorktreeInstanceResolver
} from '../worktree-instance-generation'

// Why a recorder instead of a mock of the runner: the ordering claim is "the generation had already
// moved when Git started", and only the real runner call can observe that moment.
const gitStarts = vi.hoisted(() => [] as { args: string[]; generation: number | null }[])
const sparseProbeCalls = vi.hoisted(() => [] as unknown[][])
// Lets a test hold `git worktree move` open to observe the in-flight window.
const moveGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }))
const generationProbe = vi.hoisted(() => ({
  instanceId: '',
  read: (_id: string): number => 0
}))
vi.mock('../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof RunnerModule>()
  return {
    ...actual,
    gitExecFileAsync: async (args: string[], ...rest: unknown[]) => {
      if (args.includes('move') || args.includes('remove')) {
        gitStarts.push({ args, generation: generationProbe.read(generationProbe.instanceId) })
        if (args.includes('move')) {
          await moveGate.wait
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the original call signature untouched.
      return (actual.gitExecFileAsync as (...a: unknown[]) => Promise<unknown>)(args, ...rest)
    }
  }
})
vi.mock('../git/worktree-sparse-checkout-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof SparseCacheModule>()
  return {
    ...actual,
    detectSparseCheckoutCached: (...args: Parameters<typeof actual.detectSparseCheckoutCached>) => {
      sparseProbeCalls.push(args)
      return actual.detectSparseCheckoutCached(...args)
    }
  }
})
vi.mock('../project-runtime-git-options', async (importOriginal) => ({
  ...(await importOriginal<typeof GitOptionsModule>()),
  getLocalProjectWorktreeGitOptions: () => ({})
}))

const { moveWorktree } = await import('../git/worktree-move')
const { removeWorktree } = await import('../git/worktree-removal')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com'
}
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' })
}

function baseMeta(overrides: Partial<WorktreeMeta>): WorktreeMeta {
  return {
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

// A cache that must not be consulted: any property read is a test failure.
function forbiddenCache(name: string): object {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`attestation read ${name}.${String(property)}`)
      }
    }
  )
}

type Fixture = {
  root: string
  repoPath: string
  wtPath: string
  repo: Repo
  meta: Record<string, WorktreeMeta>
  runtime: OrcaRuntimeWithListManagedWorktrees
  attest: (instanceId: string) => Promise<RuntimeWorktreeInstanceAttestation>
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-attest-')))
  const repoPath = join(root, 'repo')
  await mkdir(repoPath)
  git(repoPath, 'init', '-q', '-b', 'main')
  git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'init')
  const wtPath = join(root, 'wt-one')
  git(repoPath, 'worktree', 'add', '-q', '-b', 'feature-one', wtPath)
  const repo: Repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
  const meta: Record<string, WorktreeMeta> = {
    [`repo-1::${wtPath}`]: baseMeta({ instanceId: 'inst-1', hostId: 'local' })
  }
  const store = { getRepos: () => [repo], getAllWorktreeMeta: () => meta }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prototype instance stubbed with only the members attestWorktreeInstance touches.
  const runtime = Object.create(
    OrcaRuntimeWithListManagedWorktrees.prototype
  ) as OrcaRuntimeWithListManagedWorktrees
  Object.assign(runtime, {
    requireStore: () => store,
    // Every cache and listing path the normal listing uses: reading any of them fails the test.
    resolvedWorktrees: forbiddenCache('resolvedWorktrees'),
    worktreeScanCache: forbiddenCache('worktreeScanCache'),
    worktreeScanInFlight: forbiddenCache('worktreeScanInFlight'),
    managedWorktreeQueries: forbiddenCache('managedWorktreeQueries'),
    listResolvedWorktrees: () => {
      throw new Error('attestation used the resolved-worktree listing')
    }
  })
  setWorktreeInstanceResolver((path) => listInstanceIdsAtPath(store, path))
  generationProbe.read = getWorktreeInstanceGeneration
  return {
    root,
    repoPath,
    wtPath,
    repo,
    meta,
    runtime,
    attest: (instanceId) => runtime.attestWorktreeInstance(instanceId)
  }
}

describe('worktree.attestInstance runtime attestation', () => {
  let fx: Fixture
  beforeEach(async () => {
    gitStarts.length = 0
    sparseProbeCalls.length = 0
    moveGate.wait = null
    generationProbe.instanceId = 'inst-1'
    fx = await makeFixture()
  })
  afterEach(async () => {
    setWorktreeInstanceResolver(null)
    await rm(fx.root, { recursive: true, force: true })
  })

  it('attests a known instance from a fresh scan and lstat, without touching any cache', async () => {
    const stats = await lstat(fx.wtPath, { bigint: true })
    const result = await fx.attest('inst-1')
    // L1: the scan must not read or populate the sparse-checkout cache either.
    expect(sparseProbeCalls).toEqual([])
    expect(result).toEqual({
      status: 'ok',
      authoritative: true,
      instanceId: 'inst-1',
      executionHostId: 'local',
      path: fx.wtPath,
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      birthtimeNs: stats.birthtimeNs.toString(),
      runtimeEpoch: WORKTREE_RUNTIME_EPOCH,
      generation: expect.any(Number)
    })
  })

  it('keeps no reason on absent/ambiguous/remote so an unknown id and an unusable one look alike', async () => {
    const absent = await fx.attest('nope')
    expect(absent).toEqual({ status: 'absent', authoritative: false })
    fx.repo.executionHostId = 'ssh:box'
    fx.meta[`repo-1::${fx.wtPath}`] = baseMeta({ instanceId: 'inst-1', hostId: 'ssh:box' })
    await expect(fx.attest('inst-1')).resolves.toEqual({ status: 'remote', authoritative: false })
  })

  it('answers absent for an unknown instance and ambiguous for a duplicated id', async () => {
    await expect(fx.attest('nope')).resolves.toMatchObject({
      status: 'absent',
      authoritative: false
    })
    fx.meta[`repo-1::${join(fx.root, 'copy')}`] = baseMeta({
      instanceId: 'inst-1',
      hostId: 'local'
    })
    await expect(fx.attest('inst-1')).resolves.toMatchObject({
      status: 'ambiguous',
      authoritative: false
    })
  })

  it('refuses an instance owned by a non-local execution host', async () => {
    fx.repo.executionHostId = 'ssh:box'
    fx.meta[`repo-1::${fx.wtPath}`] = baseMeta({ instanceId: 'inst-1', hostId: 'ssh:box' })
    await expect(fx.attest('inst-1')).resolves.toMatchObject({
      status: 'remote',
      authoritative: false
    })
  })

  it('reports not-ok for a root replaced by a symlink', async () => {
    const elsewhere = join(fx.root, 'elsewhere')
    await rename(fx.wtPath, elsewhere)
    await symlink(elsewhere, fx.wtPath)
    await expect(fx.attest('inst-1')).resolves.toMatchObject({
      status: 'unsupported',
      authoritative: false,
      reason: 'root_is_symlink'
    })
  })

  it('reports the new inode when the root directory was swapped, so a pinned ino mismatches', async () => {
    const before = await fx.attest('inst-1')
    // Keep the old directory alive so the new one cannot reuse its inode number.
    await rename(fx.wtPath, join(fx.root, 'moved-aside'))
    await mkdir(fx.wtPath)
    const after = await fx.attest('inst-1')
    // Git still lists the registered path; the host answers with whatever is there NOW and the
    // caller's (dev, ino) pin is what refuses it.
    expect(before.status).toBe('ok')
    expect(after.status).toBe('ok')
    if (before.status === 'ok' && after.status === 'ok') {
      expect(after.ino).not.toBe(before.ino)
    }
  })

  it('raises the generation before git move and before git remove start', async () => {
    const start = getWorktreeInstanceGeneration('inst-1')
    const newPath = join(fx.root, 'wt-renamed')
    await moveWorktree(fx.repoPath, fx.wtPath, newPath)
    const moveStart = gitStarts.find((entry) => entry.args.includes('move'))
    expect(moveStart?.generation).toBeGreaterThan(start)

    const afterMove = getWorktreeInstanceGeneration('inst-1')
    // Once before Git starts, once when the move settles.
    expect(afterMove).toBe(start + 2)
    // The instance keeps its generation line across the move; the locator is what changes.
    delete fx.meta[`repo-1::${fx.wtPath}`]
    fx.meta[`repo-1::${newPath}`] = baseMeta({ instanceId: 'inst-1', hostId: 'local' })
    const moved = await fx.attest('inst-1')
    expect(moved).toMatchObject({ status: 'ok', path: newPath, generation: afterMove })

    await removeWorktree(fx.repoPath, newPath, true)
    const removeStart = gitStarts.find((entry) => entry.args.includes('remove'))
    expect(removeStart?.generation).toBeGreaterThan(afterMove)
    expect(existsSync(newPath)).toBe(false)
    expect(getWorktreeInstanceGeneration('inst-1')).toBeGreaterThan(afterMove)
  })

  it('bumps every generation when a mutated path cannot be tied to an instance', () => {
    const before = getWorktreeInstanceGeneration('inst-1')
    // No metadata row for this path: deny-safe means outstanding attestations all go stale.
    return moveWorktree(fx.repoPath, join(fx.root, 'not-a-worktree'), join(fx.root, 'x'))
      .catch(() => undefined)
      .then(() => {
        expect(getWorktreeInstanceGeneration('inst-1')).toBeGreaterThan(before)
      })
  })

  it('refuses when a mutation begins while the attestation is in flight', async () => {
    const pending = fx.attest('inst-1')
    // Same tick as the call: the attestation has read its generation and is awaiting Git.
    setWorktreeInstanceResolver(() => ['inst-1'])
    const settle = bumpWorktreeGenerationBeforeMutation(fx.wtPath)
    // Settle straight away: this test models a mutation that began and ended inside the attestation.
    settle()
    await expect(pending).resolves.toMatchObject({
      status: 'unsupported',
      authoritative: false,
      reason: 'changed_during_attestation'
    })
  })

  it('refuses with mutation_in_flight while git move is running and recovers once it settles', async () => {
    let release!: () => void
    moveGate.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const newPath = join(fx.root, 'wt-moving')
    const moving = moveWorktree(fx.repoPath, fx.wtPath, newPath)
    try {
      // The pre-bump has run; Git is parked on the gate. Without the in-flight mark this answers ok.
      await vi.waitFor(() =>
        expect(gitStarts.some((entry) => entry.args.includes('move'))).toBe(true)
      )
      await expect(fx.attest('inst-1')).resolves.toEqual({
        status: 'unsupported',
        authoritative: false,
        reason: 'mutation_in_flight'
      })
    } finally {
      release()
      await moving
    }
    expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
    delete fx.meta[`repo-1::${fx.wtPath}`]
    fx.meta[`repo-1::${newPath}`] = baseMeta({ instanceId: 'inst-1', hostId: 'local' })
    await expect(fx.attest('inst-1')).resolves.toMatchObject({ status: 'ok', path: newPath })
  })

  it('clears the in-flight mark in finally even when the mutation fails', async () => {
    await moveWorktree(fx.repoPath, fx.wtPath, '/proc/forbidden/never').catch(() => undefined)
    expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
    await expect(fx.attest('inst-1')).resolves.toMatchObject({ status: 'ok' })
  })

  it('scopes the in-flight mark to the mutated instance', async () => {
    const settle = bumpWorktreeGenerationBeforeMutation(fx.wtPath)
    try {
      expect(isWorktreeMutationInFlight('inst-1')).toBe(true)
      expect(isWorktreeMutationInFlight('inst-other')).toBe(false)
    } finally {
      settle()
    }
    expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
  })

  it('reports a birth time that differs when a root is recreated with the same (dev, ino)', async () => {
    // Best-effort detector only: the gap between attestations here is several ms. An immediate
    // recreation (same filesystem tick) can keep the same birth time (85% measured on ext4), so this
    // does not prove uniqueness; the broker's held O_PATH|O_NOFOLLOW fd is the real guarantee.
    const before = await fx.attest('inst-1')
    if (before.status !== 'ok') {
      throw new Error('fixture attestation must be ok')
    }
    expect(before.birthtimeNs).toMatch(/^\d+$/)
    // Delete and recreate until the filesystem hands the freed inode back (ext4 does at once).
    let reused: RuntimeWorktreeInstanceAttestation | null = null
    await rm(fx.wtPath, { recursive: true, force: true })
    for (let attempt = 0; attempt < 50 && !reused; attempt += 1) {
      await mkdir(fx.wtPath)
      const candidate = await fx.attest('inst-1')
      if (candidate.status === 'ok' && candidate.ino === before.ino) {
        reused = candidate
      } else {
        await rm(fx.wtPath, { recursive: true, force: true })
      }
    }
    // Where the inode was not reused (other filesystems) the pair differs anyway; the birth time
    // must differ in both cases.
    const recreated =
      reused ??
      (await (async () => {
        await mkdir(fx.wtPath, { recursive: true })
        return fx.attest('inst-1')
      })())
    expect(recreated.status).toBe('ok')
    if (recreated.status === 'ok') {
      expect(recreated.birthtimeNs).not.toBe(before.birthtimeNs)
    }
  })
})

describe('runtimeEpoch and generation across a restart', () => {
  it('mints a new epoch and restarts the counter, so only the pair is comparable', async () => {
    const first = await import('../worktree-instance-generation')
    first.setWorktreeInstanceResolver(() => ['inst-9'])
    first.bumpWorktreeGenerationBeforeMutation('/x')
    expect(first.getWorktreeInstanceGeneration('inst-9')).toBeGreaterThan(0)
    vi.resetModules()
    const second = await import('../worktree-instance-generation')
    expect(second.WORKTREE_RUNTIME_EPOCH).not.toBe(first.WORKTREE_RUNTIME_EPOCH)
    expect(second.getWorktreeInstanceGeneration('inst-9')).toBe(0)
  })
})
