import { z } from 'zod'
import type { RuntimeWorktreeInstanceAttestation } from '../runtime-worktree-contracts'

const OkAttestation = z.object({
  status: z.literal('ok'),
  authoritative: z.literal(true),
  instanceId: z.string().min(1),
  executionHostId: z.string().min(1),
  path: z.string().min(1),
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
  runtimeEpoch: z.string().min(1),
  generation: z.number().int().nonnegative()
})

const RefusedAttestation = z.object({
  status: z.enum(['absent', 'ambiguous', 'remote', 'unsupported'])
})

/** Why not just trust the wire: an old host strips fields or answers a different shape entirely. */
export function interpretWorktreeInstanceAttestation(
  raw: unknown,
  requestedInstanceId: string
): RuntimeWorktreeInstanceAttestation {
  const ok = OkAttestation.safeParse(raw)
  if (ok.success) {
    // A reply for another instance is never authoritative for this one.
    return ok.data.instanceId === requestedInstanceId
      ? ok.data
      : refused('unsupported', 'instance_mismatch')
  }
  const refusal = RefusedAttestation.safeParse(raw)
  return refusal.success
    ? refused(refusal.data.status, undefined)
    : refused('unsupported', 'malformed_reply')
}

/** The verdict for a host that has no `worktree.attestInstance`: cannot attest, so never authoritative. */
export function hostLacksWorktreeAttestation(): RuntimeWorktreeInstanceAttestation {
  return refused('unsupported', 'host_lacks_method')
}

function refused(
  status: 'absent' | 'ambiguous' | 'remote' | 'unsupported',
  reason: string | undefined
): RuntimeWorktreeInstanceAttestation {
  return { status, authoritative: false, ...(reason ? { reason } : {}) }
}
