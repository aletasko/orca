# Worktree change notifications (`worktree.watchChanges`)

A caller that pins a worktree root (the agent broker) needs a warning **before** Orca moves or
removes that root. Orca publishes `will-change`, waits a bounded time for acknowledgements, changes the
filesystem, then publishes `changed`.

## Transport

Same authenticated local runtime socket as `worktree.attestInstance` (auth token from the 0600
runtime metadata file). That socket is one-shot request/response, so the subscription is a **long-poll**,
not a stream (`classifyRuntimeLongPoll` gives it the abort signal and keepalive). Paired remote and
mobile devices are refused (`local_token_required`).

- `worktree.watchChanges {subscriberId, afterSeq?, epoch?, timeoutMs?}` -> `{status:"ok", epoch, events, lastSeq, gap}`.
  `subscriberId` is 16..128 chars, chosen by the caller, never revealed to others, and is the key of its
  acknowledgements: pick it at random. First call omits `afterSeq` (starts from now); later calls pass the
  previous `lastSeq` and `epoch`. `gap: true` means events were lost (log of 256, other epoch, forged
  cursor): revoke everything.
- `worktree.ackChange {subscriberId, seqs}` -> `{status:"ok", acked}`. `acked` is the number of waits it
  released; an unknown subscriber and a settled seq both answer 0.
- Event: `{event:"will-change"|"changed", instanceId, path, op:"move"|"remove", seq}`. `instanceId` is
  `null` when the path could not be tied to an instance (revoke everything). `changed` adds
  `willChangeSeq` and, when Orca stopped waiting, `ackTimedOut: true`.

## Orca side

1. Bump the generation and set the in-flight mark (existing; attestation refuses meanwhile).
2. Publish `will-change` (one event per affected instance) and wait until every current subscriber
   acknowledged every seq, or `ORCA_WORKTREE_CHANGE_ACK_TIMEOUT_MS` (default 3000, 0 = never wait,
   max 30000) passed. A *current* subscriber is one with a parked poll or one that polled within the
   last 10 s. No subscriber: no wait.
3. Change the filesystem.
4. `settle()`: bump again, clear in-flight, publish `changed` (also when the mutation failed).

Entry points covered (all reach one of six call sites): `moveWorktree`, `removeWorktree`,
`finishUnregisteredWorktreeRemoval`, `removeLocalWorktreePath`, `renameLocalPathSerializedByDestination`
(`fs:rename`, `files.rename`), `fs:deletePath`, `files.delete`.

## Timeout is deny-safe for Orca

Orca must never be blocked by the broker. On timeout it proceeds, logs, and records the miss
(`getWorktreeChangeAckTimeouts()`, `ackTimedOut` on `changed`). The broker is still protected: every
start re-attests (`runtimeEpoch`, `generation`), compares `(dev, ino, birthtimeNs)` and holds an
`O_PATH|O_NOFOLLOW` fd on the root, so a root moved without a clean revoke is refused there.

## Broker contract (implemented later)

Subscribe; on `will-change` revoke every binding of `instanceId` (all bindings when `null` or `gap`),
kill its workers, then `ackChange`; on `changed` re-attest before binding again. Acknowledge only after
the revoke completed.

## Not covered

Changes made outside Orca (`mv`, `rm`, `git worktree move/remove` from a shell); `git worktree prune`
(drops admin records, never a root); the legacy trash sweep; SSH/remote hosts; `fs:copy`,
`commitUpload`, creation cleanup; a rename whose destination overwrites a root. See
`bumpWorktreeGenerationBeforePathMutation` for the full list.
