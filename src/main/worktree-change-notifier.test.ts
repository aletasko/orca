import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORKTREE_CHANGE_ACK_TIMEOUT_MS,
  MAX_WORKTREE_CHANGE_ACK_TIMEOUT_MS,
  acknowledgeWorktreeWillChange,
  announceWorktreeChanged,
  announceWorktreeWillChange,
  configureWorktreeChangeNotifier,
  getWorktreeChangeAckTimeouts,
  resetWorktreeChangeNotifierForTests,
  resolveWorktreeChangeAckTimeoutMs,
  watchWorktreeChanges
} from './worktree-change-notifier'
import { WORKTREE_RUNTIME_EPOCH } from './worktree-runtime-epoch'

const SUB_A = 'subscriber-a-0123456789'
const SUB_B = 'subscriber-b-0123456789'

async function register(subscriberId: string): Promise<number> {
  const first = await watchWorktreeChanges({ subscriberId, timeoutMs: 0 })
  if (first.status !== 'ok') {
    throw new Error(`register refused: ${first.reason}`)
  }
  return first.lastSeq
}

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const started = Date.now()
  await run()
  return Date.now() - started
}

describe('worktree change notifier', () => {
  beforeEach(() => {
    resetWorktreeChangeNotifierForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    resetWorktreeChangeNotifierForTests()
    vi.restoreAllMocks()
  })

  it('does not wait when nobody subscribes, but still logs the event', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 5000 })
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')
    expect(await elapsed(() => announcement!.settled)).toBeLessThan(500)
    expect(announcement!.timedOut).toBe(false)

    const poll = await watchWorktreeChanges({ subscriberId: SUB_A, afterSeq: 0, timeoutMs: 0 })
    expect(poll).toMatchObject({
      status: 'ok',
      gap: false,
      events: [{ event: 'will-change', instanceId: 'inst-1', path: '/wt', op: 'move', seq: 1 }]
    })
  })

  it('announces nothing for an empty target list', () => {
    expect(announceWorktreeWillChange([], '/wt', 'remove')).toBeNull()
  })

  it('a first poll starts from now and a parked poll wakes on the next event', async () => {
    announceWorktreeWillChange(['old'], '/before', 'remove')
    const parked = watchWorktreeChanges({ subscriberId: SUB_A, timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    announceWorktreeWillChange(['inst-1'], '/wt', 'remove')
    const result = await parked
    expect(result).toMatchObject({ status: 'ok', gap: false, lastSeq: 2 })
    // Why: the event that predates the subscriber is not delivered.
    expect(result.status === 'ok' && result.events.map((event) => event.instanceId)).toEqual([
      'inst-1'
    ])
  })

  it('an empty poll returns after its timeout with the current cursor', async () => {
    const started = Date.now()
    const result = await watchWorktreeChanges({ subscriberId: SUB_A, timeoutMs: 80 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    expect(result).toMatchObject({ status: 'ok', events: [], lastSeq: 0, gap: false })
    expect(result.status === 'ok' && result.epoch).toBe(WORKTREE_RUNTIME_EPOCH)
  })

  it('a parked poll returns at once when its signal aborts', async () => {
    const controller = new AbortController()
    const parked = watchWorktreeChanges({
      subscriberId: SUB_A,
      timeoutMs: 30_000,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 20)
    expect(await elapsed(() => parked)).toBeLessThan(2000)
  })

  it('an acknowledgement releases the wait early', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 10_000 })
    await register(SUB_A)
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    setTimeout(() => {
      expect(acknowledgeWorktreeWillChange(SUB_A, announcement.seqs)).toBe(1)
    }, 30)
    const waited = await elapsed(() => announcement.settled)
    expect(waited).toBeLessThan(2000)
    expect(announcement.timedOut).toBe(false)
    expect(getWorktreeChangeAckTimeouts().total).toBe(0)
  })

  it('waits for every current subscriber, not just the first', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 10_000 })
    await register(SUB_A)
    await register(SUB_B)
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    let released = false
    void announcement.settled.then(() => {
      released = true
    })
    acknowledgeWorktreeWillChange(SUB_A, announcement.seqs)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(released).toBe(false)
    acknowledgeWorktreeWillChange(SUB_B, announcement.seqs)
    await announcement.settled
    expect(released).toBe(true)
  })

  it('one mutation touching two instances needs both acknowledged', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 10_000 })
    await register(SUB_A)
    const announcement = announceWorktreeWillChange(['inst-1', 'inst-2'], '/dir', 'remove')!
    expect(announcement.seqs).toHaveLength(2)
    let released = false
    void announcement.settled.then(() => {
      released = true
    })
    acknowledgeWorktreeWillChange(SUB_A, [announcement.seqs[0]!])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(released).toBe(false)
    acknowledgeWorktreeWillChange(SUB_A, [announcement.seqs[1]!])
    await announcement.settled
    expect(released).toBe(true)
  })

  it('without an acknowledgement the wait is bounded, proceeds, and is recorded', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 150 })
    await register(SUB_A)
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'remove')!
    const waited = await elapsed(() => announcement.settled)
    expect(waited).toBeGreaterThanOrEqual(130)
    expect(waited).toBeLessThan(1500)
    expect(announcement.timedOut).toBe(true)
    const recorded = getWorktreeChangeAckTimeouts()
    expect(recorded.total).toBe(1)
    expect(recorded.recent[0]).toMatchObject({
      instanceId: 'inst-1',
      path: '/wt',
      op: 'remove',
      missingSubscribers: 1
    })
    // The subscriber id is its acknowledgement key and must not leak into the record.
    expect(JSON.stringify(recorded)).not.toContain(SUB_A)

    announceWorktreeChanged(['inst-1'], '/wt', 'remove', announcement)
    const poll = await watchWorktreeChanges({ subscriberId: SUB_A, afterSeq: 1, timeoutMs: 0 })
    expect(poll.status === 'ok' && poll.events).toEqual([
      {
        event: 'changed',
        instanceId: 'inst-1',
        path: '/wt',
        op: 'remove',
        seq: 2,
        willChangeSeq: 1,
        ackTimedOut: true
      }
    ])
  })

  it('a zero timeout publishes without waiting', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 0 })
    await register(SUB_A)
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    expect(await elapsed(() => announcement.settled)).toBeLessThan(500)
    expect(announcement.timedOut).toBe(false)
  })

  it('a subscriber that stopped polling past the grace period is no longer waited for', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 10_000, subscriberGraceMs: 30 })
    await register(SUB_A)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    expect(await elapsed(() => announcement.settled)).toBeLessThan(500)
  })

  it('an unknown subscriber or a settled seq acknowledges nothing and reveals nothing', async () => {
    configureWorktreeChangeNotifier({ ackTimeoutMs: 10_000 })
    await register(SUB_A)
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    expect(acknowledgeWorktreeWillChange('someone-else-0123456789', announcement.seqs)).toBe(0)
    expect(acknowledgeWorktreeWillChange(SUB_A, [999])).toBe(0)
    let released = false
    void announcement.settled.then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(released).toBe(false)
    expect(acknowledgeWorktreeWillChange(SUB_A, announcement.seqs)).toBe(1)
    // Settled now: the same ack again counts nothing.
    expect(acknowledgeWorktreeWillChange(SUB_A, announcement.seqs)).toBe(0)
  })

  it('refuses a ninth subscriber but keeps serving the existing ones', async () => {
    configureWorktreeChangeNotifier({ maxSubscribers: 2 })
    await register(SUB_A)
    await register(SUB_B)
    await expect(
      watchWorktreeChanges({ subscriberId: 'subscriber-c-0123456789', timeoutMs: 0 })
    ).resolves.toEqual({ status: 'refused', reason: 'subscriber_limit' })
    await expect(
      watchWorktreeChanges({ subscriberId: SUB_A, timeoutMs: 0 })
    ).resolves.toMatchObject({ status: 'ok' })
  })

  it('reports a gap for a cursor from another epoch, from the future, or older than the log', async () => {
    announceWorktreeWillChange(['inst-1'], '/wt', 'move')
    const otherEpoch = await watchWorktreeChanges({
      subscriberId: SUB_A,
      afterSeq: 1,
      epoch: 'a-different-epoch',
      timeoutMs: 0
    })
    expect(otherEpoch).toMatchObject({ status: 'ok', gap: true })
    const future = await watchWorktreeChanges({ subscriberId: SUB_A, afterSeq: 500, timeoutMs: 0 })
    expect(future).toMatchObject({ status: 'ok', gap: true, lastSeq: 1 })

    for (let index = 0; index < 300; index += 1) {
      announceWorktreeWillChange([`inst-${index}`], '/wt', 'move')
    }
    const stale = await watchWorktreeChanges({ subscriberId: SUB_A, afterSeq: 1, timeoutMs: 0 })
    expect(stale).toMatchObject({ status: 'ok', gap: true })
    expect(stale.status === 'ok' && stale.events.length).toBe(256)
  })

  it('an unattributed mutation is announced with a null instance id', async () => {
    const announcement = announceWorktreeWillChange([null], '/anywhere', 'remove')!
    const poll = await watchWorktreeChanges({ subscriberId: SUB_A, afterSeq: 0, timeoutMs: 0 })
    expect(poll.status === 'ok' && poll.events).toEqual([
      {
        event: 'will-change',
        instanceId: null,
        path: '/anywhere',
        op: 'remove',
        seq: announcement.seqs[0]
      }
    ])
  })

  describe('ack timeout configuration', () => {
    it('defaults to 3000 ms', () => {
      expect(DEFAULT_WORKTREE_CHANGE_ACK_TIMEOUT_MS).toBe(3000)
      expect(resolveWorktreeChangeAckTimeoutMs({})).toBe(3000)
      expect(resolveWorktreeChangeAckTimeoutMs({ ORCA_WORKTREE_CHANGE_ACK_TIMEOUT_MS: '  ' })).toBe(
        3000
      )
    })
    it('honours the environment value, clamped, and falls back on garbage', () => {
      const read = (value: string) =>
        resolveWorktreeChangeAckTimeoutMs({ ORCA_WORKTREE_CHANGE_ACK_TIMEOUT_MS: value })
      expect(read('1200')).toBe(1200)
      expect(read('0')).toBe(0)
      expect(read('-5')).toBe(0)
      expect(read('99999999')).toBe(MAX_WORKTREE_CHANGE_ACK_TIMEOUT_MS)
      expect(read('three')).toBe(3000)
    })
  })
})
