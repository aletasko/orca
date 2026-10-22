// Every place where Orca itself moves or removes a worktree root must publish `will-change` and give a
// subscriber its bounded chance to acknowledge BEFORE the filesystem changes. Real git and a real
// filesystem: the proof of order is that the root is still in place while the mutation waits.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeChangeEvent } from '../shared/worktree/change-notification'
import {
  acknowledgeWorktreeWillChange,
  configureWorktreeChangeNotifier,
  getWorktreeChangeAckTimeouts,
  resetWorktreeChangeNotifierForTests,
  watchWorktreeChanges
} from './worktree-change-notifier'
import {
  isWorktreeMutationInFlight,
  setWorktreeInstanceResolver
} from './worktree-instance-generation'
import { moveWorktree, removeWorktree } from './git/worktree'
import { finishUnregisteredWorktreeRemoval } from './git/worktree-removal'
import { removeLocalWorktreePath } from './local-worktree-filesystem'
import { renameLocalPathSerializedByDestination } from './destination-serialized-local-rename'

// Authorization is not under test here.
vi.mock('./ipc/filesystem-auth', () => ({
  resolveAuthorizedPath: async (path: string) => path
}))

const { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } =
  await import('./runtime/runtime-file-commands-create-file-explorer-dir-no-clobber')

const execFileAsync = promisify(execFile)
const SUBSCRIBER = 'path-subscriber-0123456789'
const INSTANCE = 'inst-path'

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

type Expected = { op: 'move' | 'remove'; path: string }

/**
 * Runs `mutate` with a subscriber that does not acknowledge until the test says so. Asserts that the
 * will-change event is out, that the filesystem has not changed and the mutation has not finished
 * while it is unacknowledged, then acknowledges and checks the mutation completed and `changed` follows.
 */
async function expectAnnouncedBeforeChange(
  expected: Expected,
  mutate: () => Promise<unknown>,
  filesystem: { unchanged: () => Promise<void>; changed: () => Promise<void> }
): Promise<void> {
  const registered = await watchWorktreeChanges({ subscriberId: SUBSCRIBER, timeoutMs: 0 })
  if (registered.status !== 'ok') {
    throw new Error('subscriber refused')
  }
  const mutation = mutate()
  let finished = false
  void mutation.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    }
  )

  const willChange = await watchWorktreeChanges({
    subscriberId: SUBSCRIBER,
    afterSeq: registered.lastSeq,
    epoch: registered.epoch,
    timeoutMs: 10_000
  })
  if (willChange.status !== 'ok') {
    throw new Error('poll refused')
  }
  expect(willChange.events).toEqual([
    {
      event: 'will-change',
      instanceId: INSTANCE,
      path: expected.path,
      op: expected.op,
      seq: expect.any(Number)
    }
  ])
  const seq = willChange.events[0]!.seq

  // Give the mutation every chance to run ahead of the acknowledgement.
  await new Promise((resolve) => setTimeout(resolve, 150))
  await filesystem.unchanged()
  expect(finished).toBe(false)
  expect(isWorktreeMutationInFlight(INSTANCE)).toBe(true)

  expect(acknowledgeWorktreeWillChange(SUBSCRIBER, [seq])).toBe(1)
  await mutation
  await filesystem.changed()

  const changed = await watchWorktreeChanges({
    subscriberId: SUBSCRIBER,
    afterSeq: willChange.lastSeq,
    timeoutMs: 5000
  })
  expect(changed.status === 'ok' && changed.events).toEqual([
    {
      event: 'changed',
      instanceId: INSTANCE,
      path: expected.path,
      op: expected.op,
      seq: expect.any(Number),
      willChangeSeq: seq
    } satisfies WorktreeChangeEvent
  ])
  expect(isWorktreeMutationInFlight(INSTANCE)).toBe(false)
}

