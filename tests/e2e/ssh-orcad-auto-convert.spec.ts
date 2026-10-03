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
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { connectSshTestTarget } from './helpers/ssh-test-target-connection'
import { ORCAD_CONVERT_HOST_ENV, startOrcadConvertHost } from './helpers/orcad-convert-host'
import { findOrcadMigrationSourceCutoverForTarget } from '../../src/main/ssh/orcad-migration-cutover-journal'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Fixed per worker so the app's launch env can name them before the test runs.
const SCRATCH = path.join(os.tmpdir(), `orca-orcad-convert-${process.pid}`)
const TEMPLATE_DIR = path.join(SCRATCH, 'orcad-template')
const FLAGS_FILE = path.join(SCRATCH, 'rollout-flags.json')
const CONVERT_TIMEOUT_MS = 8 * 60_000

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
    await waitForActiveWorktree(page)

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
    // A tab that never spawns a shell: it stays in the session without a live relay terminal.
    const sessionTabId = await page.evaluate(
      (worktreeId) =>
        window.__store!.getState().createTab(worktreeId, undefined, undefined, {
          activate: false,
          pendingActivationSpawn: true
        }).id,
      remote.worktreeId
    )
    await ensureTerminalVisible(page, 45_000)
    const ptyId = await waitForActivePanePtyId(page, 60_000)
    const marker = `ORCAD-CONVERT-${Date.now()}`
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker, 30_000)
    // An exited shell leaves an exit record, which is what lets the gate prove no terminal runs.
    await execInTerminal(page, ptyId, 'exit')
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ worktreeId, tabId }) =>
              JSON.stringify(
                (await window.api.session.get()).tabsByWorktree?.[worktreeId] ?? []
              ).includes(tabId),
            { worktreeId: remote.worktreeId, tabId: sessionTabId }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)

    // 2. Template in place: the next connect converts the host.
    cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
    await reconnect(page, remote.targetId)
    await expect
      .poll(() => managedServer(page, remote.targetId), { timeout: CONVERT_TIMEOUT_MS })
      .toMatchObject({ kind: 'managed' })
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
