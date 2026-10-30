// Offline image verification and virtual combined payload; never opens a port.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { verifyImage, runImageAction } from './image.js'
import { queryCatalog } from './catalog.js'

const PROTOCOL = new URL('../data/stc15-memory-protocol.json', import.meta.url)
const fail = (error, message) => ({ ok: false, error, message, hardwareAccess: false, executable: false })
const demand = (ok, code, message) => { if (!ok) throw Object.assign(new Error(message), { code }) }
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const byteHex = value => value.toString(16).padStart(2, '0')
const eraseHex = count => '03 ' + byteHex(count) + ' 00 5a a5'
const writeHeader = offset => (offset === 0 ? '22 ' : '02 ') + byteHex(offset >> 8) + ' ' + byteHex(offset & 255) + ' 5a a5'

function protocolFacts(path, memory) {
  try {
    demand(statSync(path).size <= 65536, 'MEMORY_PROTOCOL_INVALID', '协议预览数据超过64KiB。')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    demand(data.schemaVersion === 1 && data.profileId === 'stc675-uart72-memory-preview' &&
      data.source?.exeSha256 === memory.storageSource.exeSha256 && data.source?.id === memory.storageSource.id &&
      data.evidence === 'official-static' && data.validation === 'offline' && data.hardwareValidated === false && data.planningOnly === true &&
      data.bslFamily === '7.2' && /^[0-9a-f]{64}$/.test(data.evidenceCanonicalSha256) &&
      Array.isArray(data.recordIds) && data.recordIds.length === 18 && new Set(data.recordIds).size === 18 && data.recordIds.includes(memory.record.id) &&
      canonical(data.erase) === canonical({ opcode: 3, dataSectorBytes: 512, dataCountBytes: 1, reservedByte: 0, magicHex: '5aa5',
        codeLengthEncoded: false, dataCountFormula: 'max(0,ceil((combinedEnd-codeBytes)/512))' }) &&
      canonical(data.program) === canonical({ firstOpcode: 34, nextOpcode: 2, addressBytes: 2, addressEndian: 'big', magicHex: '5aa5' }) &&
      data.mapping?.kind === 'linear-combined-buffer' && data.mapping.fileBaseIsWireBase === false &&
      data.mapping.actualBslEraseExtent === 'unknown-without-independent-readback',
    '协议预览来源、适用范围或字段不一致。')
    return data
  } catch (error) { throw Object.assign(new Error(error.message), { code: 'MEMORY_PROTOCOL_INVALID' }) }
}

function materialize(buffer) {
  const dense = Buffer.alloc(buffer.denseBytes, buffer.fillByte)
  for (const segment of buffer.segments) Buffer.from(segment.dataHex, 'hex').copy(dense, segment.address)
  return dense
}

