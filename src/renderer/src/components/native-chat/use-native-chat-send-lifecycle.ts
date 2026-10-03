import { useCallback, useLayoutEffect, useRef } from 'react'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatSendLifecycle = {
  cancelPendingSends: () => void
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
}

export function useNativeChatSendLifecycle(
  terminalTabId: string,
  targetPtyId: string | null,
  onPendingSendCanceled?: (pendingId: string) => void,
  preserveOnTerminalSwitch?: () => boolean
): NativeChatSendLifecycle {
  const pendingSendHandlesRef = useRef(
    new Map<
      NativeChatSendHandle,
      { cleanupTimer: ReturnType<typeof setTimeout> | null; pendingId?: string }
    >()
  )
  const cancelPendingSends = useCallback(() => {
    for (const [handle, entry] of pendingSendHandlesRef.current) {
      const { cleanupTimer, pendingId } = entry
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer)
      }
      handle.cancel()
      if (pendingId) {
        onPendingSendCanceled?.(pendingId)
      }
    }
    pendingSendHandlesRef.current.clear()
  }, [onPendingSendCanceled])
  const trackPendingSend = useCallback((handle: NativeChatSendHandle, pendingId?: string) => {
    const entry = {
      cleanupTimer: null as ReturnType<typeof setTimeout> | null,
      ...(pendingId ? { pendingId } : {})
    }
    pendingSendHandlesRef.current.set(handle, entry)
    if (handle.settled) {
      void handle.settled.then(() => {
        if (pendingSendHandlesRef.current.get(handle) === entry) {
          pendingSendHandlesRef.current.delete(handle)
        }
      })
      return
    }
    entry.cleanupTimer = setTimeout(() => {
      pendingSendHandlesRef.current.delete(handle)
    }, handle.settleAfterMs)
  }, [])

  // A view switch keeps the same PTY alive. Let its delayed Enter finish so a
  // send is not abandoned between writing the body and submitting it.
  useLayoutEffect(
    () => () => {
      if (!preserveOnTerminalSwitch?.()) {
        cancelPendingSends()
      }
    },
    [cancelPendingSends, preserveOnTerminalSwitch, targetPtyId, terminalTabId]
  )

  return { cancelPendingSends, trackPendingSend }
}
