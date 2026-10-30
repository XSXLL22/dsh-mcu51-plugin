// Offline-only option plans. Synthetic cases are not hardware write evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { optionSchema, planOptions } from '../lib/hardware-options.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

const observed = JSON.parse(readFileSync(new URL('./fixtures/stc15-options-status.json', import.meta.url), 'utf8'))
const copy = () => structuredClone(observed)

test('a no-op plan cannot perform or authorize a hardware write', () => {
  const result = planOptions(copy(), {})
  assert.equal(result.ok, true)
  assert.equal(result.hasChanges, false)
  assert.equal(result.executable, false)
  assert.equal(result.hardwareAccess, false)
  assert.equal(result.afterMsrHex, 'f7 bb 9f fd ff')
})

test('a real snapshot produces exact field and byte differences without mutation', () => {
  const snapshot = copy()
  const before = JSON.stringify(snapshot)
  const result = planOptions(snapshot, { watchdog_prescale: 128, por_reset_delay: 'short' })
  assert.equal(result.ok, true)
  assert.equal(result.afterMsrHex, 'f6 bb 1f fd ff')
  assert.deepEqual(result.byteDiffs, [
    { index: 0, before: 'f7', after: 'f6', changedMask: '01' },
    { index: 2, before: '9f', after: '1f', changedMask: '80' },
  ])
  assert.deepEqual(result.changes.map(c => [c.field, c.before, c.after]), [
    ['por_reset_delay', 'long', 'short'], ['watchdog_prescale', 256, 128],
  ])
  assert.equal(JSON.stringify(snapshot), before)
  assert.equal(result.executable, false)
})

test('unknown fields and ambiguous values are rejected rather than coerced', () => {
  for (const patch of [null, [], { wat: true }, { watchdog_por_enabled: 'false' },
    { watchdog_prescale: '128' }, { watchdog_prescale: 3 }, { low_voltage_threshold: 3.82 },
    { por_reset_delay: true }, JSON.parse('{"__proto__":true}')]) {
    assert.equal(planOptions(copy(), patch).ok, false, JSON.stringify(patch))
  }
})

test('unverified core-voltage setting remains visible and blocked', () => {
  const schema = optionSchema()
  assert.equal(schema.fields.length, 16)
  for (const field of ['cpu_core_voltage']) {
    assert.equal(schema.fields.find(f => f.name === field).planSupported, false)
    assert.equal(planOptions(copy(), { [field]: field === 'uart2_passthrough' ? true : 'high' }).error, 'OPTION_NOT_VERIFIED')
  }
})

test('voltage uses official model-specific nominal mapping and retains encoding API', () => {
  const fields = optionSchema().fields
  assert.equal(fields.find(f => f.name === 'low_voltage_threshold').unit, 'encoding')
  const threshold = fields.find(f => f.name === 'low_voltage_threshold')
  assert.equal(threshold.voltageMapping, 'official-static')
  assert.deepEqual(threshold.nominalVoltsByEncoding, [4.64, 4.32, 4.05, 3.82, 3.61, 3.43, 3.28, 3.14])
  const plan = planOptions(copy(), { low_voltage_threshold: 4 })
  assert.equal(plan.changes[0].beforeNominalVolts, 3.82)
  assert.equal(plan.changes[0].afterNominalVolts, 3.61)
  assert.equal(plan.afterMsrHex, 'f7 bc 9f fd ff')
  assert.equal(fields.find(f => f.name === 'rstout_por_state').physicalPin, 'P2.0/RSTOUT_LOW')
})

test('bad, mismatched, or pre-write snapshots never generate a plan', () => {
  const variants = [
    s => { s.ok = false }, s => { s.action = 'flash' }, s => { s.stage = 'identify' },
    s => { s.programmed = true }, s => { s.eraseStarted = true }, s => { s.hardwareOptionsWritten = true },
    s => { s.chip.magic = 'F450' }, s => { s.chip.bslVersion = '7.2.4S' },
    s => { s.chip.hardwareOptions.ok = false }, s => { s.chip.hardwareOptions.schemaVersion = 2 },
    s => { s.chip.hardwareOptions.errors = [{ field: 'clock_source' }] },
    s => { s.chip.hardwareOptions.rawMsrHex = 'f7 bb 9f fd' },
    s => { s.chip.hardwareOptions.values.watchdog_prescale = 128 },
  ]
  for (const mutate of variants) {
    const snapshot = copy(); mutate(snapshot)
    const result = planOptions(snapshot, { por_reset_delay: 'short' })
    assert.equal(result.ok, false, mutate.toString())
    assert.equal(result.hardwareAccess, false)
  }
})

test('plan identity binds raw state, patch values, and profile independent of key order', () => {
  const first = planOptions(copy(), { watchdog_prescale: 128, por_reset_delay: 'short' })
  const second = planOptions(copy(), { por_reset_delay: 'short', watchdog_prescale: 128 })
  assert.equal(first.planId, second.planId)
  assert.notEqual(first.planId, planOptions(copy(), { por_reset_delay: 'short' }).planId)
  const schema = optionSchema(); schema.fields[0].byteIndex = 99
  assert.notEqual(optionSchema().fields[0].byteIndex, 99)
})

