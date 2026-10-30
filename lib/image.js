// Offline, bounded 8051 logical buffers. No serial/runtime/vendor dependencies.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'

const LIMIT = 65536
const FILE_LIMIT = 4 * 1024 * 1024
const ROLES = ['code', 'eeprom']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
})
function demand(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code })
}
function attempt(fn) {
  try { return fn() }
  catch (error) { return { ok: false, hardwareAccess: false, error: error.code ?? 'IMAGE_ERROR', message: error.message } }
}
function integer(value, min, max, label) {
  demand(Number.isSafeInteger(value) && value >= min && value <= max, 'IMAGE_ARGUMENT', label + '必须为整数' + min + '~' + max + '。')
  return value
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function entry(type, dataHex) {
  demand([3, 5].includes(type) && typeof dataHex === 'string' && /^[0-9a-f]{8}$/.test(dataHex), 'IMAGE_ENTRY', 'HEX起始地址记录不合法。')
  const data = Buffer.from(dataHex, 'hex')
  const address = type === 3 ? data.readUInt16BE(0) * 16 + data.readUInt16BE(2) : data.readUInt32BE(0)
  demand(address < LIMIT, 'IMAGE_RANGE', 'HEX起始地址超过8051 64KiB逻辑空间。')
  return { type, dataHex }
}
function mergeEntry(before, next) {
  demand(before === null || canonical(before) === canonical(next), 'IMAGE_ENTRY_CONFLICT', '同一缓冲区存在不同的HEX起始地址记录。')
  return next
}
function parseHex(content, offset) {
  const segments = []
  let base = 0, eof = false, startAddress = null, dataBytes = 0
  for (const [index, raw] of content.toString('latin1').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const invalid = () => demand(false, 'IMAGE_INVALID_HEX', 'HEX第' + (index + 1) + '行长度、校验和、类型或EOF无效。')
    if (eof || !/^:(?:[0-9a-f]{2}){5,}$/i.test(line)) invalid()
    const bytes = Buffer.from(line.slice(1), 'hex')
    const count = bytes[0], address = bytes.readUInt16BE(1), type = bytes[3]
    const fixedLength = { 1: 0, 2: 2, 3: 4, 4: 2, 5: 4 }
    if (bytes.length !== count + 5 || bytes.reduce((sum, byte) => sum + byte, 0) % 256 !== 0 ||
        type > 5 || (type !== 0 && (count !== fixedLength[type] || address !== 0))) invalid()
    const data = bytes.subarray(4, 4 + count)
    if (type === 0 && count) {
      demand(address + count <= LIMIT, 'IMAGE_RANGE', 'HEX数据记录跨越64KiB记录边界。')
      dataBytes += count
      demand(dataBytes <= LIMIT, 'IMAGE_RANGE', 'HEX数据总量超过64KiB；不合并重复地址。')
      segments.push({ address: base + address + offset, dataHex: data.toString('hex') })
    } else if (type === 1) eof = true
    else if (type === 2) base = data.readUInt16BE(0) * 16
    else if (type === 4) base = data.readUInt16BE(0) * LIMIT
    else if (type === 3 || type === 5) {
      demand(offset === 0, 'IMAGE_ENTRY_OFFSET', '带起始地址记录的HEX不支持非零偏移；请提供不含入口元数据的镜像。')
      startAddress = mergeEntry(startAddress, entry(type, data.toString('hex')))
    }
  }
  demand(eof, 'IMAGE_INVALID_HEX', 'HEX缺少EOF。')
  demand(segments.length > 0, 'IMAGE_EMPTY_SOURCE', 'HEX没有数据记录。')
  return { segments, startAddress }
}
function normalizeBuffer(segments, fillByte, startAddress) {
  integer(fillByte, 0, 255, 'fillByte')
  demand(Array.isArray(segments) && segments.length <= LIMIT, 'IMAGE_SEGMENTS', '缓冲区片段格式不合法。')
  const sorted = segments.map(segment => {
    demand(object(segment) && typeof segment.dataHex === 'string' && /^(?:[0-9a-f]{2})+$/.test(segment.dataHex) && segment.dataHex.length <= LIMIT * 2,
      'IMAGE_SEGMENTS', '缓冲区数据必须是非空小写十六进制字节。')
    const address = integer(segment.address, 0, LIMIT - 1, '片段地址')
    demand(address + segment.dataHex.length / 2 <= LIMIT, 'IMAGE_RANGE', '镜像超过8051 64KiB逻辑空间。')
    return { address, dataHex: segment.dataHex }
  }).sort((a, b) => a.address - b.address)
  const merged = []
  for (const segment of sorted) {
    const previous = merged.at(-1)
    const end = previous ? previous.address + previous.dataHex.length / 2 : -1
    demand(segment.address >= end, 'IMAGE_OVERLAP', '数据在地址0x' + segment.address.toString(16) + '重叠；相同字节也不自动覆盖。')
    if (segment.address === end) previous.dataHex += segment.dataHex
    else merged.push({ ...segment })
  }
  if (startAddress !== null) {
    demand(object(startAddress), 'IMAGE_ENTRY', '起始地址元数据格式错误。')
    startAddress = entry(startAddress.type, startAddress.dataHex)
  }
  const maxAddr = merged.length ? merged.at(-1).address + merged.at(-1).dataHex.length / 2 - 1 : null
  const dense = Buffer.alloc(maxAddr === null ? 0 : maxAddr + 1, fillByte)
  for (const segment of merged) Buffer.from(segment.dataHex, 'hex').copy(dense, segment.address)
  return { fillByte, segments: merged, startAddress, dataBytes: merged.reduce((sum, segment) => sum + segment.dataHex.length / 2, 0),
    minAddr: merged[0]?.address ?? null, maxAddr, denseBytes: dense.length, denseSha256: digest(dense) }
}
function identity(buffers) {
  return digest(canonical({ kind: 'mcu51-image', schemaVersion: 1, buffers }))
}
function readBounded(path, limit = FILE_LIMIT) {
  demand(typeof path === 'string' && isAbsolute(path), 'IMAGE_PATH', '请提供文件绝对路径。')
  const stat = statSync(path)
  demand(stat.isFile() && stat.size <= limit, 'IMAGE_FILE_SIZE', '文件必须是普通文件且不超过' + limit + '字节。')
  const bytes = readFileSync(path)
  demand(bytes.length <= limit, 'IMAGE_FILE_SIZE', '读取期间文件超过大小限制。')
  return bytes
}

/** sources[] builds a fresh immutable image; [] means both buffers are clear. */
export function composeImage(args = {}) {
  return attempt(() => {
    demand(object(args) && Array.isArray(args.sources) && args.sources.length <= 32, 'IMAGE_ARGUMENT', 'sources必须是0~32项数组。')
    const fillByte = args.fillByte === undefined ? 255 : integer(args.fillByte, 0, 255, 'fillByte')
    const pending = Object.fromEntries(ROLES.map(role => [role, { segments: [], startAddress: null }]))
    const sources = []
    for (const source of args.sources) {
      demand(object(source), 'IMAGE_ARGUMENT', 'sources每项必须是对象。')
      const role = source.buffer === undefined ? 'code' : source.buffer
      demand(ROLES.includes(role), 'IMAGE_ARGUMENT', 'buffer仅支持code/eeprom逻辑缓冲区。')
      const offset = source.offset === undefined ? 0 : integer(source.offset, 0, LIMIT - 1, 'offset')
      const format = source.format === undefined ? extname(source.path ?? '').slice(1).toLowerCase() : source.format
      demand(['hex', 'bin'].includes(format), 'IMAGE_FORMAT', '格式仅支持hex/bin；其他扩展名须显式指定format。')
      const bytes = readBounded(source.path, format === 'bin' ? LIMIT : FILE_LIMIT)
      demand(bytes.length > 0, 'IMAGE_EMPTY_SOURCE', '输入文件为空。')
      const parsed = format === 'hex' ? parseHex(bytes, offset) : { segments: [{ address: offset, dataHex: bytes.toString('hex') }], startAddress: null }
      const target = pending[role]
      const combined = normalizeBuffer([...target.segments, ...parsed.segments], fillByte, target.startAddress)
      target.segments = combined.segments
      if (parsed.startAddress) target.startAddress = mergeEntry(target.startAddress, parsed.startAddress)
      sources.push({ path: source.path, buffer: role, format, offset, sizeBytes: bytes.length, fileSha256: digest(bytes) })
    }
    const buffers = Object.fromEntries(ROLES.map(role => [role, normalizeBuffer(pending[role].segments, fillByte, pending[role].startAddress)]))
    return { ok: true, kind: 'mcu51-image', schemaVersion: 1, hardwareAccess: false, layout: 'logical-buffers',
      imageId: identity(buffers), buffers, sources }
  })
}

export function verifyImage(image, expectedImageId) {
  return attempt(() => {
    demand(object(image) && image.ok === true && image.kind === 'mcu51-image' && image.schemaVersion === 1 &&
      image.hardwareAccess === false && image.layout === 'logical-buffers' && object(image.buffers) &&
      Object.keys(image.buffers).sort().join(',') === 'code,eeprom' && Array.isArray(image.sources), 'IMAGE_ARTIFACT', '镜像文件格式不正确。')
    const buffers = Object.fromEntries(ROLES.map(role => {
      const buffer = image.buffers[role]
      demand(object(buffer), 'IMAGE_ARTIFACT', '缺少逻辑缓冲区。')
      return [role, normalizeBuffer(buffer.segments, buffer.fillByte, buffer.startAddress)]
    }))
    demand(canonical(buffers) === canonical(image.buffers) && identity(buffers) === image.imageId, 'IMAGE_ID_MISMATCH', '镜像内容、统计或SHA256不一致。')
    if (expectedImageId !== undefined) demand(typeof expectedImageId === 'string' && /^[0-9a-f]{64}$/.test(expectedImageId) && image.imageId === expectedImageId,
      'IMAGE_ID_MISMATCH', '预期imageId与镜像不符。')
    return { ...image, buffers }
  })
}

function hexRecord(type, address, data) {
  const bytes = Buffer.from([data.length, address >> 8, address & 255, type, ...data])
  return ':' + bytes.toString('hex').toUpperCase() + ((-bytes.reduce((sum, byte) => sum + byte, 0)) & 255).toString(16).padStart(2, '0').toUpperCase()
}
/** Encode a fully materialized 0-based buffer without implicit HEX holes. */
export function encodeDenseHex(dense, startAddress = null) {
  demand(Buffer.isBuffer(dense) && dense.length > 0 && dense.length <= LIMIT, 'IMAGE_ARGUMENT', 'HEX字节数必须为1~65536。')
  const rows = []
  for (let offset = 0; offset < dense.length; offset += 16) rows.push(hexRecord(0, offset, dense.subarray(offset, offset + 16)))
  if (startAddress) rows.push(hexRecord(startAddress.type, 0, Buffer.from(startAddress.dataHex, 'hex')))
  rows.push(hexRecord(1, 0, Buffer.alloc(0)))
  return Buffer.from(rows.join('\n') + '\n', 'ascii')
}
export function exportImage(image, expectedImageId, buffer = 'code', format = 'hex') {
  return attempt(() => {
    demand(typeof expectedImageId === 'string' && /^[0-9a-f]{64}$/.test(expectedImageId), 'IMAGE_ID_REQUIRED', '导出必须提供完整expectedImageId。')
    const verified = verifyImage(image, expectedImageId)
    demand(verified.ok, verified.error, verified.message)
    demand(ROLES.includes(buffer) && ['hex', 'bin'].includes(format), 'IMAGE_ARGUMENT', '导出buffer=code/eeprom，format=hex/bin。')
    const data = verified.buffers[buffer]
    demand(data.dataBytes > 0, 'IMAGE_EMPTY_BUFFER', '缓冲区为空，不能导出为固件。')
    demand(!(format === 'bin' && data.startAddress), 'IMAGE_BIN_ENTRY_LOSS', 'BIN不能保存HEX起始地址元数据；请导出HEX。')
    const dense = Buffer.alloc(data.denseBytes, data.fillByte)
    for (const segment of data.segments) Buffer.from(segment.dataHex, 'hex').copy(dense, segment.address)
    let bytes = dense
    if (format === 'hex') {
      // Materialize every gap: upstream IHex would otherwise silently fill 00.
      bytes = encodeDenseHex(dense, data.startAddress)
    }
    return { ok: true, hardwareAccess: false, imageId: image.imageId, buffer, format, bytes, sizeBytes: bytes.length,
      sha256: digest(bytes), denseSha256: data.denseSha256, fillByte: data.fillByte, origin: 0 }
  })
}

/** File/tool adapter. Export names are generated inside dataDir and never overwrite. */
export function runImageAction(args, dataDir) {
  return attempt(() => {
    demand(object(args), 'IMAGE_ARGUMENT', '参数必须为对象。')
    const action = args.action ?? 'compose'
    if (action === 'compose') {
      demand(['image', 'expectedImageId', 'buffer', 'format'].every(key => args[key] === undefined), 'IMAGE_ARGUMENT', 'compose从空白建立镜像，不接受已有image或导出参数。')
      return composeImage(args)
    }
    demand(['inspect', 'export'].includes(action), 'IMAGE_ACTION', 'action仅支持compose/inspect/export。')
    demand(args.sources === undefined && args.fillByte === undefined, 'IMAGE_ARGUMENT', 'inspect/export不能同时导入或更改填充值。')
    // Pretty-printed, maximally fragmented two-buffer images exceed 1MiB.
    const image = JSON.parse(readBounded(args.image, 16 * 1024 * 1024).toString('utf8'))
    if (action === 'inspect') return verifyImage(image, args.expectedImageId)
    const result = exportImage(image, args.expectedImageId, args.buffer, args.format)
    if (!result.ok) return result
    const directory = join(dataDir, 'images')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, result.imageId + '-' + result.buffer + '.' + result.format)
    let reused = false
    try { writeFileSync(path, result.bytes, { flag: 'wx' }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      demand(statSync(path).size === result.bytes.length && readFileSync(path).equals(result.bytes), 'IMAGE_EXPORT_COLLISION', '导出路径已存在不同内容，未覆盖：' + path)
      reused = true
    }
    const { bytes: _bytes, ...receipt } = result
    return { ...receipt, path, reused }
  })
}
