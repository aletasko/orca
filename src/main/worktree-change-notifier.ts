import type {
  WorktreeChangeEvent,
  WorktreeChangeOp,
  WorktreeWatchChangesResult
} from '../shared/worktree/change-notification'
import { WORKTREE_RUNTIME_EPOCH } from './worktree-runtime-epoch'

// Pre-change notification for callers that pin a worktree root (the agent broker) and must drop the
// pin BEFORE Orca moves or removes it. Orca publishes `will-change`, waits a bounded time for every
// current subscriber to acknowledge, then proceeds; it publishes `changed` afterwards.
//
// Why Orca is never blocked by a subscriber: the wait has a hard deadline and a missing ack only
// records a timeout. That is the deny-safe choice for Orca, not for the broker: the broker keeps its
// own checks (re-attestation of `(runtimeEpoch, generation)`, `(dev, ino, birthtimeNs)` and the held
// root fd at every start), so a root that moved without a clean revoke is still refused there. Making
// Orca wait indefinitely would let a stuck or hostile subscriber freeze every delete and rename.

export const DEFAULT_WORKTREE_CHANGE_ACK_TIMEOUT_MS = 3000
export const MAX_WORKTREE_CHANGE_ACK_TIMEOUT_MS = 30_000
// Why longer than a subscriber's poll gap: between two polls it is processing events and must still
// count as a recipient, or the next mutation would skip the wait it is entitled to.
export const DEFAULT_WORKTREE_CHANGE_SUBSCRIBER_GRACE_MS = 10_000
export const DEFAULT_WORKTREE_CHANGE_MAX_SUBSCRIBERS = 8
const EVENT_LOG_CAPACITY = 256
const TIMEOUT_RECORD_CAPACITY = 50

export type WorktreeChangeNotifierConfig = {
  /** Upper bound of the wait per mutation. 0 disables the wait (events are still published). */
  ackTimeoutMs: number
  subscriberGraceMs: number
  maxSubscribers: number
}

/**
 * `ORCA_WORKTREE_CHANGE_ACK_TIMEOUT_MS` clamped into [0, {@link MAX_WORKTREE_CHANGE_ACK_TIMEOUT_MS}];
 * unset, blank or unparseable yields the default. `env` is injectable for tests.
 */
export function resolveWorktreeChangeAckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_WORKTREE_CHANGE_ACK_TIMEOUT_MS?.trim()
  if (!raw) {
    return DEFAULT_WORKTREE_CHANGE_ACK_TIMEOUT_MS
  }
  const requested = Math.floor(Number(raw))
  if (Number.isNaN(requested)) {
    console.warn(
      `[worktree-change] ORCA_WORKTREE_CHANGE_ACK_TIMEOUT_MS="${raw}" is not a number; using ${DEFAULT_WORKTREE_CHANGE_ACK_TIMEOUT_MS}ms`
    )
    return DEFAULT_WORKTREE_CHANGE_ACK_TIMEOUT_MS
  }
  return Math.min(Math.max(requested, 0), MAX_WORKTREE_CHANGE_ACK_TIMEOUT_MS)
}

function defaultConfig(): WorktreeChangeNotifierConfig {
  return {
    ackTimeoutMs: resolveWorktreeChangeAckTimeoutMs(),
    subscriberGraceMs: DEFAULT_WORKTREE_CHANGE_SUBSCRIBER_GRACE_MS,
    maxSubscribers: DEFAULT_WORKTREE_CHANGE_MAX_SUBSCRIBERS
  }
}

let config = defaultConfig()

export function configureWorktreeChangeNotifier(
  patch: Partial<WorktreeChangeNotifierConfig>
): void {
  config = { ...config, ...patch }
}

type Subscriber = { lastSeenAt: number; parkedPolls: number }
type PendingWait = {
  // seq -> subscribers that have not acknowledged it yet.
  waiting: Map<number, Set<string>>
  finish: (timedOut: boolean) => void
}

export type WorktreeWillChangeAnnouncement = {
  /** Seq of each published `will-change`, in the order of the targets. */
  seqs: readonly number[]
  /** Resolves once every recipient acknowledged, or the deadline passed. Never rejects. */
  settled: Promise<{ timedOut: boolean }>
  /** Meaningful once `settled` resolved. */
  readonly timedOut: boolean
}

