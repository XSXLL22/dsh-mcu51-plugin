import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOptionsApplication, verifyOptionsApplication } from '../lib/options-application.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/stc15-options-status.json', import.meta.url), 'utf8'))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcu-options-application-'))
  const hex = join(dir, 'firmware.hex')
  writeFileSync(hex, ':01000000AA55\n:00000001FF\n')
  return { dir, hex, port: 'COM9', freqHz: 12_000_000 }
}

test('application preparation separates a code erase request from unverified physical extent', () => {
  const result = prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, fixture())
  assert.equal(result.ok, true, result.message)
  assert.equal(result.intent.method, 'reflash-code')
  assert.equal(result.intent.baseline.rawMsrHex, 'f7 bb 9f fd ff')
  assert.equal(result.intent.afterMsrHex, 'f6 bb 9f fd ff')
  assert.equal(result.intent.image.paddedBytes, 512)
  assert.equal(result.effects.codeEraseBytes, null)
  assert.equal(result.effects.nominalCodeBytes, 62464)
  assert.equal(result.effects.explicitCodeEraseLengthEncoded, false)
  assert.equal(result.effects.addressesOutsideImage, 'not-preserved-or-independently-read')
  assert.equal(result.effects.calibration, 'recalibrate-internal-irc')
  assert.equal(result.effects.eepromEraseRequest, false)
  assert.equal(result.hardwareAccess, false)
  assert.equal(result.executable, false)
  assert.equal(result.independentFlashReadback, false)
})

test('application ID binds firmware, requested frequency, port, baseline and patch', () => {
  const options = fixture()
  const first = prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, options)
  assert.equal(first.applicationId, prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, options).applicationId)
  for (const change of [{ port: 'COM8' }, { freqHz: 11_059_200 }]) {
    assert.notEqual(first.applicationId, prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, { ...options, ...change }).applicationId)
  }
  const changed = structuredClone(snapshot); changed.chip.freqHz++
  assert.notEqual(first.applicationId, prepareOptionsApplication(changed, { watchdog_prescale: 128 }, options).applicationId)
  writeFileSync(options.hex, ':01000000AB54\n:00000001FF\n')
  assert.equal(verifyOptionsApplication(first, first.applicationId).error, 'APPLICATION_CHANGED')
})

test('changed prepared intent or expected ID never executes and cannot be accepted', () => {
  const prepared = prepareOptionsApplication(snapshot, { watchdog_prescale: 128 }, fixture())
  assert.equal(verifyOptionsApplication(prepared, prepared.applicationId).ok, true)
  assert.equal(verifyOptionsApplication(prepared, '0'.repeat(64)).ok, false)
  for (const mutate of [p => { p.intent.afterMsrHex = '00 00 00 00 00' },
    p => { p.intent.image.sha256 = '0'.repeat(64) }, p => { p.intent.patch.watchdog_prescale = 64 },
    p => { p.sourceSnapshot.chip.hardwareOptions.values.clock_source = 'external' }]) {
    const copy = structuredClone(prepared); mutate(copy)
    const result = verifyOptionsApplication(copy, prepared.applicationId)
    assert.equal(result.ok, false)
    assert.equal(result.hardwareAccess, false)
  }
})

test('missing image, no-op, bad frequency, and external-clock transitions are refused', () => {
  const options = fixture()
  for (const [patch, values] of [[{}, options], [{ watchdog_prescale: 128 }, { ...options, hex: '' }],
    [{ watchdog_prescale: 128 }, { ...options, freqHz: '12000000' }],
    [{ clock_source: 'external' }, options]]) {
    assert.equal(prepareOptionsApplication(snapshot, patch, values).ok, false)
  }
})

test('mcu_options prepare writes a reviewable artifact without opening a port', async () => {
  const options = fixture()
  const source = join(options.dir, 'snapshot.json'); writeFileSync(source, JSON.stringify(snapshot))
  const tool = buildToolSpecs({ defineTool: value => value, config: resolveConfig({ dataDir: options.dir }) }).find(spec => spec.name === 'mcu_options')
  const result = await tool.execute({ action: 'prepare', snapshot: source, patch: { watchdog_prescale: 128 }, ...options })
  assert.equal(result.ok, true, result.summary)
  assert.equal(result.data.effects.codeEraseBytes, null)
  assert.equal(result.data.effects.nominalCodeBytes, 62464)
  assert.equal(result.data.hardwareAccess, false)
  assert.equal(JSON.parse(readFileSync(result.logPath, 'utf8')).applicationId, result.data.applicationId)
})
