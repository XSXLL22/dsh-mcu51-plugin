import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOptionsApplication, applyOptionsApplication } from '../lib/options-application.js'
import { runIsp, makeIspPlan } from '../lib/isp.js'
import { execFileSync } from 'node:child_process'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/stc15-options-status.json', import.meta.url), 'utf8'))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcu-options-execution-'))
  const hex = join(dir, 'firmware.hex'); writeFileSync(hex, ':01000000AA55\n:00000001FF\n')
  const plan = prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, { hex, port: 'COM9', freqHz: 12_000_000 })
  assert.equal(plan.ok, true)
  return { dir, hex, plan }
}

test('dry run and invalid execution arguments never invoke the ISP runner', async () => {
  const { plan } = fixture()
  const runner = () => assert.fail('dry-run/invalid request must not open a transport')
  const dry = await applyOptionsApplication(plan, plan.applicationId, { dryRun: true }, runner)
  assert.equal(dry.ok, true); assert.equal(dry.hardwareAccess, false)
  for (const settings of [{ dryRun: 'true' }, { waitSeconds: 0 }, { waitSeconds: '60' }, { dryRun: true, port: 'COM8' },
    { dryRun: true, patch: {} }, { dryRun: true, freqHz: 11_059_200 }]) {
    assert.equal((await applyOptionsApplication(plan, plan.applicationId, settings, runner)).ok, false)
  }
  const abort = new AbortController(); abort.abort()
  assert.equal((await applyOptionsApplication(plan, plan.applicationId, { signal: abort.signal }, runner)).error, 'CANCELLED')
})

test('execution forwards exactly the bound application and requires a complete receipt', async () => {
  const { plan } = fixture()
  const receipt = { ok: true, stage: 'complete', programmed: true, hardwareOptionsWritten: true,
    optionsWrite: { acknowledged: true, msrHex: plan.intent.afterMsrHex }, applicationId: plan.applicationId }
  let seen
  const runner = async request => { seen = request; return receipt }
  const result = await applyOptionsApplication(plan, plan.applicationId, {}, runner)
  assert.equal(result.ok, true)
  assert.equal(seen.expectedSha256, plan.intent.image.sha256)
  assert.equal(seen.port, 'COM9'); assert.equal(seen.clockMode, 'calibrate')
  assert.deepEqual(seen.optionsApplication, plan.intent)
  for (const bad of [{ ...receipt, programmed: false }, { ...receipt, hardwareOptionsWritten: false },
    { ...receipt, optionsWrite: null }, { ...receipt, optionsWrite: { acknowledged: true, msrHex: 'ff ff ff ff ff' } },
    { ...receipt, applicationId: '0'.repeat(64) }, null]) {
    const failed = await applyOptionsApplication(plan, plan.applicationId, {}, async () => bad)
    assert.equal(failed.ok, false); assert.equal(failed.error, 'APPLICATION_NOT_CONFIRMED')
  }
})

test('Chinese-path application intent has the same canonical identity in bundled Python', () => {
  const { dir } = fixture()
  const hex = join(dir, '中文 固件.hex'); writeFileSync(hex, ':01000000AA55\n:00000001FF\n')
  const plan = prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, { hex, port: 'COM9', freqHz: 12_000_000 })
  const request = makeIspPlan({ action: 'flash', mcu: plan.intent.baseline.model, port: plan.intent.port,
    hex, expectedSha256: plan.intent.image.sha256, freqHz: plan.intent.requestedFreqHz,
    optionsApplication: plan.intent, applicationId: plan.applicationId })
  const output = execFileSync(join(PACKAGE_ROOT, 'runtime/win32-x64/python.exe'), ['-I', '-B', 'test/check_application_intent.py'],
    { cwd: PACKAGE_ROOT, input: JSON.stringify(request), encoding: 'utf8' })
  assert.equal(JSON.parse(output).ok, true)
})

test('runner exceptions preserve unknown operation state instead of claiming no write', async () => {
  const { plan } = fixture()
  const result = await applyOptionsApplication(plan, plan.applicationId, {}, async () => { throw new Error('lost executor') })
  assert.equal(result.ok, false)
  assert.equal(result.executionRequested, true)
  assert.equal(result.hardwareOptionsWritten, null)
  assert.equal(result.operationState, 'unknown-after-executor-error')
  assert.notEqual(result.hardwareAccess, false)
})

test('loss of a final sidecar receipt distinguishes early, erase and options phases', async () => {
  for (const stage of ['waiting_for_bootloader', 'erase', 'options']) {
    const result = await runIsp({ action: 'flash', port: 'COM9', mcu: 'IAP15F2K61S2', freqHz: 12_000_000 },
      async () => ({ stdout: JSON.stringify({ event: 'stage', stage }) + '\n', stderr: '', out: '', code: 1, timedOut: true }))
    assert.equal(result.ok, false)
    assert.equal(result.eraseMayHaveStarted, stage !== 'waiting_for_bootloader')
    if (stage === 'options') {
      assert.equal(result.hardwareOptionsWritten, null)
      assert.equal(result.operationState, 'unknown-after-process-loss')
    }
  }
})

test('mcu_options apply verifies a saved artifact offline and rejects bad files', async () => {
  const { dir, plan } = fixture()
  const application = join(dir, 'application.json'); writeFileSync(application, JSON.stringify(plan))
  const tool = buildToolSpecs({ defineTool: value => value, config: resolveConfig({ dataDir: dir }) }).find(value => value.name === 'mcu_options')
  const result = await tool.execute({ action: 'apply', application, expectedApplicationId: plan.applicationId, dryRun: true })
  assert.equal(result.ok, true, result.summary)
  assert.equal(result.data.hardwareAccess, false)
  writeFileSync(application, '{bad json')
  const bad = await tool.execute({ action: 'apply', application, expectedApplicationId: plan.applicationId, dryRun: true })
  assert.equal(bad.data.error, 'INVALID_APPLICATION_FILE')
  assert.equal(bad.data.hardwareAccess, false)
})

test('log persistence failure preserves the application receipt and reports the error', async () => {
  const { dir, plan } = fixture()
  const application = join(dir, 'application.json'); writeFileSync(application, JSON.stringify(plan))
  writeFileSync(join(dir, 'logs'), 'a file blocks the log directory')
  const tool = buildToolSpecs({ defineTool: value => value, config: resolveConfig({ dataDir: dir }) }).find(value => value.name === 'mcu_options')
  const result = await tool.execute({ action: 'apply', application, expectedApplicationId: plan.applicationId, dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.data.ok, true)
  assert.equal(result.data.applicationId, plan.applicationId)
  assert.equal(result.data.logPersisted, false)
  assert.ok(result.data.logError)
  assert.equal(result.data.hardwareAccess, false)
})