/** protocolPath is an internal test seam, never a tool parameter. */
export function prepareMemoryPlan(image, expectedImageId, options = {}, protocolPath = PROTOCOL) {
  try {
    demand(object(options) && Object.keys(options).every(k => ['targetId', 'bslVersion', 'erasePolicy', 'eepromOffset'].includes(k)),
      'MEMORY_ARGUMENT', '存储预览只接受targetId/bslVersion/erasePolicy/eepromOffset。')
    demand(typeof expectedImageId === 'string' && /^[0-9a-f]{64}$/.test(expectedImageId), 'IMAGE_ID_REQUIRED', '预览需要完整expectedImageId。')
    const checked = verifyImage(image, expectedImageId)
    if (!checked.ok) return { ...checked, executable: false }
    demand(typeof options.targetId === 'string' && /^stc675:(0|[1-9][0-9]*)$/.test(options.targetId), 'MEMORY_TARGET_REQUIRED', '需要目录返回的唯一targetId。')
    const memory = queryCatalog({ action: 'memory', id: options.targetId })
    if (!memory.ok) return { ...memory, executable: false }
    const { tableFacts, layout } = memory.record.memory
    demand(layout !== null, 'MEMORY_LAYOUT_UNKNOWN', '此型号物理布局尚未核验，不能生成地址预览。')
    demand(typeof options.bslVersion === 'string' && /^7\.2(?:\.[0-9]{1,2}[A-Za-z]?)?$/.test(options.bslVersion),
      'MEMORY_BSL_NOT_MODELED', '当前预览只建模明确声明的7.2族；不连接芯片确认此声明。')
    demand(['code', 'code-and-data'].includes(options.erasePolicy), 'MEMORY_ERASE_POLICY', '请明确erasePolicy=code或code-and-data。')
    demand(options.eepromOffset === undefined || Number.isSafeInteger(options.eepromOffset) && options.eepromOffset >= 0 && options.eepromOffset <= 65535,
      'MEMORY_ARGUMENT', 'eepromOffset必须是0~65535整数，不自动转换。')
    const facts = protocolFacts(protocolPath, memory)
    const { code, eeprom } = checked.buffers
    demand(code.dataBytes > 0, 'MEMORY_CODE_REQUIRED', '当前仅预览完整代码重刷；EEPROM单写/保代码流程尚未建立。')
    demand(code.startAddress === null && eeprom.startAddress === null, 'MEMORY_ENTRY_UNSUPPORTED', '此预览尚未建模HEX入口元数据，不能静默丢弃。')
    demand(code.denseBytes <= tableFacts.codeBytes, 'MEMORY_CODE_OVERFLOW', '代码展开后超过官方代码表项，不截断。')
    const hasData = eeprom.dataBytes > 0, shared = layout.dataOverlapsCode
    demand(hasData || options.eepromOffset === undefined, 'MEMORY_ARGUMENT', '空EEPROM缓冲区不接受数据放置偏移。')
    demand(!hasData || !shared || options.eepromOffset !== undefined, 'MEMORY_SHARED_OFFSET_REQUIRED', '共享IAP数据必须明确eepromOffset，不能猜测空闲代码地址。')
    const offset = options.eepromOffset ?? 0
    demand(!hasData || !shared || offset % 512 === 0, 'MEMORY_SHARED_OFFSET_ALIGNMENT', '共享IAP数据区从512字节扇区边界开始。')
    demand((shared || !hasData) ? options.erasePolicy === 'code' : options.erasePolicy === 'code-and-data',
      'MEMORY_ERASE_POLICY', '独立数据写入需code-and-data；共享IAP或无数据只能请求code。')
    demand(!hasData || offset + eeprom.denseBytes <= layout.iapDataRegion.length, 'MEMORY_DATA_OVERFLOW', '数据偏移加展开长度超过手册范围，不截断。')
    const linearAddress = hasData ? layout.movcDataRegion.start + offset : null
    demand(!hasData || linearAddress >= code.denseBytes, 'MEMORY_REGION_OVERLAP', '代码展开区与数据展开区发生物理重叠，不自动覆盖。')
    const end = hasData ? linearAddress + eeprom.denseBytes : code.denseBytes
    const paddedBytes = Math.ceil(end / 512) * 512
    demand(paddedBytes <= tableFacts.codeBytes + tableFacts.eepromBytes && paddedBytes <= 65536,
      'MEMORY_PAYLOAD_OVERFLOW', '512字节填充后的组合镜像超过名义范围。')
    const payload = Buffer.alloc(paddedBytes, 255)
    materialize(code).copy(payload)
    if (hasData) materialize(eeprom).copy(payload, linearAddress)
    const dataSectors = Math.max(0, Math.ceil((end - tableFacts.codeBytes) / 512))
    demand(dataSectors <= 255, 'MEMORY_ERASE_OVERFLOW', '数据擦除扇区数超过一字节，不能截断。')
    const engineSelector = paddedBytes > tableFacts.codeBytes ? 1 : 0
    const core = {
      ok: true, kind: 'mcu51-memory-preview', schemaVersion: 1, hardwareAccess: false, executable: false, implementationAvailable: false,
      target: { id: memory.record.id, model: memory.record.name, magic: memory.record.primaryMagic, bslVersion: options.bslVersion,
        declaration: 'caller-supplied; not a connected-chip identification' },
      imageId: checked.imageId, erasePolicy: options.erasePolicy,
      sourceBindings: { code: { denseBytes: code.denseBytes, denseSha256: code.denseSha256, fillByte: code.fillByte },
        eeprom: { denseBytes: eeprom.denseBytes, denseSha256: eeprom.denseSha256, fillByte: eeprom.fillByte } },
      evidence: { validation: 'offline', hardwareValidated: false, storageSource: memory.storageSource,
        protocolSource: facts.source, protocolProfileId: facts.profileId, protocolEvidenceCanonicalSha256: facts.evidenceCanonicalSha256,
        layout: structuredClone(layout), mappingBasis: 'explicit placement using datasheet MOVC addresses; official combined-buffer byte copy' },
      placement: { code: { linearAddress: 0, bytes: code.denseBytes },
        eeprom: hasData ? { iapAddress: offset, linearAddress, officialFileAddress: shared ? null : tableFacts.eepromFileBase + offset,
          bytes: eeprom.denseBytes, sharedWithCode: shared } : null },
      programImage: { bytes: paddedBytes, unpaddedBytes: end, sha256: sha(payload), alignmentBytes: 512, paddingByte: 255,
        interBufferFillByte: 255, paddingBytes: paddedBytes - end, exportsFlashableFile: false },
      wire: { erasePayloadHex: eraseHex(dataSectors), codeLengthEncoded: false, dataEraseSectors: dataSectors,
        requestedDataErasePrefixBytes: dataSectors * 512,
        bundledEngineErasePayloadHex: eraseHex(engineSelector), bundledEngineEraseMatches: dataSectors === engineSelector,
        programBlockBytes: 128, blockSizeEvidence: 'MCU-008 F449 transaction; conservative preview, not new per-model hardware validation',
        firstBlock: { offset: 0, headerHex: writeHeader(0) }, lastBlock: { offset: paddedBytes - 128, headerHex: writeHeader(paddedBytes - 128) },
        finishPayloadHex: '07 00 00 5a a5' },
      effects: { codeEraseBytes: null, nominalCodeBytes: tableFacts.codeBytes, nominalEepromBytes: tableFacts.eepromBytes,
        codeEraseExtent: 'bootloader-defined; exact physical range not independently read', dataPreservation: 'not-guaranteed',
        interBufferFillBytes: hasData ? linearAddress - code.denseBytes : 0,
        writeSpan: { start: 0, length: paddedBytes }, hardwareOptions: 'not-planned', clockCalibration: 'not-planned' },
      limitations: ['No hardware operation or execution API is provided by this preview.',
        'EEPROM-only writes and code-preserving erase are not implemented.',
        'Non-image bytes in the combined write span become FF; source-buffer holes retain their frozen fill bytes.',
        'Official default placement in every UI mode, BSL-specific tail reservations, option effects and actual erase preservation remain unverified.',
        'IAP sector size and requested data-prefix count do not establish a selective code-erase command or ISP readback.',
        'A memoryPlanId binds this preview, not hardware identity or user permission.'],
    }
    return { ...core, memoryPlanId: sha(canonical(core)) }
  } catch (error) { return fail(error.code ?? 'MEMORY_PLAN_FAILED', String(error.message)) }
}

