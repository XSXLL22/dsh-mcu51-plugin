import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { composeImage, verifyImage, exportImage } from '../lib/image.js'
import { PACKAGE_ROOT, resolveConfig } from '../lib/config.js'
import { buildToolSpecs } from '../lib/tools.js'
import { preflightHex } from '../lib/flash.js'

// Workspace temp also works under the Windows nested-TEMP sandbox restriction.
const tempRoot = join(PACKAGE_ROOT, 'test/.tmp')
mkdirSync(tempRoot, { recursive: true })
const dir = mkdtempSync(join(tempRoot, 'image 中文 '))
after(() => {
  const target = resolve(dir)
  assert.ok(target.startsWith(resolve(tempRoot) + sep) && target !== resolve(tempRoot))
  rmSync(target, { recursive: true, force: true })
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function file(name, data) { const path = join(dir, name); writeFileSync(path, data); return path }
function record(type, address, data = []) {
  const bytes = [data.length, address >> 8, address & 255, type, ...data]
  return ':' + Buffer.from([...bytes, (-bytes.reduce((s, n) => s + n, 0)) & 255]).toString('hex').toUpperCase()
}
const eof = record(1, 0)
function hex(name, rows) { return file(name, [...rows, eof, ''].join('\n')) }
function dense(image, buffer = 'code', format = 'bin') { return exportImage(image, image.imageId, buffer, format) }

test('compose two logical buffers, offset BIN, sort records and bind final bytes independent of file spelling', () => {
  const a = hex('a.hex', [record(0, 4, [0x56, 0x78]), record(0, 0, [0x12])])
  const b = file('b.bin', Buffer.from([0x34]))
  const image = composeImage({ sources: [{ path: a }, { path: b, offset: 1 }, { path: b, buffer: 'eeprom' }] })
  assert.equal(image.ok, true, image.message)
  assert.equal(image.hardwareAccess, false)
  assert.equal(image.buffers.code.dataBytes, 4)
  assert.equal(image.buffers.code.denseSha256, sha(Buffer.from([0x12, 0x34, 255, 255, 0x56, 0x78])))
  assert.equal(dense(image).bytes.toString('hex'), '1234ffff5678')
  assert.equal(dense(image, 'eeprom').bytes.toString('hex'), '34')
  const same = composeImage({ sources: [{ path: b, buffer: 'eeprom' }, { path: b, offset: 1 }, { path: file('alias.HEX', readFileSync(a)) }] })
  assert.equal(same.imageId, image.imageId)
  assert.notEqual(image.sources[0].fileSha256, image.buffers.code.denseSha256)
})

test('overlap is rejected within HEX and across sources, including identical duplicate bytes', () => {
  const duplicate = hex('duplicate.hex', [record(0, 0, [1, 2]), record(0, 1, [2])])
  assert.equal(composeImage({ sources: [{ path: duplicate }] }).error, 'IMAGE_OVERLAP')
  const bin = file('overlap.bin', Buffer.from([1]))
  assert.equal(composeImage({ sources: [{ path: bin }, { path: bin }] }).error, 'IMAGE_OVERLAP')
  assert.equal(composeImage({ sources: [{ path: bin }, { path: bin, buffer: 'eeprom' }] }).ok, true)
})

test('strict HEX rejects corruption, missing EOF, post-EOF data, invalid types and malformed control records', () => {
  for (const [i, text] of [
    ':01000000AA00\n' + eof,
    record(0, 0, [1]),
    eof + '\n' + record(0, 0, [1]),
    record(6, 0, [1]) + '\n' + eof,
    record(4, 1, [0, 0]) + '\n' + eof,
    ':0200000001FD\n' + eof,
    ':00000001FFgarbage',
  ].entries()) assert.equal(composeImage({ sources: [{ path: file('bad' + i + '.hex', text) }] }).ok, false, text)
})

test('extended address modes and start metadata survive; ambiguous offset of entry point is rejected', () => {
  const segment = hex('segment.hex', [record(2, 0, [0, 1]), record(0, 2, [0xaa]), record(3, 0, [0, 1, 0, 2])])
  const image = composeImage({ sources: [{ path: segment }], fillByte: 0 })
  assert.equal(image.buffers.code.maxAddr, 18)
  assert.deepEqual(image.buffers.code.startAddress, { type: 3, dataHex: '00010002' })
  assert.equal(composeImage({ sources: [{ path: segment, offset: 1 }] }).error, 'IMAGE_ENTRY_OFFSET')
  const linear = hex('linear.hex', [record(4, 0, [0, 0]), record(0, 1, [0xbb]), record(5, 0, [0, 0, 0, 1])])
  const result = composeImage({ sources: [{ path: linear }] })
  const exported = dense(result, 'code', 'hex')
  const roundtrip = composeImage({ sources: [{ path: file('entry-roundtrip.hex', exported.bytes) }] })
  assert.deepEqual(roundtrip.buffers.code.startAddress, result.buffers.code.startAddress)
  assert.equal(roundtrip.buffers.code.denseSha256, result.buffers.code.denseSha256)
  assert.equal(dense(result).error, 'IMAGE_BIN_ENTRY_LOSS')
  assert.equal(composeImage({ sources: [{ path: linear }, { path: segment }] }).error, 'IMAGE_ENTRY_CONFLICT')
})

test('64KiB boundaries and all numeric arguments are strict, with no guessed format or layout', () => {
  const bin = file('edge.bin', Buffer.from([0xaa]))
  const valid = composeImage({ sources: [{ path: bin, offset: 65535 }] })
  assert.equal(valid.ok, true)
  assert.equal(valid.buffers.code.denseBytes, 65536)
  for (const offset of [-1, 1.5, '1', 65536, null]) assert.equal(composeImage({ sources: [{ path: bin, offset }] }).ok, false)
  for (const fillByte of [-1, 256, '255', null]) assert.equal(composeImage({ sources: [{ path: bin }], fillByte }).ok, false)
  assert.equal(composeImage({ sources: [{ path: file('unknown.dat', Buffer.from([1])) }] }).ok, false)
  assert.equal(composeImage({ sources: [{ path: file('empty.bin', Buffer.alloc(0)) }] }).ok, false)
  assert.equal(composeImage({ sources: [{ path: hex('high.hex', [record(4, 0, [0, 1]), record(0, 0, [1])]) }] }).ok, false)
  assert.equal(composeImage({ sources: [{ path: hex('cross.hex', [record(0, 65535, [1, 2])]) }] }).ok, false)
})

test('verify/export require intact image identity and recomputed summaries; exports freeze bytes despite changed source', () => {
  const source = file('mutable.bin', Buffer.from([1, 2]))
  const image = composeImage({ sources: [{ path: source }] })
  writeFileSync(source, Buffer.from([3, 4]))
  assert.equal(dense(image).bytes.toString('hex'), '0102')
  for (const mutate of [
    x => { x.buffers.code.segments[0].dataHex = '0304' },
    x => { x.buffers.code.denseSha256 = '0'.repeat(64) },
    x => { x.buffers.code.dataBytes = 999 },
    x => { x.buffers.code.fillByte = 0 },
    x => { x.imageId = '0'.repeat(64) },
  ]) { const corrupt = structuredClone(image); mutate(corrupt); assert.equal(verifyImage(corrupt).ok, false) }
  assert.equal(exportImage(image, '0'.repeat(64), 'code', 'hex').ok, false)
  assert.equal(exportImage(image, undefined, 'code', 'hex').ok, false)
  assert.equal(exportImage(image, image.imageId, 'bad', 'hex').ok, false)
})

test('dense HEX and BIN exports agree under the actual bundled ISP parser, even for sparse input and fill FF', () => {
  const image = composeImage({ sources: [{ path: hex('sparse.hex', [record(0, 0, [1]), record(0, 33, [2])]) }] })
  const binary = dense(image)
  const output = file('dense.hex', dense(image, 'code', 'hex').bytes)
  assert.equal(preflightHex(output).ok, true)
  const oracle = spawnSync(join(PACKAGE_ROOT, 'runtime/win32-x64/python.exe'), ['-I', '-B', '-c', 'import sys; from stcgal.ihex import IHex; print(IHex.read_file(sys.argv[1]).extract_data().hex())', output], { encoding: 'utf8' })
  assert.equal(oracle.status, 0, oracle.stderr)
  assert.equal(oracle.stdout.trim(), binary.bytes.toString('hex'))
  assert.equal(binary.sha256, image.buffers.code.denseSha256)
})

test('empty source list clears both logical buffers, with no empty export treated as firmware', () => {
  const empty = composeImage({ sources: [] })
  assert.equal(empty.ok, true)
  assert.equal(empty.buffers.code.dataBytes, 0)
  assert.equal(empty.buffers.eeprom.dataBytes, 0)
  assert.equal(verifyImage(empty).ok, true)
  assert.equal(dense(empty).error, 'IMAGE_EMPTY_BUFFER')
})

test('registered image tool saves verifiable artifact and exports immutable files without overwriting collisions', async () => {
  const specs = buildToolSpecs({ defineTool: x => x, config: resolveConfig({ dataDir: join(dir, 'data') }) })
  const tool = specs.find(x => x.name === 'mcu_image')
  assert.ok(tool)
  const source = file('tool.bin', Buffer.from([0x55, 0xaa]))
  const result = await tool.execute({ action: 'compose', sources: [{ path: source }] })
  assert.equal(result.ok, true, result.summary)
  const inspected = await tool.execute({ action: 'inspect', image: result.logPath })
  assert.equal(inspected.data.imageId, result.data.imageId)
  const other = await tool.execute({ action: 'compose', sources: [] })
  assert.notEqual(other.logPath, result.logPath)
  assert.equal(JSON.parse(readFileSync(result.logPath, 'utf8')).imageId, result.data.imageId)
  const args = { action: 'export', image: result.logPath, expectedImageId: result.data.imageId, buffer: 'code', format: 'bin' }
  const exported = await tool.execute(args)
  assert.equal(exported.ok, true, exported.summary)
  assert.equal(readFileSync(exported.data.path).toString('hex'), '55aa')
  assert.equal((await tool.execute(args)).data.reused, true)
  writeFileSync(exported.data.path, Buffer.from([0]))
  assert.equal((await tool.execute(args)).data.error, 'IMAGE_EXPORT_COLLISION')
  assert.equal((await tool.execute({ action: 'apply', image: result.logPath })).ok, false)
  assert.equal((await tool.execute({ ...args, fillByte: 0 })).ok, false)
  assert.equal((await tool.execute({ action: 'compose', image: result.logPath, sources: [] })).ok, false)
})

test('a failed export log preserves the concrete file receipt and reports failure', async () => {
  const dataDir = join(dir, 'blocked-log')
  const config = resolveConfig({ dataDir })
  const tool = buildToolSpecs({ defineTool: x => x, config }).find(x => x.name === 'mcu_image')
  const image = composeImage({ sources: [{ path: file('receipt.bin', Buffer.from([7])) }] })
  const imagePath = file('receipt.json', JSON.stringify(image))
  file('blocked-log/logs', 'this is a file, not a log directory')
  const result = await tool.execute({ action: 'export', image: imagePath, expectedImageId: image.imageId, format: 'bin' })
  assert.equal(result.ok, false)
  assert.equal(result.data.ok, true)
  assert.match(result.data.logError, /logs|exist/i)
  assert.equal(readFileSync(result.data.path).toString('hex'), '07')
})

test('maximally fragmented 64KiB logical buffers remain loadable after saving', async () => {
  const source = hex('fragmented.hex', Array.from({ length: 32768 }, (_, i) => record(0, i * 2, [i & 255])))
  const tool = buildToolSpecs({ defineTool: x => x, config: resolveConfig({ dataDir: join(dir, 'fragmented') }) }).find(x => x.name === 'mcu_image')
  const result = await tool.execute({ action: 'compose', sources: [{ path: source }, { path: source, buffer: 'eeprom' }] })
  assert.equal(result.ok, true, result.summary)
  assert.ok(statSync(result.logPath).size > 1024 * 1024)
  const checked = await tool.execute({ action: 'inspect', image: result.logPath })
  assert.equal(checked.ok, true, checked.summary)
  assert.equal(checked.data.buffers.eeprom.dataBytes, 32768)
  const exported = await tool.execute({ action: 'export', image: result.logPath, expectedImageId: result.data.imageId, buffer: 'eeprom', format: 'bin' })
  assert.equal(exported.ok, true, exported.summary)
  assert.equal(exported.data.sizeBytes, 65535)
  assert.equal(sha(readFileSync(exported.data.path)), result.data.buffers.eeprom.denseSha256)
})
