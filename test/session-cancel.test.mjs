import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { run } from '../lib/util/exec.js'
import { runIsp } from '../lib/isp.js'
import { captureSerial } from '../lib/serial.js'
import { logSerial } from '../lib/serial.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { buildToolSpecs } from '../lib/tools.js'
import { createLog, resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

const tempRoot = join(PACKAGE_ROOT, 'test/.tmp')
mkdirSync(tempRoot, { recursive: true })
const dir = mkdtempSync(join(tempRoot, 'cancel 中文 '))
after(() => { const target = resolve(dir); assert.ok(target.startsWith(resolve(tempRoot) + sep)); rmSync(target, { recursive: true, force: true }) })

test('process errors settle only on close, with error details preserved', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { end() {} }; child.kill = () => true
  let settled = false
  const pending = run('fake', [], {}, () => child).then(result => { settled = true; return result })
  child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('close', null, null)
  const result = await pending
  assert.match(result.error, /ENOENT/)
  assert.equal(result.processClosed, true)
})

test('pre-aborted operations never create a child or call either sidecar', async () => {
  const control = new AbortController(); control.abort()
  const process = await run('fake', [], { signal: control.signal }, () => assert.fail('spawned'))
  assert.equal(process.aborted, true)
  const isp = await runIsp({ action: 'chipinfo', port: 'COM9', signal: control.signal }, () => assert.fail('ISP sidecar called'))
  assert.equal(isp.error, 'CANCELLED')
  assert.equal(isp.hardwareAccess, false)
  assert.ok(captureSerial.length >= 2, 'serial dependency seam must exist before calling the fixture')
  const serial = await captureSerial({ port: 'COM9', signal: control.signal }, () => assert.fail('serial sidecar called'))
  assert.equal(serial.error, 'CANCELLED')
  assert.equal(serial.hardwareAccess, false)
})

test('cancel an actual Python lock holder, wait for close and reacquire its OS lease', async () => {
  const lockRoot = join(dir, 'node-python-lock')
  mkdirSync(lockRoot)
  const python = join(PACKAGE_ROOT, 'runtime/win32-x64/python.exe')
  const module = join(PACKAGE_ROOT, 'sidecar/port_session.py')
  const load = 'import importlib.util,sys,time\ns=importlib.util.spec_from_file_location("lease",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n'
  const hold = load + 'with m.PortLease("COM9","test",root=sys.argv[2]):\n print("ready",flush=True)\n time.sleep(30)\n'
  const control = new AbortController()
  const result = await run(python, ['-I', '-B', '-c', hold, module, lockRoot], {
    signal: control.signal, onStdout: () => control.abort(), timeoutMs: 5000,
  })
  assert.equal(result.aborted, true)
  assert.equal(result.processClosed, true)
  assert.match(result.stdout, /ready/)
  const check = await run(python, ['-I', '-B', '-c', load + 'with m.PortLease("COM9","test",root=sys.argv[2]):\n print("reacquired")\n', module, lockRoot], { timeoutMs: 5000 })
  assert.equal(check.code, 0, check.out)
  assert.match(check.stdout, /reacquired/)
})

test('cancelled ISP retains confirmed receipt, missing receipt after erase retains unknown state', async () => {
  for (const final of [true, false]) {
    const control = new AbortController()
    const result = await runIsp({ action: 'flash', port: 'COM9', mcu: 'IAP15F2K61S2', signal: control.signal }, async () => {
      control.abort()
      return { code: null, aborted: true, processClosed: true, stderr: '', stdout: final
        ? JSON.stringify({ event: 'result', ok: true, stage: 'complete', programmed: true, programAcknowledged: true })
        : JSON.stringify({ event: 'stage', stage: 'erase' }) }
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'CANCELLED')
    if (final) assert.equal(result.programAcknowledged, true)
    else assert.equal(result.eraseStarted, null)
  }
})

test('serial cancellation preserves confirmed sends and reports remaining transfer as uncertain', async () => {
  assert.ok(captureSerial.length >= 2, 'serial dependency seam must exist before calling the fixture')
  const control = new AbortController()
  const result = await captureSerial({ port: 'COM9', send: 'command', signal: control.signal }, async () => {
    control.abort()
    return { code: null, aborted: true, processClosed: true, stdout: [
      { event: 'stage', stage: 'sending' },
      { event: 'serial-sent', sent: { text: 'command', hex: '63', at: 1 } },
    ].map(event => JSON.stringify(event)).join('\n'), stderr: '' }
  })
  assert.equal(result.error, 'CANCELLED')
  assert.equal(result.sent.length, 1)
  assert.equal(result.transmitState, 'unknown-without-final-receipt')
  assert.equal(result.bytes, null)
})

test('stdin errors are reported after child close without an unhandled stream error', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
  child.stdin.end = () => {}; child.kill = () => true
  const pending = run('fake', [], { input: 'data' }, () => child)
  child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }))
  child.emit('close', 1, null)
  const result = await pending
  assert.match(result.error, /STDIN_EPIPE/)
  assert.equal(result.processClosed, true)
})

