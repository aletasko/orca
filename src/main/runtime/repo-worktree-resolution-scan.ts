import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listWorktreesStrict } from '../git/worktree'
import { readWorktreeList } from '../git/worktree-list-reader'
import { isWorktreeCreatePreparation } from '../../shared/worktree/create-preparation'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[] }

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees }
  } catch {
    return { ok: false, worktrees: [] }
  }
}

/**
 * Plain `git worktree list` for the attestation RPC: no sparse-checkout annotation, so it neither
 * reads nor populates `sparseCheckoutStateCache` (and spawns no per-worktree sparse probe). The
 * verdict only needs path and bare-ness. Local, non-WSL repos only: the caller refuses the rest first.
 */
export async function scanLocalRepoWorktreesForAttestation(
  repoPath: string
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = (await readWorktreeList(repoPath)).filter(
      (worktree) => !isWorktreeCreatePreparation(worktree)
    )
    return { ok: true, worktrees }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
