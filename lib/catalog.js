// Offline directory facts only; deliberately independent of ISP capability checks.
import { readFileSync, statSync } from 'node:fs'
import { readStorage, STORAGE_ASSET } from './storage-catalog.js'

const ASSET = new URL('../data/chip-catalog.json', import.meta.url)
const fail = (error, message) => ({ ok: false, error, message, hardwareAccess: false, downloadSupportInferred: false })

function readCatalog(path) {
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('型号目录超过4MiB限制。')
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data.schemaVersion !== 1 || data.catalogId !== 'stcisp-6.75-models' ||
      data.source?.id !== 'official-stcisp-6.75-static' || !/^[0-9a-f]{64}$/.test(data.source.exeSha256) ||
      !Array.isArray(data.records) || data.records.length !== 719 ||
      !Array.isArray(data.unknownAttributes) || data.unknownAttributes.some(name => typeof name !== 'string') ||
      data.evidence !== 'official-static' || data.validation !== 'offline' || data.source.hardwareValidated !== false || data.downloadSupportInferred !== false) {
    throw new Error('型号目录格式或已确认的记录范围不正确。')
  }
  for (const [index, record] of data.records.entries()) {
    if (record.id !== 'stc675:' + index || typeof record.name !== 'string' || !record.name || record.name.length > 80 ||
        !/^[0-9A-F]{4}$/.test(record.primaryMagic) ||
        (record.alternateMagic !== null && !/^[0-9A-F]{4}$/.test(record.alternateMagic)) ||
        !['chip-name', 'device-label'].includes(record.labelKind) || record.sourceId !== data.source.id ||
        record.recordVA !== '0x' + (0x454230 + index * 32).toString(16)) {
      throw new Error('型号目录记录不完整：' + index)
    }
  }
  return data
}

/** Asset path arguments are internal seams for data-validation tests. */
export function queryCatalog(args = {}, path = ASSET, storagePath = STORAGE_ASSET) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('INVALID_CATALOG_ARGUMENT', '参数必须是对象。')
  const action = args.action ?? 'search'
  if (!['search', 'get', 'stats', 'memory'].includes(action)) return fail('UNKNOWN_CATALOG_ACTION', '仅支持search/get/stats/memory。')
  let data
  try { data = readCatalog(path) }
  catch (error) { return fail('CATALOG_DATA_INVALID', String(error.message)) }
  const common = { ok: true, schemaVersion: data.schemaVersion, catalogId: data.catalogId, source: data.source,
    evidence: data.evidence, validation: data.validation, hardwareAccess: false, downloadSupportInferred: false, unknownAttributes: data.unknownAttributes }
  if (action === 'stats') {
    const labelKinds = {}
    for (const record of data.records) labelKinds[record.labelKind] = (labelKinds[record.labelKind] ?? 0) + 1
    return { ...common, totalRecords: data.records.length, uniquePrimaryMagic: new Set(data.records.map(record => record.primaryMagic)).size,
      alternateMagicRecords: data.records.filter(record => record.alternateMagic !== null).length, labelKinds }
  }
  if (action === 'get' || action === 'memory') {
    if (typeof args.id !== 'string' || !/^stc675:(0|[1-9][0-9]*)$/.test(args.id)) return fail('INVALID_CATALOG_ID', '请提供search返回的stc675:数字记录ID。')
    if (action === 'memory' && Object.keys(args).some(key => !['action', 'id'].includes(key))) return fail('INVALID_CATALOG_ARGUMENT', 'memory只接受action和唯一记录id；请先search确定型号。')
    const record = data.records.find(item => item.id === args.id)
    if (record && action === 'memory') {
      let storage
      try { storage = readStorage(data, storagePath) }
      catch (error) { return fail('STORAGE_DATA_INVALID', String(error.message)) }
      const { tableFacts, layout } = storage.records.find(item => item.id === record.id)
      return { ...common, record: { ...record, memory: { tableFacts, layout } },
        storageSource: storage.source, manualSource: storage.manualSource, storageFieldOffsets: storage.fieldOffsets,
        storageCoverage: storage.coverage,
        unknownAttributes: [...common.unknownAttributes.filter(name => !['codeBytes', 'eepromBytes'].includes(name)),
          'ispEepromRead', 'ispStandaloneErase', 'preserveDataOnCodeErase', 'bslEffectiveLimits',
          ...(!layout ? ['iapDataRegion', 'movcDataRegion', 'iapEraseSectorBytes', 'dataOverlapsCode'] : [])],
        deviceCapabilities: { ispEepromRead: 'unknown', ispStandaloneErase: 'unknown', preserveDataOnCodeErase: 'unknown' },
        pluginOperations: { eepromDownload: record.id === 'stc675:8' ? 'constrained-shared-iap-reflash' : 'not-implemented',
          memoryApplication: record.id === 'stc675:8' ? { profileId: 'stc15-f449-725s-memory-v1', bslVersion: '7.2.5S',
            validation: 'offline', hardwareValidated: false, requiresPrepare: true, programmingEndExclusive: 61952 } : null,
          eepromErase: 'not-implemented', flashReadback: 'not-implemented' } }
    }
    return record ? { ...common, record } : fail('CATALOG_RECORD_NOT_FOUND', '目录中没有此记录：' + args.id)
  }
  const query = args.query ?? ''
  const limit = args.limit ?? 20
  const offset = args.offset ?? 0
  if (typeof query !== 'string' || query.length > 80 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || (args.labelKind !== undefined && !['chip-name', 'device-label'].includes(args.labelKind))) {
    return fail('INVALID_CATALOG_ARGUMENT', 'query最多80字符；limit整数1~100；offset非负整数；labelKind取chip-name/device-label。')
  }
  let magic = null
  if (args.magic !== undefined) {
    if (typeof args.magic !== 'string' || !/^(?:0x)?[0-9a-f]{4}$/i.test(args.magic)) return fail('INVALID_CATALOG_MAGIC', 'magic必须是四位十六进制字符串，例如F449或0xF449。')
    magic = args.magic.replace(/^0x/i, '').toUpperCase()
  }
  const text = query.trim().toUpperCase()
  const matches = data.records.filter(record => record.name.toUpperCase().includes(text) &&
    (!magic || record.primaryMagic === magic || record.alternateMagic === magic) &&
    (!args.labelKind || record.labelKind === args.labelKind))
  const records = matches.slice(offset, offset + limit)
  return { ...common, query, magic, totalMatches: matches.length, offset, limit, records,
    nextOffset: offset + records.length < matches.length ? offset + records.length : null }
}