test('independent stcgal oracle checks every supported value across varied reserved bits', () => {
  // Upstream's UART pin-mode setter is known to treat both strings as true.
  // Its independent official vectors are exercised below instead of trusting it.
  const supported = optionSchema().fields.filter(f => f.planSupported && f.name !== 'uart2_pin_mode')
  const requests = []
  for (const raw of ['f7 bb 9f fd ff', '00 00 00 00 ff', 'ff ff ff ff ff', 'a5 5a c3 3c ff', '5a a5 3c c3 ff']) {
    for (const field of supported) for (const value of field.values) requests.push({ raw, patch: { [field.name]: value } })
  }
  const output = execFileSync(join(PACKAGE_ROOT, 'runtime/win32-x64/python.exe'), ['-I', '-B', 'test/options_oracle.py'],
    { cwd: PACKAGE_ROOT, input: JSON.stringify(requests), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const oracle = JSON.parse(output)
  for (let index = 0; index < requests.length; index++) {
    const snapshot = copy()
    snapshot.chip.hardwareOptions.rawMsrHex = requests[index].raw
    snapshot.chip.hardwareOptions.values = oracle[index].before
    const result = planOptions(snapshot, requests[index].patch)
    assert.equal(result.ok, true, JSON.stringify({ request: requests[index], result }))
    assert.equal(result.afterMsrHex, oracle[index].afterRaw, JSON.stringify(requests[index]))
  }
})

test('official TXD vectors allow both UART legacy keys and clear push-pull correctly', () => {
  const schema = optionSchema()
  const pinMode = schema.fields.find(f => f.name === 'uart2_pin_mode')
  assert.equal(pinMode.planSupported, true)
  assert.equal(pinMode.physicalSignal, 'TXD')
  assert.equal(pinMode.legacyName, true)
  const cases = [
    ['9f', false, 'normal'], ['bf', false, 'push-pull'],
    ['df', true, 'normal'], ['ff', true, 'push-pull'],
  ]
  for (const [initial, passthrough, mode] of cases) {
    const snapshot = copy()
    snapshot.chip.hardwareOptions.rawMsrHex = 'f7 bb ' + initial + ' fd ff'
    snapshot.chip.hardwareOptions.values.uart2_passthrough = passthrough
    snapshot.chip.hardwareOptions.values.uart2_pin_mode = mode
    for (const [expected, nextPassthrough, nextMode] of cases) {
      const result = planOptions(snapshot, { uart2_passthrough: nextPassthrough, uart2_pin_mode: nextMode })
      assert.equal(result.ok, true)
      assert.equal(result.afterMsrHex, 'f7 bb ' + expected + ' fd ff')
    }
  }
})

test('missing or malformed official data returns an error without breaking module import', async () => {
  for (const data of [null, '{bad json', '{"schemaVersion":1,"models":[]}']) {
    const root = mkdtempSync(join(tmpdir(), 'mcu-official-data-'))
    mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'data'))
    const file = join(root, 'lib/options.mjs')
    copyFileSync(join(PACKAGE_ROOT, 'lib/hardware-options.js'), file)
    if (data !== null) writeFileSync(join(root, 'data/official-stc15.json'), data)
    const module = await import(pathToFileURL(file).href)
    assert.equal(module.optionSchema().error, 'OFFICIAL_OPTION_DATA_INVALID')
    assert.equal(module.planOptions(copy(), {}).hardwareAccess, false)
  }
})

test('mcu_options schema/plan work offline and apply requires a prepared artifact', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcu-options-'))
  const config = resolveConfig({ dataDir })
  const tool = buildToolSpecs({ defineTool: value => value, config }).find(s => s.name === 'mcu_options')
  assert.ok(tool)
  const snapshotPath = join(dataDir, 'chip.json')
  const bytes = Buffer.from(JSON.stringify(observed))
  writeFileSync(snapshotPath, bytes)
  assert.equal((await tool.execute({ action: 'schema' })).ok, true)
  const value = await tool.execute({ action: 'plan', snapshot: snapshotPath, patch: { por_reset_delay: 'short' } })
  assert.equal(value.ok, true, value.summary)
  assert.equal(value.data.source.fileSha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(value.data.afterMsrHex, 'f7 bb 1f fd ff')
  assert.equal(value.data.executable, false)
  const blocked = await tool.execute({ action: 'apply', snapshot: snapshotPath, patch: {} })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.data.error, 'APPLICATION_PLAN_REQUIRED')
})

test('saved-file errors and target mismatches remain explicit and offline', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcu-options-errors-'))
  const tool = buildToolSpecs({ defineTool: value => value, config: resolveConfig({ dataDir }) }).find(s => s.name === 'mcu_options')
  const file = join(dataDir, 'snapshot.json')
  const missing = await tool.execute({ action: 'plan', snapshot: file, patch: {} })
  assert.equal(missing.data.error, 'INVALID_SNAPSHOT_FILE')
  writeFileSync(file, '{bad json')
  const invalid = await tool.execute({ action: 'plan', snapshot: file, patch: {} })
  assert.equal(invalid.data.error, 'INVALID_SNAPSHOT_FILE')
  assert.equal(invalid.data.hardwareAccess, false)
  writeFileSync(file, '\uFEFF' + JSON.stringify({ ok: true, data: observed }))
  assert.equal((await tool.execute({ action: 'plan', snapshot: file, patch: {} })).ok, true)
  const mismatch = await tool.execute({ action: 'plan', snapshot: file, mcu: 'STC89C52RC', patch: {} })
  assert.equal(mismatch.data.error, 'TARGET_MISMATCH')
  assert.equal(optionSchema('STC89C52RC').error, 'PROFILE_NOT_AVAILABLE')
  assert.equal((await tool.execute({ action: 'plna', port: 'COM9' })).data.error, 'UNKNOWN_OPTIONS_ACTION')
})
