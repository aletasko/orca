// Wire shapes of `worktree.watchChanges` / `worktree.ackChange`: a pre-change notification for a
// caller (the agent broker) that holds a pinned root and must drop it BEFORE Orca moves or removes it.

export type WorktreeChangeOp = 'move' | 'remove'

export type WorktreeChangeEvent = {
  event: 'will-change' | 'changed'
  /**
   * The instance whose root changes. `null` = Orca could not tie the path to an instance (resolver
   * missing or failing, or a git-layer path with no metadata row): the subscriber must treat every
   * instance as affected. One mutation that touches N instances emits N events.
   */
  instanceId: string | null
  /** Root path as Orca knew it when the mutation began (the OLD path for a move). */
  path: string
  op: WorktreeChangeOp
  /** Monotonic within one `epoch`; never reused. */
  seq: number
  /** `changed` only: the `seq` of the matching `will-change`. */
  willChangeSeq?: number
  /**
   * `changed` only, present and true when Orca stopped waiting for acknowledgements and proceeded.
   * The subscriber was too late for a clean revoke: it must still revoke, then re-attest.
   */
  ackTimedOut?: true
}

export type WorktreeWatchChangesResult =
  | {
      status: 'ok'
      /** Process lifetime of the counters; a different epoch than the last poll means every cursor is void. */
      epoch: string
      events: WorktreeChangeEvent[]
      /** Pass back as `afterSeq`; equals the highest seq in `events`, or the current seq if empty. */
      lastSeq: number
      /** True when events between `afterSeq` and the first returned one were lost: revoke everything. */
      gap: boolean
    }
  | { status: 'refused'; reason: 'local_token_required' | 'subscriber_limit' }

export type WorktreeAckChangeResult =
  | { status: 'ok'; acked: number }
  | { status: 'refused'; reason: 'local_token_required' }
