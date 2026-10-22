import { defineMethod } from '../core'
import { resolveWorktreeCatalogSnapshot } from '../worktree-catalog-snapshot'
import { supportsWorktreeVisibilitySourceDefaults } from '../worktree-visibility-client-capability'
import {
  projectWorktreeListRemovals,
  projectWorktreePsRemovals
} from '../worktree-removal-marker-projection'
import { snapshotPendingWorktreeRemovals } from '../../../worktree-removal-listing'
import {
  acknowledgeWorktreeWillChange,
  watchWorktreeChanges
} from '../../../worktree-change-notifier'
import type { RpcContext } from '../core'
import {
  WorktreeAckChangeParams,
  WorktreeAttestInstanceParams,
  WorktreeDetectedListParams,
  WorktreeListParams,
  WorktreePsParams,
  WorktreeWatchChangesParams
} from './worktree-schemas'

const DEFAULT_WATCH_CHANGES_TIMEOUT_MS = 20_000

// Why: only the holder of the local runtime socket token may watch or acknowledge. A paired remote or
// mobile device is a different trust level, and an acknowledgement releases Orca's wait.
function isLocalSocketCaller(context: RpcContext): boolean {
  return context.pairedDeviceId === undefined && context.clientKind !== 'mobile'
}

export const WORKTREE_CATALOG_METHODS = [
  defineMethod({
    name: 'worktree.ps',
    params: WorktreePsParams,
    handler: async (params, context) => {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      const result = projectWorktreePsRemovals(
        await context.runtime.getWorktreePs(
          params.limit,
          supportsWorktreeVisibilitySourceDefaults(
            context,
            params.supportsWorktreeVisibilitySourceDefaults
          )
        ),
        context,
        pendingAtScan
      )
      // Why: callers that never send the field get the byte-exact legacy response.
      return params.afterSnapshotId === undefined
        ? result
        : resolveWorktreeCatalogSnapshot(result, params.afterSnapshotId)
    }
  }),
  defineMethod({
    name: 'worktree.list',
    params: WorktreeListParams,
    handler: async (params, context) => {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      const result = projectWorktreeListRemovals(
        await context.runtime.listManagedWorktrees(
          params.repo,
          params.limit,
          supportsWorktreeVisibilitySourceDefaults(context),
          params.fresh === true
        ),
        context,
        pendingAtScan
      )
      // Why: an old host strips `fresh` via zod and returns without this field, so a
      // caller demanding a fresh read fails closed instead of trusting a cached list.
      return params.fresh === true ? { ...result, freshCacheBypass: true } : result
    }
  }),
  defineMethod({
    name: 'worktree.attestInstance',
    params: WorktreeAttestInstanceParams,
    // Why no projection or cache: the answer is a security input for a caller that does not trust
    // the listing. See `attestWorktreeInstance` for the refusals.
    handler: async (params, { runtime }) => runtime.attestWorktreeInstance(params.instanceId)
  }),
  defineMethod({
    name: 'worktree.watchChanges',
    params: WorktreeWatchChangesParams,
    // Why a long-poll and not a stream: the local Unix socket is one-shot request/response and only
    // long-polls get the abort signal and keepalive (see `classifyRuntimeLongPoll`). The reply carries
    // the events after `afterSeq`; the caller polls again with `lastSeq`. While it polls, and for a
    // grace period after, Orca waits for its `worktree.ackChange` before moving or removing a root.
    handler: async (params, context) => {
      if (!isLocalSocketCaller(context)) {
        return { status: 'refused', reason: 'local_token_required' }
      }
      return watchWorktreeChanges({
        subscriberId: params.subscriberId,
        afterSeq: params.afterSeq,
        epoch: params.epoch,
        timeoutMs: params.timeoutMs ?? DEFAULT_WATCH_CHANGES_TIMEOUT_MS,
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'worktree.ackChange',
    params: WorktreeAckChangeParams,
    // Why the count and nothing else: an unknown subscriber and an already-settled seq both answer 0.
    handler: async (params, context) =>
      isLocalSocketCaller(context)
        ? { status: 'ok', acked: acknowledgeWorktreeWillChange(params.subscriberId, params.seqs) }
        : { status: 'refused', reason: 'local_token_required' }
  }),
  defineMethod({
    name: 'worktree.listRetiredNames',
    params: WorktreeDetectedListParams,
    handler: async (params, { runtime }) => runtime.listRetiredWorktreeNames(params.repo)
  }),
  defineMethod({
    name: 'worktree.detectedList',
    params: WorktreeDetectedListParams,
    handler: async (params, context) => {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      return projectWorktreeListRemovals(
        await context.runtime.listDetectedManagedWorktrees(
          params.repo,
          undefined,
          supportsWorktreeVisibilitySourceDefaults(context)
        ),
        context,
        pendingAtScan
      )
    }
  })
]