export type WorktreeChangeAckTimeoutRecord = {
  seq: number
  instanceId: string | null
  path: string
  op: WorktreeChangeOp
  // Why a count, not ids: a subscriber id is also its acknowledgement key and must not leak.
  missingSubscribers: number
  at: number
}

let nextSeq = 0
let droppedThroughSeq = 0
let eventLog: WorktreeChangeEvent[] = []
const subscribers = new Map<string, Subscriber>()
const pendingBySeq = new Map<number, PendingWait>()
const wakeups = new Set<() => void>()
let ackTimeoutTotal = 0
let ackTimeoutRecent: WorktreeChangeAckTimeoutRecord[] = []

function publish(event: Omit<WorktreeChangeEvent, 'seq'>): WorktreeChangeEvent {
  const published: WorktreeChangeEvent = { ...event, seq: ++nextSeq }
  eventLog.push(published)
  while (eventLog.length > EVENT_LOG_CAPACITY) {
    droppedThroughSeq = eventLog.shift()!.seq
  }
  for (const wake of wakeups) {
    wake()
  }
  return published
}

function pruneSubscribers(now: number): void {
  for (const [id, subscriber] of subscribers) {
    if (subscriber.parkedPolls === 0 && now - subscriber.lastSeenAt > config.subscriberGraceMs) {
      subscribers.delete(id)
    }
  }
}

/**
 * Publish `will-change` for each target and start the bounded acknowledgement wait. Call
 * synchronously, before the first await and before the filesystem change. Returns null when there is
 * nothing to announce (no target).
 */
export function announceWorktreeWillChange(
  targets: readonly (string | null)[],
  path: string,
  op: WorktreeChangeOp
): WorktreeWillChangeAnnouncement | null {
  if (targets.length === 0) {
    return null
  }
  const now = Date.now()
  pruneSubscribers(now)
  // Why the recipient set is fixed here: a subscriber that appears later has no pin from before this
  // mutation to drop, and one that vanishes is covered by the deadline.
  const recipients = [...subscribers.keys()]
  const events = targets.map((instanceId) =>
    publish({ event: 'will-change', instanceId, path, op })
  )
  const seqs = events.map((event) => event.seq)
  let timedOut = false
  const announcement: WorktreeWillChangeAnnouncement = {
    seqs,
    settled: Promise.resolve({ timedOut: false }),
    get timedOut() {
      return timedOut
    }
  }
  if (recipients.length === 0 || config.ackTimeoutMs <= 0) {
    return announcement
  }
  announcement.settled = new Promise((resolve) => {
    const waiting = new Map<number, Set<string>>(seqs.map((seq) => [seq, new Set(recipients)]))
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const pending: PendingWait = {
      waiting,
      finish: (didTimeOut) => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        if (didTimeOut) {
          timedOut = true
          for (const [index, event] of events.entries()) {
            const missing = waiting.get(seqs[index]!)?.size ?? 0
            if (missing > 0) {
              recordAckTimeout(event, missing)
            }
          }
        }
        for (const seq of seqs) {
          pendingBySeq.delete(seq)
        }
        resolve({ timedOut: didTimeOut })
      }
    }
    for (const seq of seqs) {
      pendingBySeq.set(seq, pending)
    }
    timer = setTimeout(() => pending.finish(true), config.ackTimeoutMs)
    // Why unref: a pending wait must never keep the process alive.
    timer.unref?.()
  })
  return announcement
}

function recordAckTimeout(event: WorktreeChangeEvent, missingSubscribers: number): void {
  ackTimeoutTotal += 1
  ackTimeoutRecent.push({
    seq: event.seq,
    instanceId: event.instanceId,
    path: event.path,
    op: event.op,
    missingSubscribers,
    at: Date.now()
  })
  if (ackTimeoutRecent.length > TIMEOUT_RECORD_CAPACITY) {
    ackTimeoutRecent = ackTimeoutRecent.slice(-TIMEOUT_RECORD_CAPACITY)
  }
  console.warn(
    `[worktree-change] ${event.op} of ${event.path} proceeded without ${missingSubscribers} acknowledgement(s) after ${config.ackTimeoutMs}ms (seq ${event.seq})`
  )
}

