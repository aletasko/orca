import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listInstanceIdsAtPath } from './worktree-instance-attestation'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  bumpWorktreeGenerationBeforePathMutation,
  getWorktreeInstanceGeneration,
  isWorktreeMutationInFlight,
  setWorktreeInstanceResolver
} from '../worktree-instance-generation'
import { renameLocalPathSerializedByDestination } from '../destination-serialized-local-rename'

// Authorization is not under test: the point is what happens to the generation around the delete.
vi.mock('../ipc/filesystem-auth', () => ({
  resolveAuthorizedPath: async (path: string) => path
}))

const { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } =
  await import('./runtime-file-commands-create-file-explorer-dir-no-clobber')

function meta(instanceId: string): WorktreeMeta {
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
    instanceId,
    hostId: 'local'
  }
}

describe('generic file rename/delete over a worktree root', () => {
  let base: string
  let wtPath: string
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'orca-root-mut-')))
    wtPath = join(base, 'group', 'wt')
    await mkdir(wtPath, { recursive: true })
    await writeFile(join(wtPath, 'file.txt'), 'x')
    const store = {
      getRepos: () => [],
      getAllWorktreeMeta: () => ({ [`repo-1::${wtPath}`]: meta('inst-1') })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver only reads getRepos/getAllWorktreeMeta.
    setWorktreeInstanceResolver((path, scope) => listInstanceIdsAtPath(store as never, path, scope))
  })
  afterEach(async () => {
    setWorktreeInstanceResolver(null)
    await rm(base, { recursive: true, force: true })
  })

  function commands(): InstanceType<typeof RuntimeFileCommandsWithCreateFileExplorerDirNoClobber> {
    const instance = Object.create(
      RuntimeFileCommandsWithCreateFileExplorerDirNoClobber.prototype
    ) as InstanceType<typeof RuntimeFileCommandsWithCreateFileExplorerDirNoClobber>
    Object.assign(instance, {
      host: { requireStore: () => ({}) },
      resolveFileExplorerPath: async (_selector: string, relativePath: string) => ({
        worktree: {},
        path: relativePath === '' ? wtPath : join(wtPath, relativePath),
        executionHostId: 'local'
      }),
      resolveFileExplorerPaths: async (_selector: string, relativePaths: string[]) =>
        relativePaths.map((relativePath) => ({
          worktree: {},
          path: relativePath === '' ? wtPath : join(wtPath, relativePath),
          executionHostId: 'local'
        }))
    })
    return instance
  }

  it('files.delete with an empty relativePath deletes the root and bumps the generation first', async () => {
    const start = getWorktreeInstanceGeneration('inst-1')
    await commands().deleteFileExplorerPath('wt', '', true, undefined, undefined, 'local')
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start + 2)
    expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
  })

  it('files.delete of an ordinary file inside the checkout does not bump', async () => {
    const start = getWorktreeInstanceGeneration('inst-1')
    await commands().deleteFileExplorerPath('wt', 'file.txt', false, undefined, undefined, 'local')
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start)
  })

  it('files.rename of the root bumps; renaming a file inside does not', async () => {
    const start = getWorktreeInstanceGeneration('inst-1')
    await commands().renameFileExplorerPath(
      'wt',
      'file.txt',
      'renamed.txt',
      undefined,
      undefined,
      'local'
    )
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start)
    await renameLocalPathSerializedByDestination(wtPath, join(base, 'group', 'wt-moved'))
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start + 2)
    expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
  })

  it('renaming an ANCESTOR directory of the root bumps the nested instance', async () => {
    const start = getWorktreeInstanceGeneration('inst-1')
    await renameLocalPathSerializedByDestination(join(base, 'group'), join(base, 'group-renamed'))
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start + 2)
  })

  it('does not match a sibling whose name merely starts with the mutated path', async () => {
    const start = getWorktreeInstanceGeneration('inst-1')
    await mkdir(join(base, 'gro'))
    await renameLocalPathSerializedByDestination(join(base, 'gro'), join(base, 'gro2'))
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start)
  })

  it.each([
    [
      'throws',
      () =>
        setWorktreeInstanceResolver(() => {
          throw new Error('resolver broke')
        })
    ],
    ['is absent', () => setWorktreeInstanceResolver(null)]
  ])(
    'blocks every instance when the resolver %s on an at-or-under path',
    async (_name, arrange) => {
      arrange()
      const start = getWorktreeInstanceGeneration('inst-1')
      // Not tied to any instance by path: only the failing resolver can make this "unattributed".
      const settle = bumpWorktreeGenerationBeforePathMutation(join(base, 'elsewhere'))
      expect(getWorktreeInstanceGeneration('inst-1')).toBe(start + 1)
      expect(isWorktreeMutationInFlight('inst-1')).toBe(true)
      expect(isWorktreeMutationInFlight('some-other-instance')).toBe(true)
      settle()
      expect(getWorktreeInstanceGeneration('inst-1')).toBe(start + 2)
      expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
      expect(isWorktreeMutationInFlight('some-other-instance')).toBe(false)
    }
  )

  it('blocks and bumps through a real rename when the resolver throws', async () => {
    setWorktreeInstanceResolver(() => {
      throw new Error('resolver broke')
    })
    await mkdir(join(base, 'plain'))
    const start = getWorktreeInstanceGeneration('inst-1')
    await renameLocalPathSerializedByDestination(join(base, 'plain'), join(base, 'plain2'))
    expect(getWorktreeInstanceGeneration('inst-1')).toBe(start + 2)
    expect(isWorktreeMutationInFlight('inst-1')).toBe(false)
  })
})
