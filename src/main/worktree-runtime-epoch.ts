import { randomUUID } from 'node:crypto'

// Why per process: the generation counters and the change-notification sequence live in memory, so a
// value is only meaningful together with this epoch. A restart mints a new epoch, which means an old
// (epoch, counter) pair can never be re-issued with a different meaning; callers must compare the pair,
// not the number.
export const WORKTREE_RUNTIME_EPOCH = randomUUID()
