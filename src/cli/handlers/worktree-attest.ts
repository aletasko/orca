import type { RuntimeWorktreeInstanceAttestation } from '../../shared/runtime-worktree-contracts'
import {
  hostLacksWorktreeAttestation,
  interpretWorktreeInstanceAttestation
} from '../../shared/worktree/instance-attestation'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'

/**
 * Ask the host to attest one worktree instance. Fail closed: a host that predates the method, or
 * answers anything but a well-formed `ok` for this instance, yields a non-authoritative verdict.
 * Transport errors still throw, since there is no verdict to downgrade.
 */
export async function attestWorktreeInstanceViaClient(
  client: Pick<RuntimeClient, 'call'>,
  instanceId: string
): Promise<RuntimeWorktreeInstanceAttestation> {
  try {
    const response = await client.call<unknown>('worktree.attestInstance', { instanceId })
    return interpretWorktreeInstanceAttestation(response.result, instanceId)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return hostLacksWorktreeAttestation()
    }
    throw error
  }
}

export function formatWorktreeInstanceAttestation(
  attestation: RuntimeWorktreeInstanceAttestation
): string {
  return attestation.status === 'ok'
    ? [
        `status: ok (authoritative)`,
        `instanceId: ${attestation.instanceId}`,
        `host: ${attestation.executionHostId}`,
        `path: ${attestation.path}`,
        `dev/ino: ${attestation.dev}/${attestation.ino}`,
        `birthtimeNs: ${attestation.birthtimeNs ?? 'none (pin with a held fd)'}`,
        `runtimeEpoch: ${attestation.runtimeEpoch}`,
        `generation: ${attestation.generation}`
      ].join('\n')
    : `status: ${attestation.status} (not authoritative)${attestation.reason ? ` [${attestation.reason}]` : ''}`
}

const attestHandler: CommandHandler = async ({ flags, client, json }) => {
  // Printed directly rather than via `printResult`: this is one instance on one host, not a listing.
  const attestation = await attestWorktreeInstanceViaClient(
    client,
    getRequiredStringFlag(flags, 'instance')
  )
  console.log(
    json ? JSON.stringify(attestation, null, 2) : formatWorktreeInstanceAttestation(attestation)
  )
}

export const WORKTREE_ATTEST_HANDLERS: Record<string, CommandHandler> = {
  'worktree attest': attestHandler
}
