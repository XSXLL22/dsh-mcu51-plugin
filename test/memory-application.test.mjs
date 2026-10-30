import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeImage, encodeDenseHex } from '../lib/image.js'
import { prepareMemoryPlan } from '../lib/memory-plan.js'
import { prepareMemoryApplication, verifyMemoryApplication, applyMemoryApplication } from '../lib/memory-application.js'
import { makeIspPlan } from '../lib/isp.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

const TEMP = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp')
const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/stc15-options-status.json', import.meta.url), 'utf8'))
mkdirSync(TEMP, { recursive: true })
function setup(t, dataOffset = 61440, code = Buffer.from([1, 2, 3]), data = Buffer.from([0xa5, 0x5a])) {
  const root = mkdtempSync(join(TEMP, '组合应用 中文 '))
  t.after(() => {
    const child = relative(TEMP, root)
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    rmSync(root, { recursive: true, force: true })
  })
  const recoveryHex = join(root, 'original.hex'), snapshot = join(root, 'status.json'), imagePath = join(root, 'image.json')
  writeFileSync(recoveryHex, encodeDenseHex(code)); writeFileSync(snapshot, JSON.stringify(SNAPSHOT))
  const sources = [{ path: recoveryHex }]
  if (data !== null) { const path = join(root, 'data.bin'); writeFileSync(path, data); sources.push({ path, buffer: 'eeprom' }) }
  const image = composeImage({ sources }); assert.equal(image.ok, true)
  writeFileSync(imagePath, JSON.stringify(image))
  const options = { targetId: 'stc675:8', bslVersion: '7.2.5S', erasePolicy: 'code', ...(data !== null ? { eepromOffset: dataOffset } : {}) }
  const preview = prepareMemoryPlan(image, image.imageId, options); assert.equal(preview.ok, true, preview.message)
  const args = { action: 'prepare', image: imagePath, expectedImageId: image.imageId, ...options, expectedMemoryPlanId: preview.memoryPlanId,
    recoveryHex, snapshot, port: 'COM9', freqHz: 12000000 }
  return { root, args, preview, image, prepare: () => prepareMemoryApplication(args, root) }
}
const receipt = spec => ({ ok: true, stage: 'complete', applicationId: spec.applicationId, programmed: true, programAcknowledged: true,
  hardwareOptionsWritten: true, optionsWrite: { msrHex: spec.memoryApplication.baseline.rawMsrHex, acknowledged: true },
  boundImageVerified: true, imageBinding: spec.imageBinding })

test('prepare binds 61952 combined bytes, exact recovery, preview and saved baseline without serial access', t => {
  const f = setup(t), app = f.prepare(); assert.equal(app.ok, true, app.message)
  assert.equal(app.intent.image.denseBytes, 61952)
  assert.equal(app.intent.data.offset, 61440)
  assert.equal(app.intent.tailPolicy.programmingEndExclusive, 61952)
  assert.equal(app.intent.baseline.rawMsrHex, 'f7 bb 9f fd ff')
  assert.equal(app.effects.codeEraseBytes, null)
  assert.equal(app.hardwareAccess, false); assert.equal(app.hardwareValidated, false)
  assert.equal(f.prepare().applicationId, app.applicationId)
  assert.equal(verifyMemoryApplication(app, app.applicationId).ok, true)
  assert.deepEqual(readFileSync(app.intent.codeRecovery.path), readFileSync(f.args.recoveryHex))
})

test('prepare rejects last sector, unsupported BSL/model, frequency types and mismatched preview', t => {
  const f = setup(t)
  for (const change of [{ freqHz: '12000000' }, { freqHz: 11059200 }, { port: ' COM9' }, { expectedMemoryPlanId: '0'.repeat(64) },
    { bslVersion: '7.2' }, { buffer: 'code' }]) assert.equal(prepareMemoryApplication({ ...f.args, ...change }, f.root).ok, false)
  const tail = setup(t, 61952); assert.equal(tail.prepare().error, 'MEMORY_PROFILE_UNAVAILABLE')
  const codeTail = setup(t, 0, Buffer.alloc(61953), null); assert.equal(codeTail.prepare().error, 'MEMORY_PROFILE_UNAVAILABLE')
})

test('prepare rejects enabled EEPROM erasure and recovery code changes', t => {
  const f = setup(t), changed = structuredClone(SNAPSHOT)
  changed.chip.hardwareOptions.rawMsrHex = 'f7 bb 9f ff ff'; changed.chip.hardwareOptions.values.eeprom_erase_enabled = true
  writeFileSync(f.args.snapshot, JSON.stringify(changed)); assert.equal(f.prepare().error, 'MEMORY_BASELINE_UNSUPPORTED')
  writeFileSync(f.args.snapshot, JSON.stringify(SNAPSHOT)); writeFileSync(f.args.recoveryHex, encodeDenseHex(Buffer.from([4, 5, 6])))
  assert.equal(f.prepare().error, 'MEMORY_RECOVERY_MISMATCH')
})

test('changed files/intent fail rebuild; missing generated file is never silently recreated', t => {
  for (const field of ['image', 'codeRecovery', 'sourceImage', 'snapshot', 'recoverySource']) {
    const f = setup(t), app = f.prepare(), path = app.intent[field].path
    const before = readFileSync(path); writeFileSync(path, Buffer.concat([before, Buffer.from(' ')]))
    assert.equal(verifyMemoryApplication(app, app.applicationId).ok, false, field)
    assert.deepEqual(readFileSync(path), Buffer.concat([before, Buffer.from(' ')]))
  }
  const f = setup(t), app = f.prepare(); unlinkSync(app.intent.image.path)
  assert.equal(verifyMemoryApplication(app, app.applicationId).ok, false)
  assert.throws(() => readFileSync(app.intent.image.path))
  app.intent.baseline.freqHz++
  assert.equal(verifyMemoryApplication(app, app.applicationId).ok, false)
})