test('kill and progress callback errors preserve details and still wait for close', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} }
  child.kill = () => { throw new Error('kill rejected') }
  const control = new AbortController()
  let settled = false
  const pending = run('fake', [], { signal: control.signal, onStdout: () => { throw new Error('progress failed') } }, () => child)
    .then(result => { settled = true; return result })
  child.stdout.emit('data', Buffer.from('known output'))
  control.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('close', 0, null)
  const result = await pending
  assert.match(result.error, /OUTPUT_CALLBACK_FAILED/)
  assert.ok(result.errors.some(error => error.includes('KILL_FAILED')))
  assert.equal(result.processClosed, true)
})

test('a serial final receipt survives cancellation and its log keeps all transfer state', async () => {
  assert.ok(captureSerial.length >= 2)
  const control = new AbortController()
  const result = await captureSerial({ port: 'COM9', signal: control.signal }, async () => {
    control.abort()
    return { code: null, aborted: true, processClosed: true, stdout: JSON.stringify({ ok: true, bytes: 17,
      lines: [], sent: [{ text: 'known', hex: '01' }], session: { released: true } }), stderr: '' }
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'CANCELLED')
  assert.equal(result.bytes, 17)
  assert.equal(result.sent.length, 1)
  const path = logSerial(dir, result)
  const text = readFileSync(path, 'utf8')
  const receipt = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('# receipt=')).slice(10))
  assert.equal(receipt.error, 'CANCELLED')
  assert.equal(receipt.session.released, true)
  assert.deepEqual(receipt.sent, result.sent)
})

test('serial tool logging failure preserves the transfer receipt', async () => {
  const config = resolveConfig({ dataDir: join(dir, 'blocked-log') })
  writeFileSync(join(config.dataDir, 'logs'), 'block logs directory')
  let called = false
  const tool = buildToolSpecs({ defineTool: x => x, config, serialRunner: async () => {
    called = true
    return { ok: true, bytes: 2, lineCount: 1, printableRatio: 1, lines: [{ t: 0, text: 'OK' }], sent: [{ text: 'known' }] }
  } }).find(tool => tool.name === 'mcu_serial')
  // Invalid physical name is intentional: even a broken injection cannot open hardware.
  const result = await tool.execute({ port: 'SIMULATED' })
  assert.equal(called, true)
  assert.equal(result.ok, false)
  assert.equal(result.data.ok, true)
  assert.deepEqual(result.data.sent, [{ text: 'known' }])
  assert.ok(result.data.logError)
})

test('timeout preserves both an ISP completion receipt and a specific sidecar error', async () => {
  const result = await runIsp({ action: 'flash', port: 'COM9', mcu: 'IAP15F2K61S2' }, async () => ({
    code: 1, timedOut: true, processClosed: true, errors: ['KILL_FAILED: detail'], stdout: JSON.stringify({ event: 'result', ok: false,
      programmed: true, error: 'EXIT_FAILED', message: 'specific exit error' }), stderr: '',
  }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'TIMEOUT')
  assert.equal(result.programmed, true)
  assert.equal(result.sidecarError.error, 'EXIT_FAILED')
  assert.deepEqual(result.processErrors, ['KILL_FAILED: detail'])
})

test('parallel sessions finishing in the same millisecond cannot overwrite each other logs', () => {
  const RealDate = globalThis.Date
  try {
    globalThis.Date = class extends RealDate { constructor() { super('2026-10-26T00:00:00.000Z') } }
    const first = createLog(dir, 'same-tag')
    const second = createLog(dir, 'same-tag')
    first.write('first session'); second.write('second session')
    assert.notEqual(first.path, second.path)
    assert.equal(readFileSync(first.path, 'utf8'), 'first session')
    assert.equal(readFileSync(second.path, 'utf8'), 'second session')
  } finally { globalThis.Date = RealDate }
})
