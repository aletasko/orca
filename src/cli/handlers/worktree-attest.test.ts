import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from '../runtime-client'
import { attestWorktreeInstanceViaClient } from './worktree-attest'

const OK_REPLY = {
  status: 'ok',
  authoritative: true,
  instanceId: 'inst-1',
  executionHostId: 'local',
  path: '/w/one',
  dev: '64768',
  ino: '1234',
  runtimeEpoch: 'epoch-a',
  generation: 3
}

function clientReturning(result: unknown) {
  const calls: { method: string; params: unknown }[] = []
  return {
    calls,
    client: {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only `.result`.
        return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } } as never
      }
    }
  }
}

describe('attestWorktreeInstanceViaClient', () => {
  it('passes a well-formed ok reply for the requested instance', async () => {
    const { client, calls } = clientReturning(OK_REPLY)
    await expect(attestWorktreeInstanceViaClient(client, 'inst-1')).resolves.toEqual(OK_REPLY)
    expect(calls).toEqual([{ method: 'worktree.attestInstance', params: { instanceId: 'inst-1' } }])
  })

  it('is not authoritative against a host that lacks the method', async () => {
    const client = {
      call: async () => {
        throw new RuntimeClientError('method_not_found', 'Unknown method: worktree.attestInstance')
      }
    }
    await expect(attestWorktreeInstanceViaClient(client, 'inst-1')).resolves.toEqual({
      status: 'unsupported',
      authoritative: false,
      reason: 'host_lacks_method'
    })
  })

  it('does not turn other transport failures into a verdict', async () => {
    const client = {
      call: async () => {
        throw new RuntimeClientError('runtime_unavailable', 'down')
      }
    }
    await expect(attestWorktreeInstanceViaClient(client, 'inst-1')).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
  })

  it.each([
    ['an ok reply missing authoritative', { ...OK_REPLY, authoritative: undefined }],
    ['authoritative:false on ok', { ...OK_REPLY, authoritative: false }],
    ['a reply for another instance', { ...OK_REPLY, instanceId: 'inst-2' }],
    ['numeric inode that lost precision', { ...OK_REPLY, ino: 1234 }],
    ['an old host listing-shaped reply', { worktrees: [], totalCount: 0, truncated: false }],
    ['null', null]
  ])('downgrades %s', async (_name, reply) => {
    const { client } = clientReturning(reply)
    await expect(attestWorktreeInstanceViaClient(client, 'inst-1')).resolves.toMatchObject({
      status: 'unsupported',
      authoritative: false
    })
  })

  it('keeps a host refusal non-authoritative even if the host claims otherwise', async () => {
    const { client } = clientReturning({ status: 'remote', authoritative: true })
    await expect(attestWorktreeInstanceViaClient(client, 'inst-1')).resolves.toEqual({
      status: 'remote',
      authoritative: false
    })
  })
})
