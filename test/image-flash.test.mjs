import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { composeImage } from '../lib/image.js'
import { prepareImageFlash } from '../lib/image-flash.js'
import { makeIspPlan, runIsp } from '../lib/isp.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

const tempRoot = join(PACKAGE_ROOT, 'test/.tmp')
mkdirSync(tempRoot, { recursive: true })
const dir = mkdtempSync(join(tempRoot, 'image flash 中文 '))
after(() => { const target = resolve(dir); assert.ok(target.startsWith(resolve(tempRoot) + sep)); rmSync(target, { recursive: true, force: true }) })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(eeprom = false) {
  const config = resolveConfig({ dataDir: mkdtempSync(join(dir, 'data ')) })
  const bin = join(config.dataDir, 'source.bin'); writeFileSync(bin, Buffer.from([0xaa]))
  const image = composeImage({ sources: [{ path: bin, offset: 2 }, ...(eeprom ? [{ path: bin, buffer: 'eeprom' }] : [])] })
  const path = join(config.dataDir, 'image.json'); writeFileSync(path, JSON.stringify(image))
  return { config, bin, image, args: { image: path, expectedImageId: image.imageId, port: 'COM9', mcu: 'IAP15F2K61S2', freqHz: 12_000_000 } }
}

test('flash dry-run binds frozen bytes, generated HEX file hash and imageId without reading live source', async () => {
  const { config, bin, image, args } = fixture()
  writeFileSync(bin, Buffer.from([0xbb]))
  let called = false
  const tool = buildToolSpecs({ defineTool: x => x, config, ispRunner: () => { called = true; assert.fail('dry-run opened ISP') } }).find(x => x.name === 'mcu_flash')
  const result = await tool.execute({ ...args, dryRun: true })
  assert.equal(result.ok, true, result.summary)
  assert.equal(called, false)
  assert.equal(result.data.plan.imageBinding.imageId, image.imageId)
  assert.equal(result.data.plan.imageBinding.denseSha256, sha(Buffer.from([255, 255, 0xaa])))
  assert.equal(result.data.plan.imageBinding.denseBytes, 3)
  assert.equal(result.data.plan.expectedSha256, sha(readFileSync(result.data.plan.hex)))
  assert.equal(result.data.plan.imageBinding.hexSha256, result.data.preflight.sha256)
})

test('image input rejects wrong/missing IDs, mixed sources and EEPROM before invoking any ISP runner', async () => {
  const { config, args } = fixture()
  const tool = buildToolSpecs({ defineTool: x => x, config, ispRunner: () => assert.fail('invalid request reached ISP') }).find(x => x.name === 'mcu_flash')
  for (const bad of [{ ...args, expectedImageId: undefined }, { ...args, expectedImageId: '0'.repeat(64) },
    { ...args, hex: '' }, { ...args, project: 'ignored' }, { expectedImageId: args.expectedImageId, port: 'COM9' }]) {
    assert.equal((await tool.execute(bad)).ok, false)
  }
  const eeprom = fixture(true)
  assert.equal(prepareImageFlash(eeprom.args, eeprom.config.dataDir).error, 'IMAGE_EEPROM_NOT_SUPPORTED')
  const overflow = composeImage({ sources: [{ path: eeprom.bin, offset: 65535 }] })
  const path = join(config.dataDir, 'overflow.json'); writeFileSync(path, JSON.stringify(overflow))
  const result = await tool.execute({ ...args, image: path, expectedImageId: overflow.imageId, dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.data.preflight.error, 'INVALID_HEX')
})

test('03 entry metadata stays offline: flash preparation rejects it before file export', () => {
  const { config, args } = fixture()
  const hex = join(config.dataDir, 'entry.hex')
  writeFileSync(hex, ':01000000AA55\n:0400000300000000F9\n:00000001FF\n')
  const image = composeImage({ sources: [{ path: hex }] })
  assert.equal(image.ok, true)
  writeFileSync(args.image, JSON.stringify(image))
  assert.equal(prepareImageFlash({ ...args, expectedImageId: image.imageId }, config.dataDir).error, 'IMAGE_ENTRY_ISP_UNSUPPORTED')
})

test('ISP request carries image binding; mismatched success receipts preserve confirmed writes while failing identity check', async () => {
  const { config, args } = fixture()
  const source = prepareImageFlash(args, config.dataDir)
  assert.equal(source.ok, true, source.message)
  const options = { action: 'flash', ...args, hex: source.path, expectedSha256: source.imageBinding.hexSha256, imageBinding: source.imageBinding }
  assert.deepEqual(makeIspPlan(options).imageBinding, source.imageBinding)
  for (const receipt of [source.imageBinding, { ...source.imageBinding, imageId: '0'.repeat(64) }, null]) {
    const result = await runIsp(options, async (_name, request) => {
      assert.deepEqual(request.imageBinding, source.imageBinding)
      return { code: 0, stdout: JSON.stringify({ event: 'result', ok: true, stage: 'complete', programmed: true, programAcknowledged: true,
        imageBinding: receipt, boundImageVerified: Boolean(receipt) }), stderr: '' }
    })
    assert.equal(result.programmed, true)
    assert.equal(result.ok, receipt === source.imageBinding)
    if (!result.ok) assert.equal(result.error, 'IMAGE_RECEIPT_MISMATCH')
  }
})

test('flash execution hands binding to runner and retains receipt if log persistence fails', async () => {
  const { config, args, image } = fixture()
  writeFileSync(join(config.dataDir, 'logs'), 'block log directory')
  const tool = buildToolSpecs({ defineTool: x => x, config, ispRunner: async options => {
    assert.equal(options.imageBinding.imageId, image.imageId)
    return { ok: true, stage: 'complete', programmed: true, programAcknowledged: true, imageBinding: options.imageBinding, boundImageVerified: true }
  } }).find(x => x.name === 'mcu_flash')
  const result = await tool.execute(args)
  assert.equal(result.ok, false)
  assert.equal(result.data.result.programmed, true)
  assert.equal(result.data.result.boundImageVerified, true)
  assert.ok(result.data.logError)
})
