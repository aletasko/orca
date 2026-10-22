import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunnerModule from '../git/runner'
import type * as GitOptionsModule from '../project-runtime-git-options'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { RuntimeWorktreeInstanceAttestation } from '../../shared/runtime-worktree-contracts'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'
import { listInstanceIdsAtPath } from './worktree-instance-attestation'
import {
  WORKTREE_RUNTIME_EPOCH,
  bumpWorktreeGenerationBeforeMutation,
  getWorktreeInstanceGeneration,
  setWorktreeInstanceResolver
} from '../worktree-instance-generation'

// Why a recorder instead of a mock of the runner: the ordering claim is "the generation had already
// moved when Git started", and only the real runner call can observe that moment.
const gitStarts = vi.hoisted(() => [] as { args: string[]; generation: number | null }[])
const generationProbe = vi.hoisted(() => ({
  instanceId: '',
  read: (_id: string): number => 0
}))
vi.mock('../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof RunnerModule>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], ...rest: unknown[]) => {
      if (args.includes('move') || args.includes('remove')) {
        gitStarts.push({ args, generation: generationProbe.read(generationProbe.instanceId) })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the original call signature untouched.
      return (actual.gitExecFileAsync as (...a: unknown[]) => Promise<unknown>)(args, ...rest)
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
    expect(result).toEqual({
      status: 'ok',
      authoritative: true,
      instanceId: 'inst-1',
      executionHostId: 'local',
      path: fx.wtPath,
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      runtimeEpoch: WORKTREE_RUNTIME_EPOCH,
      generation: expect.any(Number)
    })
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
    bumpWorktreeGenerationBeforeMutation(fx.wtPath)
    await expect(pending).resolves.toMatchObject({
      status: 'unsupported',
      authoritative: false,
      reason: 'changed_during_attestation'
    })
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
