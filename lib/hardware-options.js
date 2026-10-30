// Offline codecs and plans only. This module never imports a transport.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// A damaged optional metadata file must not prevent other tools registering.
function readOfficialData() {
  try {
    const data = JSON.parse(readFileSync(new URL('../data/official-stc15.json', import.meta.url), 'utf8'))
    const model = data.models?.find(model => model.model === 'IAP15F2K61S2' && model.magic === 'F449')
    const values = model?.lowVoltage?.nominalVoltsByEncoding
    if (data.schemaVersion !== 1 || data.source?.id !== 'official-stcisp-6.75-static' ||
        !Array.isArray(values) || values.length !== 8 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('官方选项数据格式不完整。')
    }
    return { data, voltage: model.lowVoltage }
  } catch (error) { return { error: String(error.message) } }
}
const ASSET = readOfficialData()
const OFFICIAL = ASSET.data
const VOLTAGE = ASSET.voltage
const PROFILE = { id: 'stc15-f449-725s-v2', model: 'IAP15F2K61S2', magic: 'F449', bslVersion: '7.2.5S', msrBytes: 5 }
const SOURCES = [
  { kind: 'codec', decoder: 'stcgal-1.10/Stc15Option', license: 'MIT', url: 'https://github.com/grigorig/stcgal/blob/master/stcgal/options.py', pinnedBy: 'runtime/win32-x64/manifest.json' },
  { kind: 'pin-semantics', url: 'https://www.stcmicro.com/datasheet/STC15F2K60S2-en.pdf#page=301', page: 301 },
  ...(OFFICIAL ? [OFFICIAL.source] : []),
]

// Encoded values are already shifted into their mask. Preserve all other bits.
const field = (name, byteIndex, mask, values, encoded, effect, metadata = {}) =>
  ({ name, byteIndex, mask, values, encoded, effect, planSupported: true, ...metadata })
const FIELDS = [
  field('reset_pin_enabled', 2, 0x10, [false, true], [0x10, 0], '复位脚与普通I/O复用；会改变复位方式。', { risk: 'high', physicalPin: 'P5.4/RST' }),
  field('clock_source', 2, 0x01, ['internal', 'external'], [1, 0], '下次冷启动的时钟源；外部时钟必须实际存在。', { risk: 'high' }),
  field('clock_gain', 2, 0x02, ['low', 'high'], [0, 2], '振荡器增益。'),
  field('watchdog_por_enabled', 0, 0x20, [false, true], [0x20, 0], '上电自动启动看门狗，固件需要及时喂狗。', { risk: 'high' }),
  field('watchdog_stop_idle', 0, 0x08, [false, true], [8, 0], '空闲时看门狗是否停止计数。'),
  field('watchdog_prescale', 0, 0x07, [2, 4, 8, 16, 32, 64, 128, 256], [0, 1, 2, 3, 4, 5, 6, 7], '看门狗预分频；改变溢出时间。'),
  field('low_voltage_reset', 1, 0x40, [false, true], [0x40, 0], '低压时复位或中断的选择。', { risk: 'high' }),
  field('low_voltage_threshold', 1, 0x07, [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7], '低压门限编码，对应电压采用官方当前型号表的标称显示值。', { unit: 'encoding', voltageMapping: 'official-static', nominalVoltsByEncoding: VOLTAGE?.nominalVoltsByEncoding, voltageKind: 'nominal-official-display', semanticSource: 'official-stcisp-6.75-static', risk: 'high' }),
  field('eeprom_lvd_inhibit', 1, 0x80, [false, true], [0, 0x80], '低压时禁止EEPROM操作。'),
  field('eeprom_erase_enabled', 3, 0x02, [false, true], [0, 2], '后续下载是否擦除用户EEPROM；不是本次立即擦除。', { risk: 'high' }),
  field('bsl_pindetect_enabled', 3, 0x01, [false, true], [1, 0], '下次下载是否要求P3.2/P3.3满足电平条件。', { risk: 'high' }),
  field('por_reset_delay', 2, 0x80, ['short', 'long'], [0, 0x80], '上电复位额外延时。'),
  field('rstout_por_state', 2, 0x08, ['low', 'high'], [0, 8], '上电复位后复位输出脚的电平；会影响板上外设。', { physicalPin: 'P2.0/RSTOUT_LOW', risk: 'high' }),
  field('uart2_passthrough', 2, 0x40, [false, true], [0, 0x40], 'TXD直通输出RXD电平；false为独立IO。字段名沿用上游uart2_*，实际描述TXD/RXD。', { physicalSignal: 'TXD', legacyName: true, semanticSource: 'official-stcisp-6.75-static', risk: 'high' }),
  field('uart2_pin_mode', 2, 0x20, ['normal', 'push-pull'], [0, 0x20], 'TXD复位后模式：normal=弱上拉双向口，push-pull=强推挽。字段名沿用上游。', { physicalSignal: 'TXD', legacyName: true, semanticSource: 'official-stcisp-6.75-static', risk: 'high' }),
  field('cpu_core_voltage', 4, 0xff, ['low', 'mid', 'high'], [0xea, 0xf7, 0xfd], '上游内核电压字段，当前型号适用性待官方解析确认。', { planSupported: false }),
]
const hexByte = byte => byte.toString(16).padStart(2, '0')
const hex = bytes => Array.from(bytes, hexByte).join(' ')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const failure = (error, message) => ({ ok: false, error, message, hardwareAccess: false, executable: false })
const decode = (raw, definition) => definition.values[definition.encoded.indexOf(raw[definition.byteIndex] & definition.mask)] ?? 'unknown'

