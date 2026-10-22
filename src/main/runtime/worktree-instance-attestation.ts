import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { RuntimeWorktreeInstanceAttestation } from '../../shared/runtime-worktree-contracts'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from '../../shared/worktree/id'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { HostQualifiedWorktreeMetaStore } from '../persistence/host-qualified-worktree-meta'
import { areWorktreePathsEqual, canonicalWorktreePath } from '../git/worktree-path-comparison'

type MetaStore = Pick<
  HostQualifiedWorktreeMetaStore,
  'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost'
>

export type WorktreeMetaRow = {
  worktreeId: string
  /** Null only for a legacy row no single registered repo can own. */
  hostId: ExecutionHostId | null
  meta: WorktreeMeta
}

export type RootStat = {
  dev: bigint
  ino: bigint
  /** statx btime in ns; 0n when the filesystem does not report one. */
  birthtimeNs: bigint
  isDirectory: boolean
  isSymbolicLink: boolean
}

export type WorktreeAttestationDeps = {
  store: MetaStore & { getRepos: () => Repo[] }
  /** A fresh `git worktree list` for one local repo. Must not read any scan or resolved cache. */
  scanLocalRepo: (repo: Repo) => Promise<{ ok: boolean; worktrees: GitWorktreeInfo[] }>
  /** Throws `{ code }` like fs; resolves the final path component without following it. */
  lstatRoot: (path: string) => Promise<RootStat>
  runtimeEpoch: string
  getGeneration: (instanceId: string) => number
  /** True from a move/remove's pre-bump until it settles. */
  isMutationInFlight: (instanceId: string) => boolean
  isRemovalPending: (worktreeId: string) => boolean
  platform: NodeJS.Platform
  /** Throws for a project runtime the host cannot route (WSL distro, repair needed). */
  assertPlainLocalGit: (repo: Repo) => void
}

/** Every metadata row on every host, deduplicated by (host, locator). Read-only: mints nothing. */
export function listWorktreeMetaRows(store: WorktreeAttestationDeps['store']): WorktreeMetaRow[] {
  const repos = store.getRepos()
  const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
  for (const repo of repos) {
    hostIds.add(getRepoExecutionHostId(repo))
  }
  for (const meta of Object.values(store.getAllWorktreeMeta())) {
    if (meta.hostId) {
      hostIds.add(meta.hostId)
    }
  }
  const rows = new Map<string, WorktreeMetaRow>()
  for (const hostId of hostIds) {
    for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
      const owner = meta.hostId ?? soleRepoHost(repos, worktreeId)
      const key = `${owner ?? ''}\0${worktreeId}`
      if (!rows.has(key)) {
        rows.set(key, { worktreeId, hostId: owner, meta })
      }
    }
  }
  return [...rows.values()]
}

function soleRepoHost(repos: readonly Repo[], worktreeId: string): ExecutionHostId | null {
  const repoId = splitWorktreeId(worktreeId)?.repoId
  const owners = repos.filter((repo) => repo.id === repoId)
  return owners.length === 1 ? getRepoExecutionHostId(owners[0]) : null
}

/** True when `child` is `ancestor` itself or lies below it (POSIX and Windows syntax). */
function isPathAtOrUnder(child: string, ancestor: string): boolean {
  if (areWorktreePathsEqual(child, ancestor)) {
    return true
  }
  const canonicalAncestor = canonicalWorktreePath(ancestor)
  const prefix =
    canonicalAncestor.endsWith('/') || canonicalAncestor.endsWith('\\')
      ? canonicalAncestor
      : `${canonicalAncestor}${canonicalAncestor.includes('\\') ? '\\' : '/'}`
  return canonicalWorktreePath(child).startsWith(prefix)
}

/**
 * Instance ids (any host) whose locator path is `path` (`at`) or is `path` or lies below it
 * (`at-or-under`), for pre-mutation generation bumps.
 */
export function listInstanceIdsAtPath(
  store: WorktreeAttestationDeps['store'],
  path: string,
  scope: 'at' | 'at-or-under' = 'at'
): string[] {
  const instanceIds = new Set<string>()
  for (const row of listWorktreeMetaRows(store)) {
    const parsed = splitWorktreeId(row.worktreeId)
    if (!row.meta.instanceId || !parsed) {
      continue
    }
    const hit =
      scope === 'at'
        ? areWorktreePathsEqual(parsed.worktreePath, path)
        : isPathAtOrUnder(parsed.worktreePath, path)
    if (hit) {
      instanceIds.add(row.meta.instanceId)
    }
  }
  return [...instanceIds]
}

