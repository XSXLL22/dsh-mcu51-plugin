// Offline source facts. This module never authorizes a physical memory operation.
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const STORAGE_ASSET = new URL('../data/storage-catalog.json', import.meta.url)
const EXE_SHA = '22ada01b21c9f990adbea80938adbb8d1654b4bde03008569d94e3a5a2447257'
const MANUAL_ID = 'stc15-datasheet-2015-10-10-p633'
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const requireValue = (ok, message) => { if (!ok) throw new Error(message) }
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 65536
const same = (a, b) => canonical(a) === canonical(b)

function manualGeometry(record) {
  const match = /^(STC15[FL])2K(08|16|24|32|40|48|56|60)S2$/.exec(record.name)
  const shared = ['IAP15F2K61S2', 'IAP15L2K61S2'].includes(record.name)
  if (!match && !shared) return null
  const code = shared ? 62464 : Number(match[2]) * 1024
  const eeprom = shared ? 0 : 62464 - code
  const length = shared ? code : eeprom
  return { code, eeprom, shared, length }
}

export function readStorage(catalog, path = STORAGE_ASSET) {
  requireValue(statSync(path).size <= 1024 * 1024, '存储目录超过1MiB限制。')
  const data = JSON.parse(readFileSync(path, 'utf8'))
  requireValue(data.schemaVersion === 1 && data.storageId === 'stcisp-6.75-storage-facts' &&
    data.source?.id === catalog.source.id && data.source?.exeSha256 === EXE_SHA && data.source.exeSha256 === catalog.source.exeSha256 && data.source.hardwareValidated === false &&
    /^[0-9a-f]{64}$/.test(data.source.evidenceCanonicalSha256) &&
    data.manualSource?.id === MANUAL_ID && data.manualSource.pdfPage === 633 && data.manualSource.documentDate === '2015-10-10' &&
    data.manualSource.url === 'https://www.stcmicro.com/datasheet/STC15F2K60S2-en.pdf#page=633' &&
    data.manualSource.evidence === 'official-datasheet' && data.manualSource.validation === 'offline' &&
    data.evidence === 'official-static' && data.validation === 'offline' && data.hardwareAccess === false && data.downloadSupportInferred === false &&
    same(data.fieldOffsets, { codeBytes: 12, eepromBytes: 16, eepromFileBase: 20 }) &&
    Array.isArray(data.records) && data.records.length === 719, '存储目录的来源、格式或记录范围不正确。')
  requireValue(createHash('sha256').update(canonical(data.records)).digest('hex') === data.recordsCanonicalSha256, '存储记录摘要不一致。')
  let layouts = 0
  for (const [index, record] of data.records.entries()) {
    const expected = catalog.records[index]
    const facts = record.tableFacts
    requireValue(record.id === expected.id && record.name === expected.name && record.recordVA === expected.recordVA &&
      facts && same(Object.keys(facts).sort(), ['codeBytes', 'eepromBytes', 'eepromFileBase']) &&
      integer(facts.codeBytes) && facts.codeBytes > 0 && integer(facts.eepromBytes) && integer(facts.eepromFileBase) &&
      facts.eepromFileBase + facts.eepromBytes <= 65536, '存储表项无效：' + index)
    const geometry = manualGeometry(record)
    if (!geometry) {
      requireValue(record.layout === null, '未核验型号不能附加物理布局：' + index)
      continue
    }
    const { code, eeprom, shared, length } = geometry
    const layout = record.layout
    requireValue(facts.codeBytes === code && facts.eepromBytes === eeprom && facts.eepromFileBase === 0 &&
      layout?.sourceId === MANUAL_ID && layout.kind === (shared ? 'shared-code-iap' : 'separate-data-window') &&
      same(layout.codeRegion, { start: 0, length: code }) && same(layout.iapDataRegion, { start: 0, length }) &&
      same(layout.movcDataRegion, { start: shared ? 0 : code, length }) && layout.iapEraseSectorBytes === 512 &&
      layout.dataOverlapsCode === shared && layout.validation === 'offline' && layout.hardwareValidated === false &&
      layout.appliesTo === 'datasheet-baseline; connected BSL limits and ISP effects are not inferred',
    '手册布局与核验范围不一致：' + index)
    layouts++
  }
  requireValue(layouts === 18, '手册布局覆盖范围不完整。')
  return { ...data, coverage: { tableRecords: data.records.length, datasheetLayouts: layouts, unknownLayouts: data.records.length - layouts } }
}
