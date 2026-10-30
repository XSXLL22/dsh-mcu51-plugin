// Closed executor and offline parameters only. No COM is opened.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIspParameters } from '../lib/session-parameters.js'
import { makeIspPlan, runIsp } from '../lib/isp.js'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'
import { composeImage } from '../lib/image.js'
import { prepareMemoryPlan } from '../lib/memory-plan.js'
import { prepareMemoryApplication, applyMemoryApplication } from '../lib/memory-application.js'
import { prepareOptionsApplication, applyOptionsApplication } from '../lib/options-application.js'

const request = { action: 'flash', port: 'COM18', mcu: 'IAP15F2K61S2', expectedUid: '001122aabbccdd' }
const uid = '001122AABBCCDD'
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/stc15-options-status.json', import.meta.url), 'utf8'))
const identity = () => ({ chip: { uid }, eraseReception: { expectedUid: uid, actualUid: uid, frameAndUidMatched: true,
  originalEraseReturned: true, nativeTimeouts: { restored: true }, cleanupErrors: [], failure: null } })

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mcu037-'))
  t.after(() => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true }) })
  const hex = join(directory, 'code.hex'), status = join(directory, 'status.json'), imageFile = join(directory, 'image.json')
  writeFileSync(hex, ':01000000AA55\n:00000001FF\n'); writeFileSync(status, JSON.stringify(snapshot))
  const image = composeImage({ sources: [{ path: hex }] }); assert.equal(image.ok, true)
  writeFileSync(imageFile, JSON.stringify(image))
  const placement = { targetId: 'stc675:8', bslVersion: '7.2.5S', erasePolicy: 'code' }
  const preview = prepareMemoryPlan(image, image.imageId, placement)
  const memory = prepareMemoryApplication({ action: 'prepare', image: imageFile, expectedImageId: image.imageId,
    ...placement, expectedMemoryPlanId: preview.memoryPlanId, snapshot: status, port: 'COM18', freqHz: 12000000, recoveryHex: hex }, directory)
  const options = prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, { hex, port: 'COM18', freqHz: 12000000 })
  assert.equal(memory.ok, true, memory.message); assert.equal(options.ok, true, options.message)
  return { directory, hex, memory, options, imageFile, image }
}

test('explicit UID is strict, normalized and preserved in the concrete ISP plan', () => {
  assert.equal(makeIspPlan(request).expectedUid, '001122AABBCCDD')
  assert.equal(makeIspPlan(request).targetVerification.phase, 'erase-response')
  assert.equal(makeIspPlan(request).targetVerification.beforeEraseIdentityVerified, false)
  for (const patch of [{ expectedUid: null }, { expectedUid: true }, { expectedUid: '00' },
    { expectedUid: '00 11 22 aa bb cc dd' }, { expectedUid: '001122AABBCCDD\n' },
    { action: 'chipinfo' }, { action: 'handshake' }, { mcu: 'STC89C52RC' }, { clockMode: 'preserve' }]) {
    assert.throws(() => normalizeIspParameters({ ...request, ...patch }), /UID|expectedUid/)
  }
  const absent = { ...request }; delete absent.expectedUid
  assert.equal(Object.hasOwn(makeIspPlan(absent), 'expectedUid'), false)
})

test('declared success without explicit identity/timeout confirmation is not accepted', async () => {
  const final = { event: 'result', ok: true, stage: 'complete', programmed: true,
    eraseStarted: true, programAcknowledged: true, hardwareOptionsWritten: true, chip: { uid: '001122AABBCCDD' } }
  const execute = async (_script, spec) => {
    assert.equal(spec.expectedUid, '001122AABBCCDD')
    return { code: 0, stdout: JSON.stringify(final), stderr: '', processClosed: true }
  }
  const result = await runIsp(request, execute)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'TARGET_RECEIPT_MISMATCH')
  assert.equal(result.eraseStarted, true)
  assert.equal(result.programAcknowledged, true)
})

test('matching UID/ACK/timeout receipt passes; all contradictory identity receipts fail', async () => {
  const final = { event: 'result', ok: true, eraseStarted: true, programAcknowledged: true, ...identity() }
  const execute = value => async () => ({ code: 0, stdout: JSON.stringify(value), stderr: '', processClosed: true })
  assert.equal((await runIsp(request, execute(final))).ok, true)
  for (const change of [r => { r.chip.uid = 'FF'.repeat(7) }, r => { r.eraseReception.actualUid = 'FF'.repeat(7) },
    r => { r.eraseReception.nativeTimeouts.restored = false }, r => { r.eraseReception.originalEraseReturned = false },
    r => { r.eraseReception.cleanupErrors = [{ message: 'restore failed' }] }]) {
    const copy = structuredClone(final); change(copy)
    const result = await runIsp(request, execute(copy))
    assert.equal(result.ok, false); assert.equal(result.error, 'TARGET_RECEIPT_MISMATCH')
    assert.equal(result.eraseStarted, true)
  }
})