export function runMemoryPlan(args) {
  if (!object(args) || args.action !== 'plan' || Object.keys(args).some(key => !['action', 'image', 'expectedImageId', 'targetId', 'bslVersion', 'erasePolicy', 'eepromOffset'].includes(key))) {
    return fail('MEMORY_ARGUMENT', 'plan不能混入导入/导出或硬件参数。')
  }
  const image = runImageAction({ action: 'inspect', image: args.image, expectedImageId: args.expectedImageId })
  if (!image.ok) return { ...image, executable: false }
  const options = Object.fromEntries(['targetId', 'bslVersion', 'erasePolicy', 'eepromOffset'].filter(k => args[k] !== undefined).map(k => [k, args[k]]))
  return prepareMemoryPlan(image, args.expectedImageId, options)
}

/** Internal execution seam: regenerate exactly the bytes identified by a preview. */
export function materializeMemoryPlan(image, expectedImageId, options) {
  const plan = prepareMemoryPlan(image, expectedImageId, options)
  if (!plan.ok) return plan
  const bytes = Buffer.alloc(plan.programImage.bytes, 255)
  materialize(image.buffers.code).copy(bytes)
  if (plan.placement.eeprom) materialize(image.buffers.eeprom).copy(bytes, plan.placement.eeprom.linearAddress)
  demand(sha(bytes) === plan.programImage.sha256, 'MEMORY_BYTES_CHANGED', '组合展开字节与预览摘要不同。')
  return { ok: true, plan, bytes }
}