function refused(
  status: 'absent' | 'ambiguous' | 'remote' | 'unsupported',
  reason: string
): RuntimeWorktreeInstanceAttestation {
  // Why no reason for absent/ambiguous/remote: it would tell a token holder "no such id" apart from
  // "exists but unusable" (removal pending, repo gone, legacy row) beyond what the status already says.
  // `unsupported` keeps its reason: it is the actionable one (symlink root, mutation in flight, ...).
  return status === 'unsupported'
    ? { status, authoritative: false, reason }
    : { status, authoritative: false }
}

/**
 * Authoritative answer to "where is this worktree instance right now, and which directory is it?".
 * Reads the metadata store, a fresh Git scan, and a fresh `lstat` of the root; never a cache. Every
 * doubt is a refusal, so a caller that only trusts `status: 'ok'` fails closed.
 */
export async function attestWorktreeInstance(
  instanceId: string,
  deps: WorktreeAttestationDeps
): Promise<RuntimeWorktreeInstanceAttestation> {
  // Why refuse while a mutation is in flight: its pre-bump already happened, so the generation read
  // below would look current while the root is being moved or deleted. Only the settle clears it.
  if (deps.isMutationInFlight(instanceId)) {
    return refused('unsupported', 'mutation_in_flight')
  }
  // Why read first and compare after: a move/remove through Orca bumps before it touches the disk,
  // so an unchanged value brackets a window in which no such mutation began.
  const generation = deps.getGeneration(instanceId)
  const verdict = await attestOnce(instanceId, generation, deps)
  if (verdict.status === 'ok') {
    if (deps.isMutationInFlight(instanceId)) {
      return refused('unsupported', 'mutation_in_flight')
    }
    if (deps.getGeneration(instanceId) !== generation) {
      return refused('unsupported', 'changed_during_attestation')
    }
  }
  return verdict
}

async function attestOnce(
  instanceId: string,
  generation: number,
  deps: WorktreeAttestationDeps
): Promise<RuntimeWorktreeInstanceAttestation> {
  const matches = listWorktreeMetaRows(deps.store).filter(
    (row) => row.meta.instanceId === instanceId
  )
  if (matches.length === 0) {
    return refused('absent', 'unknown_instance')
  }
  if (matches.length > 1) {
    return refused('ambiguous', 'duplicate_instance_id')
  }
  const [{ worktreeId, hostId }] = matches
  if (hostId === null) {
    return refused('ambiguous', 'unowned_legacy_row')
  }
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    return refused('remote', 'non_local_execution_host')
  }
  if (deps.platform === 'win32') {
    return refused('unsupported', 'platform_has_no_stable_inode')
  }
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || worktreeId.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
    return refused('unsupported', 'folder_workspace')
  }
  const owners = deps.store
    .getRepos()
    .filter((repo) => repo.id === parsed.repoId && getRepoExecutionHostId(repo) === hostId)
  if (owners.length === 0) {
    return refused('absent', 'repo_not_registered')
  }
  if (owners.length > 1) {
    return refused('ambiguous', 'repo_registered_twice')
  }
  const [repo] = owners
  if (isFolderRepo(repo)) {
    return refused('unsupported', 'folder_workspace')
  }
  try {
    deps.assertPlainLocalGit(repo)
  } catch {
    return refused('unsupported', 'git_routed_off_host')
  }
  if (deps.isRemovalPending(worktreeId)) {
    return refused('absent', 'removal_pending')
  }
  const scan = await deps.scanLocalRepo(repo).catch(() => ({ ok: false, worktrees: [] }))
  if (!scan.ok) {
    return refused('unsupported', 'git_scan_failed')
  }
  const registered = scan.worktrees.filter((entry) =>
    areWorktreePathsEqual(entry.path, parsed.worktreePath)
  )
  if (registered.length === 0) {
    return refused('absent', 'not_registered_with_git')
  }
  if (registered.length > 1 || registered[0].isBare) {
    return refused(registered.length > 1 ? 'ambiguous' : 'unsupported', 'unusable_git_entry')
  }
  const path = registered[0].path
  let root: RootStat
  try {
    root = await deps.lstatRoot(path)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? refused('absent', 'root_missing')
      : refused('unsupported', 'lstat_failed')
  }
  if (root.isSymbolicLink) {
    return refused('unsupported', 'root_is_symlink')
  }
  if (!root.isDirectory) {
    return refused('unsupported', 'root_not_directory')
  }
  return {
    status: 'ok',
    authoritative: true,
    instanceId,
    executionHostId: hostId,
    path,
    dev: root.dev.toString(),
    ino: root.ino.toString(),
    // Why: a deleted and recreated root can reuse the same (dev, ino); the birth time is the only
    // observable that differs. null = filesystem reports none, so the broker must hold an fd instead.
    birthtimeNs: root.birthtimeNs > 0n ? root.birthtimeNs.toString() : null,
    runtimeEpoch: deps.runtimeEpoch,
    generation
  }
}
