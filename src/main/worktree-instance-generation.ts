import { randomUUID } from 'node:crypto'

// Why per process: the generation counters below live in memory, so a value is only meaningful
// together with this epoch. A restart mints a new epoch, which means an old (epoch, generation)
// pair can never be re-issued with a different meaning; callers must compare the pair, not the number.
export const WORKTREE_RUNTIME_EPOCH = randomUUID()

/** Instance ids whose checkout lives at `path`, or null when the runtime cannot tell. */
type InstanceIdsAtPath = (path: string) => readonly string[] | null

let resolveInstanceIdsAtPath: InstanceIdsAtPath | null = null
const bumpsByInstanceId = new Map<string, number>()
// Why a shared term: a mutation whose path cannot be tied to an instance must still invalidate
// every outstanding attestation, never none of them.
let unattributedBumps = 0

export function setWorktreeInstanceResolver(resolver: InstanceIdsAtPath | null): void {
  resolveInstanceIdsAtPath = resolver
}

function bumpInstances(instanceIds: readonly string[] | null): void {
  if (!instanceIds || instanceIds.length === 0) {
    unattributedBumps += 1
    return
  }
  for (const instanceId of instanceIds) {
    bumpsByInstanceId.set(instanceId, (bumpsByInstanceId.get(instanceId) ?? 0) + 1)
  }
}

/**
 * Call synchronously BEFORE a move, remove, or other root change of the checkout at `path`, ahead
 * of the first await or subprocess. A bump after the filesystem change would let an attestation
 * taken in between still describe the old root as current.
 *
 * Returns `settle`, to call in a `finally` once the mutation ended. Why a second bump: an attestation
 * taken while the mutation was in flight carries the first bump's value and may describe the old root;
 * the settle bump makes it stale. It re-bumps the instances resolved up front, because the metadata
 * row may already sit under a new locator by then.
 */
export function bumpWorktreeGenerationBeforeMutation(path: string): () => void {
  let instanceIds: readonly string[] | null = null
  try {
    instanceIds = resolveInstanceIdsAtPath?.(path) ?? null
  } catch {
    instanceIds = null
  }
  bumpInstances(instanceIds)
  return () => bumpInstances(instanceIds)
}

/** Monotonic within one `WORKTREE_RUNTIME_EPOCH`; follows the instance across a move. */
export function getWorktreeInstanceGeneration(instanceId: string): number {
  return (bumpsByInstanceId.get(instanceId) ?? 0) + unattributedBumps
}
