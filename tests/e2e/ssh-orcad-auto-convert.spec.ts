/**
 * A relay-era SSH host converts to managed orcad on connect (#24979), on a real host:
 *
 * 1. Without an orcad template the connect keeps the relay, so the host gains relay-era state: a
 *    repository, a folder workspace and a terminal session tab.
 * 2. With the template in place and no relay terminal running, the next connect converts it, and
 *    the new server lists that repository, folder and tab.
 * 3. The source rows stay retained (downgrade safety) until `orcad-source-retirement` is on; the
 *    connect after that retires them while the server keeps serving the host.
 *
 * Host: `ORCA_E2E_ORCAD_CONVERT_HOST=docker` (Linux fixture) or a Windows host-cell descriptor.
 * Template: `ORCA_E2E_ORCAD_CONVERT_TEMPLATE`, built for that host's target.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { connectSshTestTarget } from './helpers/ssh-test-target-connection'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import { ORCAD_CONVERT_HOST_ENV, startOrcadConvertHost } from './helpers/orcad-convert-host'
import { findOrcadMigrationSourceCutoverForTarget } from '../../src/main/ssh/orcad-migration-cutover-journal'
import { toSshExecutionHostId } from '../../src/shared/execution-host'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Fixed per worker so the app's launch env can name them before the test runs.
const SCRATCH = path.join(os.tmpdir(), `orca-orcad-convert-${process.pid}`)
const TEMPLATE_DIR = path.join(SCRATCH, 'orcad-template')
const FLAGS_FILE = path.join(SCRATCH, 'rollout-flags.json')

test.use({
  orcaAppExtraEnv: {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_DIR,
    ORCA_E2E_ROLLOUT_FLAGS_FILE: FLAGS_FILE
  }
})

async function reconnect(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.api.ssh.disconnect({ targetId: id })
    await window.api.ssh.connect({ targetId: id })
  }, targetId)
}

function managedServer(page: Page, targetId: string): Promise<unknown> {
  return page.evaluate(
    (id) => window.__store?.getState().sshConnectionStates.get(id)?.managedServer ?? null,
    targetId
  )
}

function isManaged(server: unknown): boolean {
  return (
    typeof server === 'object' && server !== null && 'kind' in server && server.kind === 'managed'
  )
}

function targetLeases(userData: string, targetId: string): { state?: unknown }[] {
  const leases = readPersistedProfileState(userData).sshRemotePtyLeases
  return (Array.isArray(leases) ? leases : []).filter((lease) => lease?.targetId === targetId)
}

async function serverCall(page: Page, selector: string, method: string): Promise<string> {
  const response = await page.evaluate((args) => window.api.runtimeEnvironments.call(args), {
    selector,
    method
  })
  expect(response, `${method} on the managed server`).toMatchObject({ ok: true })
  return JSON.stringify(response)
}

test('a relay host converts to managed orcad on connect, keeps its source, then retires it', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  test.skip(
    !HOST || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV} and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(20 * 60_000)
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  writeFileSync(FLAGS_FILE, '{}')
  const host = startOrcadConvertHost(HOST!, testInfo)
  try {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    await waitForSessionReady(page)
    const localWorktreeId = await waitForActiveWorktree(page)

    // 1. Relay era: no template, so the connect keeps the relay.
    const remote = await connectSshTestTarget(page, host.input, {
      remotePath: host.remoteRepoPath,
      displayName: 'orcad convert E2E',
      seedInitialTab: true
    })
    expect(await managedServer(page, remote.targetId)).toMatchObject({
      kind: 'relay',
      reason: 'orcad_unavailable'
    })
    const folderPath = await page.evaluate(
      async ({ targetId, folder }) => {
        const group = await window.api.projectGroups.create({
          name: 'orcad convert folders',
          parentPath: folder,
          connectionId: targetId
        })
        const workspace = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          folderPath: folder,
          connectionId: targetId
        })
        return workspace.folderPath
      },
      { targetId: remote.targetId, folder: host.remoteFolderPath }
    )
    await ensureTerminalVisible(page, 45_000)
    const ptyId = await waitForActivePanePtyId(page, 60_000)
    const seededTabId = await getActiveTabId(page)
    const marker = `ORCAD-CONVERT-${Date.now()}`
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker, 30_000)
    // Off the remote worktree first: closing the exited tab would otherwise activate, and spawn, the
    // next terminal tab there, and that live relay shell keeps the host on the relay.
    await switchToWorktree(page, localWorktreeId)
    // An exited shell leaves an exit record, which is what lets the gate prove no terminal runs.
    await execInTerminal(page, ptyId, 'exit')
    // The connect's terminal gate asks the relay the same question, so a timeout names the blocker.
    await expect
      .poll(
        () =>
          page.evaluate(
            async (connectionId) =>
              JSON.stringify(await window.api.pty.listSessions({ connectionId })),
            remote.targetId
          ),
        { timeout: 30_000 }
      )
      .toBe('[]')
    // The gate's other input: no lease may still read as a running terminal.
    await expect
      .poll(
        () => {
          const live = targetLeases(userData, remote.targetId).filter(
            (lease) => lease.state === 'attached' || lease.state === 'detached'
          )
          return JSON.stringify(live)
        },
        { timeout: 30_000 }
      )
      .toBe('[]')
    // Created while its worktree is hidden, so it stays in the session without ever mounting a shell.
    const sessionTabId = await page.evaluate(
      (worktreeId) =>
        window.__store!.getState().createTab(worktreeId, undefined, undefined, {
          activate: false
        }).id,
      remote.worktreeId
    )
    // An SSH worktree's session lives in its host's partition, not the local one.
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ hostId, worktreeId, tabId }) =>
              JSON.stringify(
                (await window.api.session.get(hostId)).tabsByWorktree?.[worktreeId] ?? []
              ).includes(tabId),
            {
              hostId: toSshExecutionHostId(remote.targetId),
              worktreeId: remote.worktreeId,
              tabId: sessionTabId
            }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)

    // 2. Template in place: the next connect converts the host.
    cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
    // A shell that starts after the checks above still blocks the gate; settle, then look again.
    await page.waitForTimeout(5_000)
    expect(
      JSON.stringify({
        sessions: await page.evaluate(
          (connectionId) => window.api.pty.listSessions({ connectionId }),
          remote.targetId
        ),
        leases: targetLeases(userData, remote.targetId).filter(
          (lease) => lease.state === 'attached' || lease.state === 'detached'
        ),
        seededTabId,
        sessionTabId
      })
    ).toBe(JSON.stringify({ sessions: [], leases: [], seededTabId, sessionTabId }))
    await reconnect(page, remote.targetId)
    // Polls the whole state so a timeout reports why the host stayed on the relay.
    await expect
      .poll(
        async () => {
          const server = await managedServer(page, remote.targetId)
          if (isManaged(server)) {
            return 'managed'
          }
          const leases = targetLeases(userData, remote.targetId)
          return JSON.stringify({ server, leases, seededTabId, sessionTabId })
        },
        // The connect returns only after the conversion settled, so this waits on the broadcast.
        { timeout: 30_000 }
      )
      .toBe('managed')
    const environments = await page.evaluate(() => window.api.runtimeEnvironments.list())
    const environment = environments.find(
      (entry) => entry.orcadDeployment?.sshTargetId === remote.targetId
    )
    expect(environment, 'a managed server registered for the host').toBeTruthy()
    expect(await serverCall(page, environment!.id, 'repo.list')).toContain(host.remoteRepoPath)
    expect(await serverCall(page, environment!.id, 'folderWorkspace.list')).toContain(folderPath)
    expect(await serverCall(page, environment!.id, 'session.tabs.listAll')).toContain(sessionTabId)

    // 3. Source retained for a downgrade, then retired once the rollout flag is on.
    expect(findOrcadMigrationSourceCutoverForTarget(userData, remote.targetId)).toMatchObject({
      phase: 'destination-committed',
      sourceRetainedAt: expect.any(String)
    })
    writeFileSync(FLAGS_FILE, JSON.stringify({ 'orcad-source-retirement': { state: 'on' } }))
    await reconnect(page, remote.targetId)
    await expect
      .poll(
        () => findOrcadMigrationSourceCutoverForTarget(userData, remote.targetId)?.phase ?? null,
        {
          timeout: 120_000
        }
      )
      .toBe('source-retired')
    expect(await managedServer(page, remote.targetId)).toMatchObject({ kind: 'managed' })
    expect(await serverCall(page, environment!.id, 'repo.list')).toContain(host.remoteRepoPath)
  } finally {
    host.cleanup()
    if (existsSync(SCRATCH)) {
      rmSync(SCRATCH, { recursive: true, force: true })
    }
  }
})