/** Publish `changed` for a finished (or failed) mutation. Fire and forget; nobody is waited for. */
export function announceWorktreeChanged(
  targets: readonly (string | null)[],
  path: string,
  op: WorktreeChangeOp,
  willChange: WorktreeWillChangeAnnouncement | null
): void {
  for (const [index, instanceId] of targets.entries()) {
    const willChangeSeq = willChange?.seqs[index]
    publish({
      event: 'changed',
      instanceId,
      path,
      op,
      ...(willChangeSeq === undefined ? {} : { willChangeSeq }),
      ...(willChange?.timedOut ? { ackTimedOut: true as const } : {})
    })
  }
}

/** Acknowledge `will-change` seqs for a subscriber. Returns how many outstanding waits it released. */
export function acknowledgeWorktreeWillChange(
  subscriberId: string,
  seqs: readonly number[]
): number {
  const subscriber = subscribers.get(subscriberId)
  if (!subscriber) {
    // Why the same answer as "nothing outstanding": the reply must not tell a prober which ids exist.
    return 0
  }
  subscriber.lastSeenAt = Date.now()
  let acked = 0
  for (const seq of seqs) {
    const pending = pendingBySeq.get(seq)
    const waitingFor = pending?.waiting.get(seq)
    if (!pending || !waitingFor?.delete(subscriberId)) {
      continue
    }
    acked += 1
    if ([...pending.waiting.values()].every((set) => set.size === 0)) {
      pending.finish(false)
    }
  }
  return acked
}

export type WatchWorktreeChangesInput = {
  subscriberId: string
  afterSeq?: number
  epoch?: string
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Long-poll: events newer than `afterSeq`, or an empty batch once `timeoutMs` passed. The first call
 * of a subscriber (no `afterSeq`) starts from "now". Registers the caller as a recipient of
 * `will-change` waits while it polls and for the grace period after.
 */
export async function watchWorktreeChanges(
  input: WatchWorktreeChangesInput
): Promise<WorktreeWatchChangesResult> {
  let subscriber = subscribers.get(input.subscriberId)
  if (!subscriber) {
    pruneSubscribers(Date.now())
    if (subscribers.size >= config.maxSubscribers) {
      return { status: 'refused', reason: 'subscriber_limit' }
    }
    subscriber = { lastSeenAt: Date.now(), parkedPolls: 0 }
    subscribers.set(input.subscriberId, subscriber)
  }
  subscriber.parkedPolls += 1
  try {
    // Why fixed once: a first poll starts from "now", and "now" must not move while it is parked.
    const cursor = input.afterSeq ?? nextSeq
    const deadline = Date.now() + input.timeoutMs
    for (;;) {
      const batch = collect(cursor, input.epoch)
      const remaining = deadline - Date.now()
      if (batch.events.length > 0 || batch.gap || remaining <= 0 || input.signal?.aborted) {
        return { status: 'ok', ...batch }
      }
      await park(remaining, input.signal)
    }
  } finally {
    subscriber.parkedPolls -= 1
    subscriber.lastSeenAt = Date.now()
  }
}

function collect(
  cursor: number,
  epoch: string | undefined
): Omit<Extract<WorktreeWatchChangesResult, { status: 'ok' }>, 'status'> {
  // Why a cursor from the future also counts as void: it can only come from another epoch or a forgery.
  const voidCursor = (epoch !== undefined && epoch !== WORKTREE_RUNTIME_EPOCH) || cursor > nextSeq
  const gap = voidCursor || cursor < droppedThroughSeq
  const from = voidCursor ? 0 : cursor
  return {
    epoch: WORKTREE_RUNTIME_EPOCH,
    events: eventLog.filter((event) => event.seq > from),
    // The log tail is always the latest event, so this is also the right cursor for an empty batch.
    lastSeq: nextSeq,
    gap
  }
}

function park(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      wakeups.delete(wake)
      signal?.removeEventListener('abort', wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    timer.unref?.()
    wakeups.add(wake)
    signal?.addEventListener('abort', wake, { once: true })
  })
}

export function getWorktreeChangeAckTimeouts(): {
  total: number
  recent: readonly WorktreeChangeAckTimeoutRecord[]
} {
  return { total: ackTimeoutTotal, recent: ackTimeoutRecent }
}

export function resetWorktreeChangeNotifierForTests(): void {
  for (const pending of new Set(pendingBySeq.values())) {
    pending.finish(false)
  }
  pendingBySeq.clear()
  subscribers.clear()
  wakeups.clear()
  eventLog = []
  nextSeq = 0
  droppedThroughSeq = 0
  ackTimeoutTotal = 0
  ackTimeoutRecent = []
  config = defaultConfig()
}
