import type { WorktreeChangeOp } from '../shared/worktree/change-notification'
import {
  announceWorktreeChanged,
  announceWorktreeWillChange,
  type WorktreeWillChangeAnnouncement
} from './worktree-change-notifier'
import { WORKTREE_RUNTIME_EPOCH } from './worktree-runtime-epoch'

export { WORKTREE_RUNTIME_EPOCH }

/**
 * `at`: the checkout whose root IS `path` (git-layer move/remove).
 * `at-or-under`: also checkouts nested below `path`, because renaming or deleting an ancestor
 * directory moves their roots too (generic file rename/delete).
 */
export type WorktreeMutationScope = 'at' | 'at-or-under'

/** Instance ids whose checkout lives in `scope` of `path`, or null when the runtime cannot tell. */
type InstanceIdsAtPath = (path: string, scope: WorktreeMutationScope) => readonly string[] | null

let resolveInstanceIdsAtPath: InstanceIdsAtPath | null = null
const bumpsByInstanceId = new Map<string, number>()
// Mutations begun and not yet settled, per instance. Why a count: two overlapping mutations of the
// same root must both settle before the instance may be attested again.
const inFlightByInstanceId = new Map<string, number>()
// Why shared terms: a mutation whose path cannot be tied to an instance must still invalidate and
// block every outstanding attestation, never none of them.
let unattributedBumps = 0
let unattributedInFlight = 0

export function setWorktreeInstanceResolver(resolver: InstanceIdsAtPath | null): void {
  resolveInstanceIdsAtPath = resolver
}

function bumpInstances(instanceIds: readonly string[] | null): void {
  if (!instanceIds) {
    unattributedBumps += 1
    return
  }
  for (const instanceId of instanceIds) {
    bumpsByInstanceId.set(instanceId, (bumpsByInstanceId.get(instanceId) ?? 0) + 1)
  }
}

function adjustInFlight(instanceIds: readonly string[] | null, delta: 1 | -1): void {
  if (!instanceIds) {
    unattributedInFlight += delta
    return
  }
  for (const instanceId of instanceIds) {
    const next = (inFlightByInstanceId.get(instanceId) ?? 0) + delta
    if (next <= 0) {
      inFlightByInstanceId.delete(instanceId)
    } else {
      inFlightByInstanceId.set(instanceId, next)
    }
  }
}

type BegunMutation = {
  settle: () => void
  /** Resolves when the pre-change acknowledgement wait ended; never rejects. Already resolved without a notified op. */
  acknowledged: Promise<void>
}

function beginMutation(
  path: string,
  scope: WorktreeMutationScope,
  unattributedWhenNoInstance: boolean,
  notifyOp?: WorktreeChangeOp
): BegunMutation {
  let instanceIds: readonly string[] | null = null
  try {
    instanceIds = resolveInstanceIdsAtPath?.(path, scope) ?? null
  } catch {
    instanceIds = null
  }
  if (instanceIds && instanceIds.length === 0 && unattributedWhenNoInstance) {
    instanceIds = null
  }
  bumpInstances(instanceIds)
  adjustInFlight(instanceIds, 1)
  // Why after the bump: the in-flight mark already refuses attestation while subscribers revoke, so a
  // subscriber cannot re-pin the root during the acknowledgement wait.
  // null (unattributed) is announced as one event with no instance id: "everything may be affected".
  const targets: readonly (string | null)[] | null = notifyOp ? (instanceIds ?? [null]) : null
  let willChange: WorktreeWillChangeAnnouncement | null = null
  if (notifyOp && targets) {
    try {
      willChange = announceWorktreeWillChange(targets, path, notifyOp)
    } catch (error) {
      // Why swallowed: Orca's own move/remove must never fail or hang because of a subscriber.
      console.warn('[worktree-change] will-change announcement failed; proceeding', error)
    }
  }
  const acknowledged = (willChange?.settled ?? Promise.resolve()).then(
    () => undefined,
    () => undefined
  )
  let settled = false
  const settle = (): void => {
    if (settled) {
      return
    }
    settled = true
    // Why re-bump the ids resolved up front: the metadata row may already sit under a new locator.
    bumpInstances(instanceIds)
    adjustInFlight(instanceIds, -1)
    if (notifyOp && targets) {
      try {
        announceWorktreeChanged(targets, path, notifyOp, willChange)
      } catch (error) {
        console.warn('[worktree-change] changed announcement failed', error)
      }
    }
  }
  return { settle, acknowledged }
}