export function optionSchema(mcu = PROFILE.model) {
  if (ASSET.error) return failure('OFFICIAL_OPTION_DATA_INVALID', ASSET.error)
  if (mcu !== PROFILE.model) return failure('PROFILE_NOT_AVAILABLE', '此型号尚无离线修改profile，可按官方数据继续扩展。')
  return {
    ok: true, schemaVersion: 1, profile: { ...PROFILE }, validation: 'offline', hardwareAccess: false,
    executable: false, actions: ['schema', 'read', 'plan', 'prepare', 'apply'], sources: structuredClone(SOURCES),
    fields: FIELDS.map(({ encoded, ...definition }) => ({
      risk: 'normal', ...structuredClone(definition), mask: hexByte(definition.mask),
      type: typeof definition.values[0] === 'number' ? 'integer' : typeof definition.values[0],
      validation: 'offline', source: 'stcgal-1.10/Stc15Option',
    })),
  }
}

/** A saved read-only status is input data, not proof of current device state. */
export function planOptions(input, patch, metadata = {}) {
  if (ASSET.error) return failure('OFFICIAL_OPTION_DATA_INVALID', ASSET.error)
  const snapshot = input?.action ? input : input?.ok === true ? input.data : null
  if (!plainObject(snapshot) || snapshot.ok !== true || snapshot.action !== 'chipinfo' || snapshot.stage !== 'complete' ||
      snapshot.programmed !== false || snapshot.eraseStarted !== false || snapshot.hardwareOptionsWritten !== false) {
    return failure('INVALID_OPTION_SNAPSHOT', '需要成功完成的只读chipinfo快照，不能使用下载前的旧状态。')
  }
  const chip = snapshot.chip
  if (chip?.model !== PROFILE.model || chip?.magic !== PROFILE.magic || chip?.bslVersion !== PROFILE.bslVersion) {
    return failure('PROFILE_NOT_AVAILABLE', '快照型号、magic或BSL与当前profile不匹配。')
  }
  const options = chip.hardwareOptions
  if (options?.schemaVersion !== 1 || options.available !== true || options.ok !== true || options.readOnly !== true ||
      options.support !== 'supported' || options.source !== 'initial-bootloader-status' ||
      options.decoder !== 'stcgal-1.10/Stc15Option' || !Array.isArray(options.errors) || options.errors.length ||
      !plainObject(options.values) || typeof options.rawMsrHex !== 'string' ||
      !/^[0-9a-f]{2}( [0-9a-f]{2}){4}$/i.test(options.rawMsrHex)) {
    return failure('INVALID_OPTION_SNAPSHOT', '选项快照不完整、解码失败或MSR格式不符合profile。')
  }
  const before = options.rawMsrHex.split(' ').map(value => Number.parseInt(value, 16))
  for (const definition of FIELDS) {
    if (!Object.hasOwn(options.values, definition.name) || options.values[definition.name] !== decode(before, definition)) {
      return failure('SNAPSHOT_VALUE_MISMATCH', '原始MSR与结构化字段不一致：' + definition.name)
    }
  }
  if (!plainObject(patch) || Reflect.ownKeys(patch).some(key => typeof key !== 'string')) {
    return failure('INVALID_OPTION_PATCH', 'patch必须是包含已知字段和严格类型值的JSON对象。')
  }
  const after = [...before]
  const changes = []
  const requested = Object.keys(patch).sort().map(name => [name, patch[name]])
  const allowedMasks = Array(PROFILE.msrBytes).fill(0)
  for (const [name, value] of requested) {
    const definition = FIELDS.find(item => item.name === name)
    if (!definition) return failure('UNKNOWN_OPTION', '未知选项：' + name)
    if (!definition.planSupported) return failure('OPTION_NOT_VERIFIED', '字段保留可见，待官方解析核验后开放计划：' + name)
    const index = definition.values.findIndex(candidate => candidate === value)
    if (index < 0) return failure('INVALID_OPTION_VALUE', name + '的类型或取值不正确。允许：' + JSON.stringify(definition.values))
    const { byteIndex, mask } = definition
    allowedMasks[byteIndex] |= mask
    after[byteIndex] = (after[byteIndex] & (~mask & 0xff)) | definition.encoded[index]
    if (options.values[name] !== value) changes.push({ field: name, before: options.values[name], after: value,
      byteIndex, mask: hexByte(mask), risk: definition.risk ?? 'normal', effect: definition.effect,
      ...(definition.nominalVoltsByEncoding ? { beforeNominalVolts: definition.nominalVoltsByEncoding[options.values[name]], afterNominalVolts: definition.nominalVoltsByEncoding[value], voltageKind: definition.voltageKind } : {}) })
  }
  const byteDiffs = []
  for (let index = 0; index < before.length; index++) {
    const changed = before[index] ^ after[index]
    if (changed & (~allowedMasks[index] & 0xff)) return failure('RESERVED_BITS_CHANGED', '按位合并意外改变了未请求的位。')
    if (changed) byteDiffs.push({ index, before: hexByte(before[index]), after: hexByte(after[index]), changedMask: hexByte(changed) })
  }
  const beforeMsrHex = hex(before)
  const identity = { profile: PROFILE.id, model: chip.model, magic: chip.magic, bslVersion: chip.bslVersion, beforeMsrHex, requested }
  return {
    ok: true, schemaVersion: 1, planId: digest(identity), profile: { ...PROFILE }, validation: 'offline',
    executable: false, hardwareAccess: false, programmed: false, eraseStarted: false, hardwareOptionsWritten: false,
    hasChanges: changes.length > 0, beforeMsrHex, afterMsrHex: hex(after), patch: Object.fromEntries(requested), changes, byteDiffs,
    source: { kind: 'saved-read-only-chipinfo', decoder: options.decoder, stateSha256: digest(identity.beforeMsrHex),
      ...(typeof metadata.fileSha256 === 'string' ? { fileSha256: metadata.fileSha256 } : {}) },
    freshness: 'unverified-saved-snapshot', requiresFreshReadBeforeApply: true,
    application: { available: true, requiresPrepare: true, method: 'reflash-code', requiresCodeImage: true,
      flashEffect: 'request-bootloader-code-erase-and-reprogram', codeEraseBytes: null,
      eepromEffect: 'no-separate-erase-request; code-address IAP data not guaranteed' },
    sources: structuredClone(SOURCES),
    nextAction: '本结果只预览差异。请用prepare绑定HEX/端口/频率；apply会重读目标基线后重刷整个代码区。',
  }
}
