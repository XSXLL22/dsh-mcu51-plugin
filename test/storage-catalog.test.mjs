import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { queryCatalog } from '../lib/catalog.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const CATALOG = new URL('../data/chip-catalog.json', import.meta.url)
const STORAGE = new URL('../data/storage-catalog.json', import.meta.url)
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const TEMP = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp')
mkdirSync(TEMP, { recursive: true })
function temporary(t) {
  const root = mkdtempSync(join(TEMP, 'storage 中文 '))
  t.after(() => {
    const child = relative(TEMP, root)
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('F449 storage distinguishes a zero dedicated EEPROM column from shared code IAP', () => {
  const result = queryCatalog({ action: 'memory', id: 'stc675:8' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.record.name, 'IAP15F2K61S2')
  assert.deepEqual(result.record.memory.tableFacts, { codeBytes: 62464, eepromBytes: 0, eepromFileBase: 0 })
  assert.equal(result.record.memory.layout.kind, 'shared-code-iap')
  assert.equal(result.record.memory.layout.dataOverlapsCode, true)
  assert.equal(result.record.memory.layout.iapEraseSectorBytes, 512)
  assert.deepEqual(result.record.memory.layout.iapDataRegion, { start: 0, length: 62464 })
  assert.equal(result.record.memory.layout.hardwareValidated, false)
  assert.equal(result.storageSource.exeSha256, '22ada01b21c9f990adbea80938adbb8d1654b4bde03008569d94e3a5a2447257')
  assert.equal(result.hardwareAccess, false)
  assert.equal(result.downloadSupportInferred, false)
  assert.equal(result.deviceCapabilities.ispEepromRead, 'unknown')
  assert.equal(result.pluginOperations.eepromDownload, 'constrained-shared-iap-reflash')
  assert.equal(result.pluginOperations.memoryApplication.bslVersion, '7.2.5S')
  assert.equal(result.pluginOperations.memoryApplication.hardwareValidated, false)
  assert.equal(queryCatalog({ action: 'memory', id: 'stc675:0' }).pluginOperations.eepromDownload, 'not-implemented')
  assert.ok(result.unknownAttributes.includes('preserveDataOnCodeErase'))
  assert.ok(!result.unknownAttributes.includes('codeBytes'))
})

test('IAP, MOVC and programmer file addresses remain distinct and unknown models stay unknown', () => {
  const data = queryCatalog({ action: 'memory', id: 'stc675:0' })
  assert.equal(data.ok, true)
  assert.deepEqual(data.record.memory.tableFacts, { codeBytes: 8192, eepromBytes: 54272, eepromFileBase: 0 })
  assert.deepEqual(data.record.memory.layout.iapDataRegion, { start: 0, length: 54272 })
  assert.deepEqual(data.record.memory.layout.movcDataRegion, { start: 8192, length: 54272 })
  assert.equal(data.record.memory.layout.dataOverlapsCode, false)
  const old = queryCatalog({ action: 'memory', id: 'stc675:703' })
  assert.equal(old.record.name, 'STC89C52RC/LE52RC')
  assert.deepEqual(old.record.memory.tableFacts, { codeBytes: 8192, eepromBytes: 6144, eepromFileBase: 8192 })
  assert.equal(old.record.memory.layout, null)
  assert.ok(old.unknownAttributes.includes('iapEraseSectorBytes'))
  assert.deepEqual(data.storageCoverage, { tableRecords: 719, datasheetLayouts: 18, unknownLayouts: 701 })
})

test('memory requires one exact record ID and cannot consume ambiguous magic as a layout selector', () => {
  for (const args of [{ action: 'memory' }, { action: 'memory', magic: 'F294' },
    { action: 'memory', id: 8 }, { action: 'memory', id: 'stc675:08' },
    { action: 'memory', id: 'stc675:8', magic: 'F4C9' }, { action: 'memory', id: 'stc675:8', query: 'other' }]) {
    const result = queryCatalog(args)
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.equal(result.hardwareAccess, false)
  }
  assert.equal(queryCatalog({ action: 'memory', id: 'stc675:719' }).error, 'CATALOG_RECORD_NOT_FOUND')
  assert.equal(queryCatalog({ magic: 'F294' }).totalMatches, 2)
})

test('storage data is validated as a whole and corruption never falls back to guessed layout', t => {
  const root = temporary(t)
  const path = join(root, 'storage.json')
  assert.equal(queryCatalog({ action: 'memory', id: 'stc675:8' }, CATALOG, path).error, 'STORAGE_DATA_INVALID')
  for (const mutate of [data => data.records.pop(), data => { data.records[0].tableFacts.codeBytes = -1 },
    data => { data.records[8].name = 'another chip' }, data => { data.source.exeSha256 = '0'.repeat(64) },
    data => { data.records[8].layout.dataOverlapsCode = false }, data => { data.records[0].tableFacts.eepromFileBase = 8192 },
    data => { data.records[100].layout = structuredClone(data.records[8].layout) }]) {
    const data = JSON.parse(readFileSync(STORAGE, 'utf8'))
    mutate(data)
    writeFileSync(path, JSON.stringify(data))
    assert.equal(queryCatalog({ action: 'memory', id: 'stc675:8' }, CATALOG, path).error, 'STORAGE_DATA_INVALID')
    // Recomputed internal checksum is insufficient to legitimize wrong geometry/source/coverage.
    data.recordsCanonicalSha256 = createHash('sha256').update(canonical(data.records)).digest('hex')
    writeFileSync(path, JSON.stringify(data))
    assert.equal(queryCatalog({ action: 'memory', id: 'stc675:8' }, CATALOG, path).error, 'STORAGE_DATA_INVALID')
  }
  // Legacy name search remains usable even if only the optional storage asset is missing.
  assert.equal(queryCatalog({ magic: 'F449' }, CATALOG, path).ok, true)
  const mismatchedCatalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
  mismatchedCatalog.source.exeSha256 = '0'.repeat(64)
  const catalogPath = join(root, 'other-source.json')
  writeFileSync(catalogPath, JSON.stringify(mismatchedCatalog))
  assert.equal(queryCatalog({ action: 'memory', id: 'stc675:8' }, catalogPath, STORAGE).error, 'STORAGE_DATA_INVALID')
})

test('storage results are fresh and retain offline evidence rather than acquiring hardware validation', () => {
  const first = queryCatalog({ action: 'memory', id: 'stc675:18' })
  assert.equal(first.ok, true)
  first.record.memory.layout.iapDataRegion.length = 1
  const next = queryCatalog({ action: 'memory', id: 'stc675:18' })
  assert.equal(next.record.memory.layout.iapDataRegion.length, 62464)
  assert.equal(next.validation, 'offline')
  assert.equal(next.manualSource.pdfPage, 633)
  assert.equal(next.deviceCapabilities.preserveDataOnCodeErase, 'unknown')
})

test('mcu_catalog memory action is exposed, logged and explains shared storage', async t => {
  const config = resolveConfig({ dataDir: temporary(t) })
  const tool = buildToolSpecs({ defineTool: value => value, config }).find(item => item.name === 'mcu_catalog')
  assert.ok(tool.parameters.action.enum.includes('memory'))
  const result = await tool.execute({ action: 'memory', id: 'stc675:8' })
  assert.equal(result.ok, true, result.summary)
  assert.match(result.summary, /62464/)
  assert.match(result.summary, /共享/)
  assert.equal(JSON.parse(readFileSync(result.logPath, 'utf8')).record.memory.layout.dataOverlapsCode, true)
})
