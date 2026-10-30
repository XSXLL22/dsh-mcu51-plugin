import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeImage } from '../lib/image.js'
import { prepareMemoryPlan } from '../lib/memory-plan.js'
import { prepareImageFlash } from '../lib/image-flash.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const TEMP = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp')
mkdirSync(TEMP, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
function setup(t, code = Buffer.from([1, 2, 3]), eeprom = null, extra = {}) {
  const root = mkdtempSync(join(TEMP, 'memory plan 中文 '))
  t.after(() => {
    const child = relative(TEMP, root)
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    rmSync(root, { recursive: true, force: true })
  })
  const sources = []
  for (const [buffer, data] of [['code', code], ['eeprom', eeprom]]) {
    if (data === null) continue
    const path = join(root, buffer + '.bin')
    writeFileSync(path, data)
    sources.push({ path, buffer })
  }
  const image = composeImage({ sources, ...extra })
  assert.equal(image.ok, true, image.message)
  const options = { targetId: 'stc675:8', bslVersion: '7.2.5S', erasePolicy: 'code' }
  return { root, image, options }
}

test('code preview carries a selector without inventing an exact physical erase length', t => {
  const { image, options } = setup(t)
  const plan = prepareMemoryPlan(image, image.imageId, options)
  assert.equal(plan.ok, true, plan.message)
  assert.equal(plan.kind, 'mcu51-memory-preview')
  assert.equal(plan.wire.erasePayloadHex, '03 00 00 5a a5')
  assert.equal(plan.effects.codeEraseBytes, null)
  assert.equal(plan.effects.nominalCodeBytes, 62464)
  assert.equal(plan.effects.dataPreservation, 'not-guaranteed')
  assert.equal(plan.programImage.bytes, 512)
  assert.equal(plan.hardwareAccess, false)
  assert.equal(plan.executable, false)
  assert.equal(plan.implementationAvailable, false)
  assert.equal(plan.target.declaration, 'caller-supplied; not a connected-chip identification')
})

test('shared IAP data needs explicit aligned placement and the payload binds exact combined bytes', t => {
  const { image, options } = setup(t, Buffer.from([1, 2, 3]), Buffer.from([0xaa, 0x55]))
  assert.equal(prepareMemoryPlan(image, image.imageId, options).error, 'MEMORY_SHARED_OFFSET_REQUIRED')
  const plan = prepareMemoryPlan(image, image.imageId, { ...options, eepromOffset: 512 })
  assert.equal(plan.ok, true, plan.message)
  const expected = Buffer.alloc(1024, 255)
  expected.set([1, 2, 3]); expected.set([0xaa, 0x55], 512)
  assert.equal(plan.programImage.sha256, sha(expected))
  assert.equal(plan.placement.eeprom.linearAddress, 512)
  assert.equal(plan.placement.eeprom.iapAddress, 512)
  assert.equal(plan.placement.eeprom.officialFileAddress, null)
  assert.equal(plan.wire.erasePayloadHex, '03 00 00 5a a5')
  assert.equal(plan.effects.interBufferFillBytes, 509)
  assert.equal(plan.wire.requestedDataErasePrefixBytes, 0)
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, eepromOffset: 256 }).error, 'MEMORY_SHARED_OFFSET_ALIGNMENT')
})

test('dedicated data uses IAP-relative placement and official sector counts instead of the upstream boolean', t => {
  const { image, options } = setup(t, Buffer.from([1, 2, 3]), Buffer.alloc(513, 0xaa))
  const plan = prepareMemoryPlan(image, image.imageId, { ...options, targetId: 'stc675:0', erasePolicy: 'code-and-data' })
  assert.equal(plan.ok, true, plan.message)
  assert.equal(plan.placement.eeprom.iapAddress, 0)
  assert.equal(plan.placement.eeprom.linearAddress, 8192)
  assert.equal(plan.placement.eeprom.officialFileAddress, 0)
  assert.equal(plan.wire.erasePayloadHex, '03 02 00 5a a5')
  assert.equal(plan.wire.requestedDataErasePrefixBytes, 1024)
  assert.equal(plan.wire.bundledEngineErasePayloadHex, '03 01 00 5a a5')
  assert.equal(plan.wire.bundledEngineEraseMatches, false)
  const expected = Buffer.alloc(9216, 255)
  expected.set([1, 2, 3]); expected.fill(0xaa, 8192, 8705)
  assert.equal(plan.programImage.sha256, sha(expected))
  assert.equal(plan.effects.interBufferFillBytes, 8189)
  assert.equal(plan.wire.lastBlock.offset, 9088)
})

test('bounds, physical overlap and incompatible erase policies fail without truncation', t => {
  const { image, options } = setup(t, Buffer.alloc(600, 1), Buffer.from([0xaa]))
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, eepromOffset: 512 }).error, 'MEMORY_REGION_OVERLAP')
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, eepromOffset: 62464 }).error, 'MEMORY_DATA_OVERFLOW')
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, eepromOffset: 1024, erasePolicy: 'code-and-data' }).error, 'MEMORY_ERASE_POLICY')
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, targetId: 'stc675:0' }).error, 'MEMORY_ERASE_POLICY')
  const last = prepareMemoryPlan(image, image.imageId, { ...options, targetId: 'stc675:0', erasePolicy: 'code-and-data', eepromOffset: 54271 })
  assert.equal(last.ok, true, last.message)
  assert.equal(last.programImage.bytes, 62464)
  assert.equal(last.wire.dataEraseSectors, 106)
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, targetId: 'stc675:0', erasePolicy: 'code-and-data', eepromOffset: 54272 }).error, 'MEMORY_DATA_OVERFLOW')
})

