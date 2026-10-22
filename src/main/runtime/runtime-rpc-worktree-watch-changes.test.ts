import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  announceWorktreeChanged,
  announceWorktreeWillChange,
  configureWorktreeChangeNotifier,
  resetWorktreeChangeNotifierForTests
} from '../worktree-change-notifier'
import { WORKTREE_CATALOG_METHODS } from './rpc/methods/worktree-catalog-methods'

const SUBSCRIBER = 'rpc-subscriber-0123456789'

describe('worktree.watchChanges / worktree.ackChange over the authenticated runtime socket', () => {
  let server: OrcaRuntimeRpcServer
  let endpoint: string
  let authToken: string

  beforeEach(async () => {
    resetWorktreeChangeNotifierForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureWorktreeChangeNotifier({ ackTimeoutMs: 10_000 })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    server = new OrcaRuntimeRpcServer({ runtime: new OrcaRuntimeService(), userDataPath })
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)!
    endpoint = metadata.transports[0]!.endpoint
    if (!metadata.authToken) {
      throw new Error('runtime metadata has no auth token')
    }
    authToken = metadata.authToken
  })
  afterEach(async () => {
    await server.stop()
    resetWorktreeChangeNotifierForTests()
    vi.restoreAllMocks()
  })

  const watch = (params: Record<string, unknown>, token: string | null = authToken) =>
    sendRequest(endpoint, {
      id: 'req_watch',
      method: 'worktree.watchChanges',
      ...(token === null ? {} : { authToken: token }),
      params
    })
  const ack = (params: Record<string, unknown>, token: string | null = authToken) =>
    sendRequest(endpoint, {
      id: 'req_ack',
      method: 'worktree.ackChange',
      ...(token === null ? {} : { authToken: token }),
      params
    })

  it('is a keepalive-backed long poll (abort signal and keepalive wired)', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'r',
        authToken: 't',
        method: 'worktree.watchChanges',
        params: {}
      })
    ).toBe('wait')
    expect(
      classifyRuntimeLongPoll({ id: 'r', authToken: 't', method: 'worktree.ackChange', params: {} })
    ).toBeNull()
  })

  it.each([
    ['missing token', null, 'Missing auth token'],
    ['wrong token', 'not-the-runtime-token', 'Invalid auth token']
  ])('refuses an unauthenticated subscriber (%s)', async (_name, token, message) => {
    const reply = await watch({ subscriberId: SUBSCRIBER, timeoutMs: 0 }, token)
    expect(reply).toMatchObject({ ok: false, error: { code: 'unauthorized', message } })
    expect(await ack({ subscriberId: SUBSCRIBER, seqs: [1] }, token)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })

    // The refused caller never became a recipient: a mutation does not wait for it.
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    const started = Date.now()
    await announcement.settled
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('rejects a guessable (short) subscriber id and an empty ack list', async () => {
    expect(await watch({ subscriberId: 'short' })).toMatchObject({ ok: false })
    expect(await ack({ subscriberId: SUBSCRIBER, seqs: [] })).toMatchObject({ ok: false })
  })

  it('an authenticated subscriber receives will-change and its ack releases Orca early', async () => {
    const first = await watch({ subscriberId: SUBSCRIBER, timeoutMs: 0 })
    expect(first).toMatchObject({ ok: true, result: { status: 'ok', events: [], gap: false } })
    const { epoch, lastSeq } = (first as { result: { epoch: string; lastSeq: number } }).result

    const parked = watch({ subscriberId: SUBSCRIBER, afterSeq: lastSeq, epoch, timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const announcement = announceWorktreeWillChange(['inst-rpc'], '/wt', 'remove')!
    const reply = (await parked) as {
      result: { events: { event: string; instanceId: string; seq: number }[] }
    }
    expect(reply.result.events).toEqual([
      {
        event: 'will-change',
        instanceId: 'inst-rpc',
        path: '/wt',
        op: 'remove',
        seq: announcement.seqs[0]
      }
    ])

    let released = false
    void announcement.settled.then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(released).toBe(false)
    const started = Date.now()
    expect(
      await ack({ subscriberId: SUBSCRIBER, seqs: announcement.seqs as number[] })
    ).toMatchObject({
      ok: true,
      result: { status: 'ok', acked: 1 }
    })
    await announcement.settled
    expect(Date.now() - started).toBeLessThan(2000)
    expect(announcement.timedOut).toBe(false)

    announceWorktreeChanged(['inst-rpc'], '/wt', 'remove', announcement)
    const changed = (await watch({
      subscriberId: SUBSCRIBER,
      afterSeq: announcement.seqs[0],
      epoch,
      timeoutMs: 2000
    })) as { result: { events: { event: string; willChangeSeq: number }[] } }
    expect(changed.result.events).toMatchObject([
      { event: 'changed', willChangeSeq: announcement.seqs[0] }
    ])
  })

  it('an acknowledgement from a token holder that does not know the subscriber id releases nothing', async () => {
    await watch({ subscriberId: SUBSCRIBER, timeoutMs: 0 })
    const announcement = announceWorktreeWillChange(['inst-1'], '/wt', 'move')!
    expect(
      await ack({
        subscriberId: 'a-different-subscriber-0123',
        seqs: announcement.seqs as number[]
      })
    ).toMatchObject({ ok: true, result: { status: 'ok', acked: 0 } })
    let released = false
    void announcement.settled.then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(released).toBe(false)
  })
})

describe('worktree.watchChanges handler guards', () => {
  const methods = WORKTREE_CATALOG_METHODS as readonly {
    name: string
    handler: (params: never, context: never) => unknown
  }[]
  const handlerOf = (name: string) => methods.find((method) => method.name === name)!.handler

  it.each([
    ['a paired device', { pairedDeviceId: 'device-1' }],
    ['a mobile client', { clientKind: 'mobile' }]
  ])('refuses %s even with a valid request', async (_name, context) => {
    resetWorktreeChangeNotifierForTests()
    await expect(
      handlerOf('worktree.watchChanges')(
        { subscriberId: SUBSCRIBER, timeoutMs: 0 } as never,
        context as never
      )
    ).resolves.toEqual({ status: 'refused', reason: 'local_token_required' })
    await expect(
      handlerOf('worktree.ackChange')(
        { subscriberId: SUBSCRIBER, seqs: [1] } as never,
        context as never
      )
    ).resolves.toEqual({ status: 'refused', reason: 'local_token_required' })
  })
})