describe('pre-change notification at every Orca move/remove path', () => {
  let base: string
  let repoPath: string
  let worktreePath: string

  beforeEach(async () => {
    resetWorktreeChangeNotifierForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureWorktreeChangeNotifier({ ackTimeoutMs: 20_000 })
    base = await realpath(await mkdtemp(join(tmpdir(), 'orca-change-paths-')))
    repoPath = join(base, 'repo')
    worktreePath = join(base, 'workspaces', 'wt')
    await mkdir(repoPath, { recursive: true })
    await mkdir(join(base, 'workspaces'), { recursive: true })
    await git(['init', '-q'], repoPath)
    await git(['config', 'user.email', 'change@example.invalid'], repoPath)
    await git(['config', 'user.name', 'Change Paths'], repoPath)
    await git(['config', 'maintenance.auto', 'false'], repoPath)
    await git(['config', 'gc.auto', '0'], repoPath)
    await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
    await git(['add', '-A'], repoPath)
    await git(['commit', '-qm', 'seed'], repoPath)
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
    setWorktreeInstanceResolver((path) => (path === worktreePath ? [INSTANCE] : []))
  })
  afterEach(async () => {
    setWorktreeInstanceResolver(null)
    resetWorktreeChangeNotifierForTests()
    vi.restoreAllMocks()
    await rm(base, { recursive: true, force: true })
  })

  it('git worktree move (moveWorktree: first-work folder rename)', async () => {
    const newPath = join(base, 'workspaces', 'wt-moved')
    await expectAnnouncedBeforeChange(
      { op: 'move', path: worktreePath },
      () => moveWorktree(repoPath, worktreePath, newPath),
      {
        unchanged: async () => {
          expect(await exists(join(worktreePath, '.git'))).toBe(true)
          expect(await exists(newPath)).toBe(false)
        },
        changed: async () => {
          expect(await exists(worktreePath)).toBe(false)
          expect(await exists(join(newPath, '.git'))).toBe(true)
        }
      }
    )
  })

  it('git worktree remove (removeWorktree: UI worktrees:remove, CLI worktree rm, creation rollback)', async () => {
    await expectAnnouncedBeforeChange(
      { op: 'remove', path: worktreePath },
      () => removeWorktree(repoPath, worktreePath, true, { deleteBranch: false }),
      {
        unchanged: async () => {
          expect(await exists(join(worktreePath, '.git'))).toBe(true)
        },
        changed: async () => {
          expect(await exists(worktreePath)).toBe(false)
        }
      }
    )
  })

  it('finishing an unregistered removal (finishUnregisteredWorktreeRemoval)', async () => {
    // Git no longer registers this checkout; only its leftover directory remains.
    await git(['worktree', 'remove', '--force', worktreePath], repoPath)
    await mkdir(worktreePath)
    await writeFile(join(worktreePath, 'leftover.txt'), 'x')
    await expectAnnouncedBeforeChange(
      { op: 'remove', path: worktreePath },
      () => finishUnregisteredWorktreeRemoval(repoPath, worktreePath, null, async () => {}),
      {
        unchanged: async () => {
          expect(await exists(join(worktreePath, 'leftover.txt'))).toBe(true)
        },
        changed: async () => {
          expect(await exists(worktreePath)).toBe(false)
        }
      }
    )
  })

  it('direct folder removal (removeLocalWorktreePath: orphan cleanup, removal recovery)', async () => {
    await expectAnnouncedBeforeChange(
      { op: 'remove', path: worktreePath },
      () => removeLocalWorktreePath(worktreePath),
      {
        unchanged: async () => {
          expect(await exists(join(worktreePath, '.git'))).toBe(true)
        },
        changed: async () => {
          expect(await exists(worktreePath)).toBe(false)
        }
      }
    )
  })

  it('rename of the root (renameLocalPathSerializedByDestination: fs:rename, files.rename)', async () => {
    const newPath = join(base, 'workspaces', 'wt-renamed')
    await expectAnnouncedBeforeChange(
      { op: 'move', path: worktreePath },
      () => renameLocalPathSerializedByDestination(worktreePath, newPath),
      {
        unchanged: async () => {
          expect(await exists(worktreePath)).toBe(true)
          expect(await exists(newPath)).toBe(false)
        },
        changed: async () => {
          expect(await exists(worktreePath)).toBe(false)
          expect(await exists(newPath)).toBe(true)
        }
      }
    )
  })

  it('rename of an ANCESTOR directory announces the nested instance', async () => {
    const parent = join(base, 'workspaces')
    const renamedParent = join(base, 'workspaces-renamed')
    setWorktreeInstanceResolver((path, scope) =>
      scope === 'at-or-under' && path === parent ? [INSTANCE] : []
    )
    await expectAnnouncedBeforeChange(
      { op: 'move', path: parent },
      () => renameLocalPathSerializedByDestination(parent, renamedParent),
      {
        unchanged: async () => {
          expect(await exists(worktreePath)).toBe(true)
        },
        changed: async () => {
          expect(await exists(parent)).toBe(false)
        }
      }
    )
  })

  describe('files.delete / files.rename (runtime file commands)', () => {
    function commands(): InstanceType<
      typeof RuntimeFileCommandsWithCreateFileExplorerDirNoClobber
    > {
      const instance = Object.create(
        RuntimeFileCommandsWithCreateFileExplorerDirNoClobber.prototype
      ) as InstanceType<typeof RuntimeFileCommandsWithCreateFileExplorerDirNoClobber>
      Object.assign(instance, {
        host: { requireStore: () => ({}) },
        resolveFileExplorerPath: async (_selector: string, relativePath: string) => ({
          worktree: {},
          path: relativePath === '' ? worktreePath : join(worktreePath, relativePath),
          executionHostId: 'local'
        })
      })
      return instance
    }

    it('files.delete of the root (empty relativePath)', async () => {
      await expectAnnouncedBeforeChange(
        { op: 'remove', path: worktreePath },
        () => commands().deleteFileExplorerPath('wt', '', true, undefined, undefined, 'local'),
        {
          unchanged: async () => {
            expect(await exists(join(worktreePath, '.git'))).toBe(true)
          },
          changed: async () => {
            expect(await exists(worktreePath)).toBe(false)
          }
        }
      )
    })

    it('a delete or rename of an ordinary file inside announces nothing and waits for nothing', async () => {
      configureWorktreeChangeNotifier({ ackTimeoutMs: 20_000 })
      const registered = await watchWorktreeChanges({ subscriberId: SUBSCRIBER, timeoutMs: 0 })
      await writeFile(join(worktreePath, 'plain.txt'), 'x')
      const started = Date.now()
      await commands().deleteFileExplorerPath(
        'wt',
        'plain.txt',
        false,
        undefined,
        undefined,
        'local'
      )
      expect(Date.now() - started).toBeLessThan(2000)
      const poll = await watchWorktreeChanges({
        subscriberId: SUBSCRIBER,
        afterSeq: registered.status === 'ok' ? registered.lastSeq : 0,
        timeoutMs: 0
      })
      expect(poll.status === 'ok' && poll.events).toEqual([])
    })
  })

  describe('bounded wait', () => {
    it('a subscriber that never acknowledges delays the move by the configured timeout, no longer', async () => {
      configureWorktreeChangeNotifier({ ackTimeoutMs: 300 })
      const registered = await watchWorktreeChanges({ subscriberId: SUBSCRIBER, timeoutMs: 0 })
      const newPath = join(base, 'workspaces', 'wt-timeout')
      const started = Date.now()
      await moveWorktree(repoPath, worktreePath, newPath)
      const waited = Date.now() - started
      // Lower bound: it did wait. Upper bound: timeout + a generous allowance for git itself.
      expect(waited).toBeGreaterThanOrEqual(280)
      expect(waited).toBeLessThan(300 + 5000)
      expect(await exists(join(newPath, '.git'))).toBe(true)

      expect(getWorktreeChangeAckTimeouts().total).toBe(1)
      const poll = await watchWorktreeChanges({
        subscriberId: SUBSCRIBER,
        afterSeq: registered.status === 'ok' ? registered.lastSeq : 0,
        timeoutMs: 0
      })
      expect(poll.status === 'ok' && poll.events.map((event) => event.event)).toEqual([
        'will-change',
        'changed'
      ])
      expect(poll.status === 'ok' && poll.events[1]).toMatchObject({ ackTimedOut: true })
    })

    it('no subscriber: the move does not wait at all', async () => {
      configureWorktreeChangeNotifier({ ackTimeoutMs: 20_000 })
      const newPath = join(base, 'workspaces', 'wt-nosub')
      const started = Date.now()
      await moveWorktree(repoPath, worktreePath, newPath)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(getWorktreeChangeAckTimeouts().total).toBe(0)
    })

    it('a failed move still publishes changed and clears the in-flight mark', async () => {
      configureWorktreeChangeNotifier({ ackTimeoutMs: 0 })
      const registered = await watchWorktreeChanges({ subscriberId: SUBSCRIBER, timeoutMs: 0 })
      await expect(
        moveWorktree(repoPath, worktreePath, join('/proc', 'forbidden', 'never'))
      ).rejects.toThrow()
      const poll = await watchWorktreeChanges({
        subscriberId: SUBSCRIBER,
        afterSeq: registered.status === 'ok' ? registered.lastSeq : 0,
        timeoutMs: 0
      })
      expect(poll.status === 'ok' && poll.events.map((event) => event.event)).toEqual([
        'will-change',
        'changed'
      ])
      expect(isWorktreeMutationInFlight(INSTANCE)).toBe(false)
    })
  })
})

describe('no production mutation path bypasses the notification', () => {
  it('only the generation module itself may call the un-notified bump functions', () => {
    const root = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'renderer') {
            walk(full)
          }
        } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8')
          if (
            /bumpWorktreeGenerationBefore(Path)?Mutation\(/.test(text) &&
            !full.endsWith(join('main', 'worktree-instance-generation.ts'))
          ) {
            offenders.push(relative(root, full))
          }
        }
      }
    }
    walk(root)
    expect(existsSync(join(root, 'main', 'worktree-instance-generation.ts'))).toBe(true)
    expect(offenders).toEqual([])
  })
})
