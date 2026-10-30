import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { queryCatalog } from '../lib/catalog.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

test('official catalog exposes facts and unknown capabilities separately', () => {
  const stats = queryCatalog({ action: 'stats' })
  assert.equal(stats.ok, true)
  assert.equal(stats.totalRecords, 719)
  assert.equal(stats.uniquePrimaryMagic, 717)
  assert.equal(stats.alternateMagicRecords, 28)
  assert.deepEqual(stats.labelKinds, { 'chip-name': 715, 'device-label': 4 })
  assert.equal(stats.source.exeSha256, '22ada01b21c9f990adbea80938adbb8d1654b4bde03008569d94e3a5a2447257')
  assert.equal(stats.downloadSupportInferred, false)
  assert.equal(stats.evidence, 'official-static')
  assert.equal(stats.validation, 'offline')
  assert.ok(stats.unknownAttributes.includes('codeBytes'))
  assert.equal(stats.hardwareAccess, false)
})

test('stable record ID resolves F449 without inventing memory or BSL', () => {
  const result = queryCatalog({ action: 'get', id: 'stc675:8' })
  assert.equal(result.ok, true)
  assert.equal(result.record.name, 'IAP15F2K61S2')
  assert.equal(result.record.primaryMagic, 'F449')
  assert.equal(result.record.recordVA, '0x454330')
  assert.equal(Object.hasOwn(result.record, 'codeBytes'), false)
  assert.equal(Object.hasOwn(result.record, 'bslRange'), false)
  result.record.name = 'tampered'
  assert.equal(queryCatalog({ action: 'get', id: 'stc675:8' }).record.name, 'IAP15F2K61S2')
})

test('name search is case-insensitive and magic preserves ambiguous matches', () => {
  const named = queryCatalog({ query: 'iap15f2k61s2' })
  assert.equal(named.totalMatches, 1)
  assert.equal(named.records[0].id, 'stc675:8')
  const ambiguous = queryCatalog({ magic: '0xf294' })
  assert.deepEqual(ambiguous.records.map(record => record.name), ['STC15F104W', 'STC15F104E'])
  assert.equal(ambiguous.totalMatches, 2)
  const alternate = queryCatalog({ magic: 'F311' })
  assert.ok(alternate.records.some(record => record.id === 'stc675:584' && record.primaryMagic === 'E061' && record.alternateMagic === 'F311'))
  assert.equal(queryCatalog({ query: 'a board that does not exist' }).totalMatches, 0)
})

test('pagination is bounded, deterministic, and validates strict argument types', () => {
  const first = queryCatalog({ limit: 2 })
  assert.deepEqual(first.records.map(record => record.id), ['stc675:0', 'stc675:1'])
  assert.equal(first.nextOffset, 2)
  const second = queryCatalog({ offset: first.nextOffset, limit: 2 })
  assert.equal(second.records[0].id, 'stc675:2')
  for (const args of [{ magic: '9' }, { magic: 0xf449 }, { limit: 0 }, { limit: 101 }, { limit: '2' },
    { offset: -1 }, { offset: 1.5 }, { query: [] }, { action: 'get' }, { action: 'apply' }]) {
    const result = queryCatalog(args)
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.equal(result.hardwareAccess, false)
  }
  assert.equal(queryCatalog({ action: 'get', id: 'stc675:719' }).error, 'CATALOG_RECORD_NOT_FOUND')
})

test('bad catalog assets return visible errors rather than an empty directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcu-catalog-'))
  const path = join(root, 'bad.json')
  assert.equal(queryCatalog({}, path).error, 'CATALOG_DATA_INVALID')
  writeFileSync(path, '{}')
  assert.equal(queryCatalog({}, path).error, 'CATALOG_DATA_INVALID')
  writeFileSync(path, '{bad json')
  assert.equal(queryCatalog({}, path).error, 'CATALOG_DATA_INVALID')
})

test('mcu_catalog registers as an offline tool and saves its result', async () => {
  const config = resolveConfig({ dataDir: mkdtempSync(join(tmpdir(), 'mcu-catalog-tool-')) })
  const tool = buildToolSpecs({ defineTool: value => value, config }).find(item => item.name === 'mcu_catalog')
  assert.ok(tool)
  const result = await tool.execute({ action: 'search', magic: 'F449' })
  assert.equal(result.ok, true, result.summary)
  assert.equal(result.data.records[0].name, 'IAP15F2K61S2')
  assert.ok(result.logPath)
  assert.equal(result.data.hardwareAccess, false)
})