test('memory and options applications preserve execution UID and reject an executor ignoring it', async t => {
  const f = fixture(t)
  for (const [app, apply] of [[f.memory, applyMemoryApplication], [f.options, applyOptionsApplication]]) {
    const settings = { expectedUid: request.expectedUid }
    const dry = await apply(app, app.applicationId, { ...settings, dryRun: true }, () => assert.fail('hardware in dry-run'))
    assert.equal(dry.ok, true); assert.equal(dry.expectedUid, uid)
    for (const value of [null, true, '00']) {
      const invalid = await apply(app, app.applicationId, { expectedUid: value }, () => assert.fail('invalid UID ran hardware'))
      assert.equal(invalid.ok, false)
    }
    let seen
    const execute = async spec => {
      seen = spec
      return { ok: true, stage: 'complete', applicationId: spec.applicationId, programmed: true,
        programAcknowledged: true, hardwareOptionsWritten: true, optionsWrite: { acknowledged: true,
          msrHex: spec.memoryApplication?.baseline.rawMsrHex ?? spec.optionsApplication.afterMsrHex },
        boundImageVerified: true, imageBinding: spec.imageBinding }
    }
    const ignored = await apply(app, app.applicationId, settings, execute)
    assert.equal(seen.expectedUid, uid); assert.equal(ignored.ok, false)
    assert.equal(ignored.programAcknowledged, true)
    const passed = await apply(app, app.applicationId, settings, async spec => ({ ...await execute(spec), ...identity() }))
    assert.equal(passed.ok, true)
  }
})

test('public HEX, image, memory and option tools forward UID without opening a real transport', async t => {
  const f = fixture(t); let seen
  const specs = buildToolSpecs({ defineTool: value => value, config: resolveConfig({ dataDir: f.directory }),
    ispRunner: async spec => { seen = spec; return { ok: false, applicationId: spec.applicationId, error: 'CLOSED_EXECUTOR', eraseStarted: false } } })
  const flash = specs.find(value => value.name === 'mcu_flash'), options = specs.find(value => value.name === 'mcu_options')
  const regular = await flash.execute({ hex: f.hex, port: 'COM18', mcu: request.mcu, freqHz: 12000000, expectedUid: request.expectedUid })
  assert.equal(regular.ok, false); assert.equal(seen.expectedUid, uid)
  const image = await flash.execute({ image: f.imageFile, expectedImageId: f.image.imageId, port: 'COM18', mcu: request.mcu,
    freqHz: 12000000, expectedUid: request.expectedUid })
  assert.equal(image.ok, false); assert.equal(seen.expectedUid, uid); assert.equal(seen.imageBinding.imageId, f.image.imageId)
  const appFile = join(f.directory, 'memory.json'); writeFileSync(appFile, JSON.stringify(f.memory))
  assert.equal((await flash.execute({ memoryApplication: appFile, expectedMemoryApplicationId: f.memory.applicationId, expectedUid: request.expectedUid })).ok, false)
  assert.equal(seen.expectedUid, uid); assert.ok(seen.memoryApplication)
  const optionFile = join(f.directory, 'options.json'); writeFileSync(optionFile, JSON.stringify(f.options))
  assert.equal((await options.execute({ action: 'apply', application: optionFile, expectedApplicationId: f.options.applicationId, expectedUid: request.expectedUid })).ok, false)
  assert.equal(seen.expectedUid, uid); assert.ok(seen.optionsApplication)
  assert.equal((await options.execute({ action: 'read', expectedUid: uid })).ok, false)
  const dishonest = buildToolSpecs({ defineTool: value => value, config: resolveConfig({ dataDir: f.directory }),
    ispRunner: async () => ({ ok: true, eraseStarted: true, programAcknowledged: true }) }).find(value => value.name === 'mcu_flash')
  const rejected = await dishonest.execute({ hex: f.hex, port: 'COM18', mcu: request.mcu, freqHz: 12000000, expectedUid: uid })
  assert.equal(rejected.ok, false); assert.equal(rejected.data.result.error, 'TARGET_RECEIPT_MISMATCH')
  assert.equal(rejected.data.result.eraseStarted, true)
})