test('apply dryRun, cancellation and target overrides do not call the executor', async t => {
  const f = setup(t), app = f.prepare(), runner = () => assert.fail('must not execute')
  assert.equal((await applyMemoryApplication(app, app.applicationId, { dryRun: true }, runner)).ok, true)
  assert.equal((await applyMemoryApplication(app, app.applicationId, { signal: AbortSignal.abort() }, runner)).error, 'CANCELLED')
  for (const settings of [{ port: 'COM8' }, { waitSeconds: true }, { dryRun: 'true' }]) {
    assert.equal((await applyMemoryApplication(app, app.applicationId, settings, runner)).ok, false)
  }
})

test('complete receipt requires both identity and options ACK; failures preserve partial state and never retry', async t => {
  const f = setup(t), app = f.prepare(); let calls = 0
  const run = async transform => applyMemoryApplication(app, app.applicationId, {}, async spec => { calls++; return transform(receipt(spec)) })
  assert.equal((await run(r => r)).ok, true)
  for (const change of [r => ({ ...r, applicationId: '0'.repeat(64) }), r => ({ ...r, boundImageVerified: false }),
    r => ({ ...r, imageBinding: null }), r => ({ ...r, optionsWrite: { msrHex: 'f6 bb 9f fd ff', acknowledged: true } }),
    r => ({ ...r, ok: false, error: 'CANCELLED', eraseStarted: true, hardwareOptionsWritten: false })]) {
    const result = await run(change); assert.equal(result.ok, false); assert.equal(result.executionRequested, true)
    assert.equal(result.programAcknowledged, true)
  }
  assert.equal(calls, 6)
  const lost = await applyMemoryApplication(app, app.applicationId, {}, async () => { throw new Error('lost') })
  assert.equal(lost.ok, false); assert.equal(lost.eraseStarted, null)
})

test('DSH tools save preparation and dryRun receipts; incompatible flash inputs never execute', async t => {
  const f = setup(t)
  const tools = buildToolSpecs({ defineTool: v => v, config: resolveConfig({ dataDir: f.root }), ispRunner: () => assert.fail('must not execute') })
  const image = tools.find(t => t.name === 'mcu_image'), flash = tools.find(t => t.name === 'mcu_flash')
  const prepared = await image.execute(f.args); assert.equal(prepared.ok, true, prepared.summary)
  const args = { memoryApplication: prepared.logPath, expectedMemoryApplicationId: prepared.data.applicationId, dryRun: true }
  const dry = await flash.execute(args); assert.equal(dry.ok, true, dry.summary); assert.equal(dry.data.hardwareAccess, false)
  assert.equal(JSON.parse(readFileSync(dry.logPath)).applicationId, prepared.data.applicationId)
  assert.equal((await flash.execute({ ...args, hex: f.args.recoveryHex })).data.error, 'MEMORY_PARAMETER_CONFLICT')
  assert.equal((await image.execute({ ...f.args, action: 'export' })).ok, false)
})

test('JS-prepared intent is validated and replayed by isolated bundled Python, including all 484 data blocks', async t => {
  const f = setup(t), app = f.prepare(); let captured
  const result = await applyMemoryApplication(app, app.applicationId, {}, async spec => { captured = spec; return receipt(spec) })
  assert.equal(result.ok, true)
  const request = join(f.root, 'request.json'); writeFileSync(request, JSON.stringify(makeIspPlan(captured)))
  const replay = spawnSync(join(PACKAGE_ROOT, 'runtime/win32-x64/python.exe'), ['-I', '-B', join(PACKAGE_ROOT, 'test/memory_apply_worker.py'), '--request', request],
    { encoding: 'utf8', timeout: 30000 })
  assert.equal(replay.status, 0, replay.stdout + replay.stderr)
  const answer = JSON.parse(replay.stdout)
  assert.equal(answer.ok, true); assert.equal(answer.blocks, 484); assert.equal(answer.serialReconfigurationsAfterPrepare, 0)
})

test('code-only memory application follows the same validated transport without inventing a data range', async t => {
  const f = setup(t, 0, Buffer.from([1, 2, 3]), null), app = f.prepare(); let captured
  assert.equal(app.ok, true, app.message); assert.equal(app.intent.data, null)
  const result = await applyMemoryApplication(app, app.applicationId, {}, async spec => { captured = spec; return receipt(spec) })
  assert.equal(result.ok, true)
  const request = join(f.root, 'code-only-request.json'); writeFileSync(request, JSON.stringify(makeIspPlan(captured)))
  const replay = spawnSync(join(PACKAGE_ROOT, 'runtime/win32-x64/python.exe'), ['-I', '-B', join(PACKAGE_ROOT, 'test/memory_apply_worker.py'), '--request', request],
    { encoding: 'utf8', timeout: 30000 })
  assert.equal(replay.status, 0, replay.stdout + replay.stderr)
  const answer = JSON.parse(replay.stdout)
  assert.equal(answer.ok, true); assert.equal(answer.tests, 9); assert.equal(answer.blocks, 4)
})
