import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn(), enter: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified,
  sendRuntimePtyEnterVerified: io.enter
}))
import {
  sendNativeChatMessage,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-runtime-send'
import { buildNativeChatPasteBytes } from './native-chat-send'
beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.verified.mockReset().mockResolvedValue(true)
  io.enter.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})
it('observes a refused write, skips Enter, and releases the queue for the next user action', async () => {
  const rejected = vi.fn()
  io.verified.mockResolvedValueOnce(false)
  sendNativeChatMessage(null, 'pane', 'refused', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('refused')
  ])
  sendNativeChatMessage(null, 'pane', 'next', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('refused'),
    buildNativeChatPasteBytes('next')
  ])
  expect(io.enter).toHaveBeenCalledOnce()
})
it('reports a lost acknowledgment once as unconfirmed, never as rejection, and still submits', async () => {
  const rejected = vi.fn()
  const unconfirmed = vi.fn()
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  io.enter.mockRejectedValueOnce(new Error('lost acknowledgment'))
  sendNativeChatMessage(null, 'pane', 'uncertain', {
    onWriteRejected: rejected,
    onWriteUnconfirmed: unconfirmed
  })
  await vi.advanceTimersByTimeAsync(120000)
  expect(rejected).not.toHaveBeenCalled()
  expect(unconfirmed).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('uncertain')
  ])
  expect(io.enter).toHaveBeenCalledOnce()
})
it('serializes rapid sends through their acknowledged Enter and preserves the paste delay', async () => {
  const rejected = vi.fn()
  sendNativeChatMessage(null, 'pane', 'one', { onWriteRejected: rejected })
  sendNativeChatMessage(null, 'pane', 'two', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(499)
  expect(io.verified).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(501)
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('one'),
    buildNativeChatPasteBytes('two')
  ])
  expect(io.enter).toHaveBeenCalledTimes(2)
})

it('reports a refused Enter so chat does not silently claim delivery', async () => {
  const rejected = vi.fn()
  io.enter.mockResolvedValueOnce(false)
  sendNativeChatMessage(null, 'pane', 'needs submit', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(io.enter).toHaveBeenCalledOnce()
})