/**
 * Call synchronously BEFORE a git-layer move, remove, or other root change of the checkout at
 * `path`, ahead of the first await or subprocess. A bump after the filesystem change would let an
 * attestation taken in between still describe the old root as current.
 *
 * Returns `settle`, to call in a `finally` once the mutation ended. It does two things: it bumps
 * again (an attestation taken while the mutation ran carries the first value) and it clears the
 * in-flight mark. Until then `isWorktreeMutationInFlight` is true, so the attestation RPC refuses
 * instead of describing the old root as current. A path that matches no instance is treated as
 * unattributed: it bumps and blocks every instance.
 */
export function bumpWorktreeGenerationBeforeMutation(path: string): () => void {
  return beginMutation(path, 'at', true).settle
}

/**
 * Same contract for generic file rename/delete (explorer, IPC, RPC), where most targets are plain
 * files inside a checkout. Only a target that is, or contains, a registered checkout root counts; a
 * target matching no instance is a no-op. If the runtime cannot resolve instances at all, it is
 * unattributed.
 *
 * NOT covered (the generation does not move; the attestation's re-read and the broker's held fd
 * are the only protection):
 * - Changes made outside Orca: `rm`, `mv`, `git worktree move/remove` from a shell.
 * - `files.commitUpload` (copy + `rm` of a temp), `fs:copy`, the rollback `rename` in
 *   filesystem-download-promotion (including `promoteDownloadedFile` over an existing destination),
 *   creation cleanup in worktree-apfs-clone and repo-creation-handlers: none moves or removes an
 *   existing attestable root in normal use.
 * - A rename whose DESTINATION overwrites a root (needs an empty directory; a root holds `.git`).
 * - SSH/remote hosts: the host answers `remote`, which is already a refusal.
 * - L-R2: matching is lexical, not resolved. `isPathAtOrUnder` normalizes with posix resolve and
 *   does no `realpath` and no case folding. A locator registered through a symlinked ancestor, or
 *   with a different case on a case-insensitive filesystem (macOS), does not match the mutated
 *   path, so the bump is a silent no-op, not an unattributed block.
 * - L-R3: a mutation promise that never settles (hung git, `rm` stuck on NFS) leaves the instance
 *   (every instance, for an unattributed one) `mutation_in_flight` until the process restarts.
 *   There is no timeout. Deny-safe, but it can block attestation indefinitely.
 */
export function bumpWorktreeGenerationBeforePathMutation(path: string): () => void {
  return beginMutation(path, 'at-or-under', false).settle
}

/**
 * `bumpWorktreeGenerationBeforeMutation` plus the pre-change notification: publishes `will-change`
 * synchronously (same before-the-first-await guarantee as the bump), then waits for the current
 * subscribers' acknowledgements, bounded by the notifier's timeout, and only then resolves with
 * `settle`. `settle` bumps, clears the in-flight mark and publishes `changed`. The caller changes the
 * filesystem only after this resolves; it never rejects and never waits when nobody subscribes.
 */
export async function beginNotifiedWorktreeMutation(
  path: string,
  op: WorktreeChangeOp
): Promise<() => void> {
  const begun = beginMutation(path, 'at', true, op)
  await begun.acknowledged
  return begun.settle
}

/** Same for generic file rename/delete: a target that is, or contains, no checkout root announces nothing. */
export async function beginNotifiedWorktreePathMutation(
  path: string,
  op: WorktreeChangeOp
): Promise<() => void> {
  const begun = beginMutation(path, 'at-or-under', false, op)
  await begun.acknowledged
  return begun.settle
}

/** Monotonic within one `WORKTREE_RUNTIME_EPOCH`; follows the instance across a move. */
export function getWorktreeInstanceGeneration(instanceId: string): number {
  return (bumpsByInstanceId.get(instanceId) ?? 0) + unattributedBumps
}

/** True from the pre-mutation bump until `settle`, per instance (plus unattributed mutations). */
export function isWorktreeMutationInFlight(instanceId: string): boolean {
  return unattributedInFlight > 0 || (inFlightByInstanceId.get(instanceId) ?? 0) > 0
}
