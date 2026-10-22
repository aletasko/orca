import { randomUUID } from 'node:crypto'

// Why per process: the generation counters below live in memory, so a value is only meaningful
// together with this epoch. A restart mints a new epoch, which means an old (epoch, generation)
// pair can never be re-issued with a different meaning; callers must compare the pair, not the number.
export const WORKTREE_RUNTIME_EPOCH = randomUUID()

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

function beginMutation(
  path: string,
  scope: WorktreeMutationScope,
  unattributedWhenNoInstance: boolean
): () => void {
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
  let settled = false
  return () => {
    if (settled) {
      return
    }
    settled = true
    // Why re-bump the ids resolved up front: the metadata row may already sit under a new locator.
    bumpInstances(instanceIds)
    adjustInFlight(instanceIds, -1)
  }
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
  return beginMutation(path, 'at', true)
}

/**
 * Same contract for generic file rename/delete (explorer, IPC, RPC), where most targets are plain
 * files inside a checkout. Only a target that is, or contains, a registered checkout root counts; a
 * target matching no instance is a no-op. If the runtime cannot resolve instances at all, it is
 * unattributed.
 */
export function bumpWorktreeGenerationBeforePathMutation(path: string): () => void {
  return beginMutation(path, 'at-or-under', false)
}

/** Monotonic within one `WORKTREE_RUNTIME_EPOCH`; follows the instance across a move. */
export function getWorktreeInstanceGeneration(instanceId: string): number {
  return (bumpsByInstanceId.get(instanceId) ?? 0) + unattributedBumps
}

/** True from the pre-mutation bump until `settle`, per instance (plus unattributed mutations). */
export function isWorktreeMutationInFlight(instanceId: string): boolean {
  return unattributedInFlight > 0 || (inFlightByInstanceId.get(instanceId) ?? 0) > 0
}