test('unsupported layouts, BSL families, ambiguous selectors and coerced arguments cannot produce a plan', t => {
  const { image, options } = setup(t)
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, targetId: 'stc675:703' }).error, 'MEMORY_LAYOUT_UNKNOWN')
  for (const change of [{ bslVersion: '7.1' }, { bslVersion: '7.3' }, { bslVersion: 7.2 },
    { targetId: 'F449' }, { eepromOffset: '512' }, { eepromOffset: true }, { eepromOffset: -1 },
    { erasePolicy: 'all' }, { port: 'COM9' }, { freqHz: 12000000 }]) {
    const result = prepareMemoryPlan(image, image.imageId, { ...options, ...change })
    assert.equal(result.ok, false, JSON.stringify(change))
    assert.equal(result.hardwareAccess, false)
  }
  assert.equal(prepareMemoryPlan(image, '0'.repeat(64), options).error, 'IMAGE_ID_MISMATCH')
  const broken = structuredClone(image); broken.buffers.code.segments[0].dataHex = 'ff'
  assert.equal(prepareMemoryPlan(broken, image.imageId, options).ok, false)
})

test('plan identity binds placement, padding, source fill and declared BSL without hardware claims', t => {
  const { image, options } = setup(t, Buffer.from([1, 2, 3]), Buffer.from([0xaa]))
  const args = { ...options, eepromOffset: 512 }
  const first = prepareMemoryPlan(image, image.imageId, args)
  assert.equal(first.ok, true)
  assert.equal(first.memoryPlanId, prepareMemoryPlan(structuredClone(image), image.imageId, args).memoryPlanId)
  for (const change of [{ eepromOffset: 1024 }, { bslVersion: '7.2' }]) {
    assert.notEqual(first.memoryPlanId, prepareMemoryPlan(image, image.imageId, { ...args, ...change }).memoryPlanId)
  }
  const source = setup(t, Buffer.from([1]))
  const holes = composeImage({ sources: [{ path: join(source.root, 'code.bin'), offset: 2 }], fillByte: 0 })
  const plan = prepareMemoryPlan(holes, holes.imageId, options)
  const expected = Buffer.alloc(512, 255); expected.set([0, 0, 1])
  assert.equal(plan.programImage.sha256, sha(expected))
  assert.equal(plan.programImage.paddingByte, 255)
})

test('EEPROM-only and empty requests cannot claim a code-preserving writer exists', t => {
  const { image, options } = setup(t, null, Buffer.from([0xaa]))
  assert.equal(prepareMemoryPlan(image, image.imageId, { ...options, eepromOffset: 512 }).error, 'MEMORY_CODE_REQUIRED')
  const empty = composeImage({ sources: [] })
  assert.equal(prepareMemoryPlan(empty, empty.imageId, options).error, 'MEMORY_CODE_REQUIRED')
})

test('bad protocol facts are visible and never replaced by heuristic rules', t => {
  const { image, options, root } = setup(t)
  const path = join(root, 'bad-profile.json')
  writeFileSync(path, '{}')
  assert.equal(prepareMemoryPlan(image, image.imageId, options, path).error, 'MEMORY_PROTOCOL_INVALID')
})

test('mcu_image plan logs the reviewable preview while the hardware flash path still rejects EEPROM', async t => {
  const { image, options, root } = setup(t, Buffer.from([1, 2, 3]), Buffer.from([0xaa]))
  const path = join(root, 'image.json'); writeFileSync(path, JSON.stringify(image))
  const config = resolveConfig({ dataDir: join(root, 'user data') })
  const tool = buildToolSpecs({ defineTool: x => x, config, ispRunner: () => assert.fail('hardware executor called') }).find(x => x.name === 'mcu_image')
  assert.ok(tool.parameters.action.enum.includes('plan'))
  const result = await tool.execute({ action: 'plan', image: path, expectedImageId: image.imageId, ...options, eepromOffset: 512 })
  assert.equal(result.ok, true, result.summary)
  assert.equal(result.data.executable, false)
  assert.match(result.summary, /未执行/)
  assert.equal(JSON.parse(readFileSync(result.logPath, 'utf8')).memoryPlanId, result.data.memoryPlanId)
  assert.equal(prepareImageFlash({ image: path, expectedImageId: image.imageId }, config.dataDir).error, 'IMAGE_EEPROM_NOT_SUPPORTED')
  const bad = await tool.execute({ action: 'plan', image: path, expectedImageId: image.imageId, ...options, eepromOffset: 512, sources: [] })
  assert.equal(bad.ok, false)
  const mixed = await tool.execute({ action: 'compose', sources: [], targetId: options.targetId })
  assert.equal(mixed.data.error, 'MEMORY_ARGUMENT')
})
