import type { AgentStatusState, AgentType, AgentWorkingMode } from './agent-status-types'
import type { AgentMainAgentStatus } from './main-agent-status'
import type { BaseRefSearchResult, Repo } from './repo-types'
import type { CreateWorktreeResult, RemoveWorktreeResult } from './worktree/create-types'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from './worktree/lineage-types'
import type { RuntimeListingHostScope } from './runtime-listing-host-scope'
import type { GitWorktreeInfo, Worktree } from './worktree/types'

export type RuntimeWorktreeAgentRow = {
  paneKey: string
  parentPaneKey: string | null
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  agentType: AgentType | null
  prompt: string
  taskTitle: string | null
  displayName: string | null
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  /** The main agent's own state, verdict and clock, sent whenever the host row has one, including
   *  while subagents hold the row `working`. Optional on the wire: old hosts never send it, and a
   *  reader without it falls back to `interrupted`. */
  mainAgent?: AgentMainAgentStatus
  stateStartedAt: number
  updatedAt: number
  restoredUnconfirmed?: boolean
  /** The structured session host still runs this row's provider child, so it is fresh regardless
   *  of age. Optional on the wire: old hosts never send it. */
  structuredHostOwned?: true
}

export type RuntimeWorktreePsSummary = {
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: Worktree['hostId']
  terminalPlatform?: NodeJS.Platform
  repo: string
  path: string
  branch: string
  isArchived: boolean
  isMainWorktree: boolean
  hasHostSidebarActivity: boolean
  worktreeInstanceId?: string
  lineageWorktreeInstanceId?: string
  parentWorktreeInstanceId?: string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  displayName: string
  workspaceStatus: string
  sortOrder: number
  manualOrder?: number
  lastActivityAt?: number
  createdAt?: number
  creatorProvenance?: Worktree['creatorProvenance']
  linkedIssue: number | null
  linkedPR: { number: number; state: string } | null
  linkedLinearIssue: string | null
  linkedGitLabMR: number | null
  linkedGitLabIssue: number | null
  comment: string
  isPinned: boolean
  isActive: boolean
  unread: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  lastOutputAt: number | null
  preview: string
  status: RuntimeWorktreeStatus
  /** Optional discriminator for a working workspace; older clients fall back to ordinary working. */
  workingMode?: AgentWorkingMode
  agents: RuntimeWorktreeAgentRow[]
  /** See `Worktree.removing`; sent only to clients that advertise background removal. */
  removing?: true
  /** See `GitWorktreeInfo.removalError`. */
  removalError?: string
}

export type RuntimeGitLocalBranches = {
  current: string | null
  branches: string[]
}

export type RuntimeSpeechModelSummary = {
  id: string
  label: string
  provider: 'local' | 'openai'
  sizeBytes: number | null
  recommended: boolean
  status: 'ready' | 'not-downloaded' | 'downloading' | 'extracting' | 'error'
  progress: number | null
}

export type RuntimeSpeechSetupState = {
  enabled: boolean
  selectedModelId: string
  dictationMode: 'toggle' | 'hold'
  models: RuntimeSpeechModelSummary[]
}

export type RuntimeGitCheckoutResult = {
  ok: true
  branch: string
}

export type RuntimeWorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

export type RuntimeWorktreeRecord = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  git: GitWorktreeInfo
}

export type RuntimeWorktreeCreateResult = {
  worktree: RuntimeWorktreeRecord
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings: WorktreeLineageWarning[]
  warning?: string
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  agentTerminalHandle?: string
}

export type RuntimeWorktreeRemoveResult = RemoveWorktreeResult & {
  removed: boolean
  warning?: string
}

export type RuntimeWorktreePsResult = {
  worktrees: RuntimeWorktreePsSummary[]
  totalCount: number
  truncated: boolean
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeListingHostScope
}

export type RuntimeWorktreePsSnapshotResult = RuntimeWorktreePsResult & { snapshotId: string }

export type RuntimeWorktreePsUnchangedResult = {
  unchanged: true
  snapshotId: string
}

export type RuntimeWorktreePsConditionalResult =
  | RuntimeWorktreePsSnapshotResult
  | RuntimeWorktreePsUnchangedResult

export type RuntimeRepoList = { repos: Repo[] }

export type RuntimeRepoSearchRefs = {
  refs: string[]
  refDetails?: BaseRefSearchResult[]
  truncated: boolean
}

export type RuntimeWorktreeListResult = {
  worktrees: RuntimeWorktreeRecord[]
  totalCount: number
  truncated: boolean
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeListingHostScope
  /** Set only when the host honored a `fresh` list request by bypassing its caches. Not an `authoritative` proof. */
  freshCacheBypass?: true
}

/**
 * Host-side verdict of `worktree.attestInstance`. Only `status: 'ok'` carries `authoritative: true`;
 * every other status is a refusal. Callers must go through `interpretWorktreeInstanceAttestation`
 * so a host that lacks the method, or answers malformed, never reads as authoritative.
 */
export type RuntimeWorktreeInstanceAttestation =
  | {
      status: 'ok'
      authoritative: true
      instanceId: string
      executionHostId: string
      path: string
      /** Decimal strings: 64-bit st_dev/st_ino do not survive a JSON number. */
      dev: string
      ino: string
      /**
       * statx birth time in ns (decimal string), or null when the filesystem reports none. A deleted
       * and recreated root can reuse the same (dev, ino). The birth time is a BEST-EFFORT detector
       * of that, not a unique discriminator: the filesystem stamps it at tick granularity, so a root
       * recreated at once can keep the same value (measured on ext4: 2000/2000 inode reuse, equal
       * birth time in 1709/2000 = 85% of immediate recreations). Pin it together with dev/ino as an
       * extra check only. The pin MUST always be an O_PATH|O_NOFOLLOW fd on the root, held open from
       * pin to exec, whether or not this is null; that fd is the only real guarantee.
       */
      birthtimeNs: string | null
      /** New on every runtime process start. `generation` is only comparable under the same epoch. */
      runtimeEpoch: string
      /** Per instance; raised before any move/remove/root change done through Orca. */
      generation: number
    }
  | {
      status: 'absent' | 'ambiguous' | 'remote' | 'unsupported'
      authoritative: false
      /** Diagnostic only; never branch on it. Present only for `unsupported`. */
      reason?: string
    }
