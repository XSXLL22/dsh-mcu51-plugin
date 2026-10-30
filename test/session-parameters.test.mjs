import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIspParameters, prepareSerialSession, verifySerialPlan } from '../lib/session-parameters.js'
import { makeIspPlan } from '../lib/isp.js'
import { captureSerial } from '../lib/serial.js'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'
import { join } from 'node:path'

test('ISP parameters are strict and keep the verified transport fixed', () => {
  const options = normalizeIspParameters({ action: 'chipinfo', port: 'com9' })
  assert.equal(options.port, 'COM9')
  assert.equal(options.handshakeBaud, 2400)
  assert.equal(options.baud, 115200)
  for (const patch of [{ waitSeconds: '60' }, { waitSeconds: true }, { waitSeconds: 0.5 },
    { freqHz: '12000000' }, { debug: 'false' }, { port: 'COM9\n' }, { port: {} }, { baud: 9600 },
    { handshakeBaud: 4800 }, { action: 'other' }, { clockMode: null }]) {
    assert.throws(() => normalizeIspParameters({ action: 'chipinfo', port: 'COM9', ...patch }))
  }
  assert.equal(makeIspPlan({ action: 'chipinfo', port: 'com9', waitSeconds: 30 }).timeoutMs, 210000)
})

test('serial planner freezes exact UTF8/GBK/HEX bytes and accounts for every time component', async () => {
  const prepared = await prepareSerialSession({ port: 'com9', baud: 9600, seconds: 2,
    encoding: 'gbk', send: [{ text: '中', delayMs: 500 }], sendHex: ['00 ff'], openDelayMs: 100, openRetrySeconds: 1 })
  assert.equal(prepared.ok, true, prepared.message)
  const plan = prepared.plan
  assert.equal(plan.spec.send[0].hex, 'd6d00d0a')
  assert.equal(plan.spec.send[1].hex, '00ff')
  assert.equal(plan.spec.port, 'COM9')
  assert.equal(plan.budget.sendBytes, 6)
  assert.equal(plan.budget.sendDelaysMs, 500)
  assert.equal(plan.budget.openRetryMs, 1000)
  assert.equal(plan.budget.openDelayMs, 100)
  assert.equal(plan.budget.writeMs, 4000)
  assert.equal(plan.budget.wireMs, 7)
  assert.equal(plan.budget.timeoutMs, 27607)
  assert.equal(verifySerialPlan(plan, plan.sessionPlanId).ok, true)
  const whitespace = await prepareSerialSession({ port: 'COM9', send: ['  A  '], newline: 'none' })
  assert.equal(whitespace.plan.spec.send[0].hex, '2020412020')
})

test('malformed serial requests fail offline, including encoding, framing, payload and oversized budgets', async () => {
  for (const patch of [{ seconds: '5' }, { baud: true }, { seconds: 0 }, { autoBaud: 'false' },
    { dataBits: 9 }, { dataBits: 8, stopBits: 1.5 }, { dataBits: 5, stopBits: 2 }, { parity: 'X' },
    { rtscts: true }, { rtscts: true, xonxoff: true, noReset: false }, { encoding: 'ascii', send: ['中'] },
    { sendHex: ['GG'] }, { sendHex: ['0'] }, { untilRegex: '[' }, { maxBytes: 65537 }, { dataBits: 7, sendHex: ['ff'] },
    { baud: 1, sendHex: ['aa'.repeat(500)] }, { unknown: 1 }]) {
    const result = await prepareSerialSession({ port: 'COM9', ...patch })
    assert.equal(result.ok, false, JSON.stringify(patch).slice(0, 100))
    assert.equal(result.hardwareAccess, false)
  }
})

test('auto baud has explicit candidates and a complete probe/reopen budget', async () => {
  const result = await prepareSerialSession({ port: 'COM9', autoBaud: true, baudCandidates: [2400, 9600], trialSeconds: 0.5, openRetrySeconds: 2 })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.plan.spec.baud, 0)
  assert.equal(result.plan.budget.probeMs, 1000)
  assert.equal(result.plan.budget.openRetryMs, 6000)
  assert.equal((await prepareSerialSession({ port: 'COM9', autoBaud: true, baud: 9600 })).ok, false)
})

test('plan changes cannot silently change bytes, framing or timeout', async () => {
  const { plan } = await prepareSerialSession({ port: 'COM9', sendHex: ['aa'] })
  for (const change of [p => { p.spec.send[0].hex = 'bb' }, p => { p.spec.parity = 'E' }, p => { p.budget.timeoutMs++ }]) {
    const altered = structuredClone(plan); change(altered)
    assert.equal(verifySerialPlan(altered, plan.sessionPlanId).ok, false)
  }
})

test('dry run validates encoding but never calls the physical serial executor', async () => {
  const result = await captureSerial({ port: 'COM9', dryRun: true, encoding: 'utf-8', send: ['中'] }, () => assert.fail('physical executor called'))
  assert.equal(result.ok, true, result.message)
  assert.equal(result.hardwareAccess, false)
  assert.equal(result.dryRun, true)
  assert.equal(result.sessionPlan.spec.send[0].hex, 'e4b8ad0d0a')
  assert.equal((await captureSerial({ port: 'COM9', encoding: 'ascii', send: ['中'] }, () => assert.fail('invalid encoding reached serial'))).ok, false)
})

test('serial execution carries the bound plan and rejects mismatched success receipts without hiding sends', async () => {
  const result = await captureSerial({ port: 'COM9', sendHex: ['aa'] }, async (_script, request, settings) => {
    assert.equal(request.expectedSessionPlanId, request.sessionPlan.sessionPlanId)
    assert.equal(settings.timeoutMs, request.sessionPlan.budget.timeoutMs)
    return { code: 0, stdout: JSON.stringify({ ok: true, sent: [{ hex: 'aa' }], bytes: 0, sessionPlanId: 'wrong' }), stderr: '' }
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'SESSION_RECEIPT_MISMATCH')
  assert.equal(result.sent[0].hex, 'aa')
})

test('mcu_serial passes typed parameters through and reports dry-run success without requiring received data', async () => {
  const config = resolveConfig({ dataDir: join(PACKAGE_ROOT, 'test/.tmp/session-parameters-data') })
  let seen
  const tool = buildToolSpecs({ defineTool: x => x, config, serialRunner: async options => {
    seen = options; return { ok: true, dryRun: true, hardwareAccess: false, bytes: 0, sessionPlan: { spec: {}, budget: {} } }
  } }).find(spec => spec.name === 'mcu_serial')
  assert.equal((await tool.execute({ port: 'SIMULATED', seconds: '5', autoBaud: 'false', dataBits: 7, parity: 'E', stopBits: 2, dryRun: true, saveLog: false })).ok, true)
  assert.equal(seen.seconds, '5')
  assert.equal(seen.autoBaud, 'false')
  assert.equal(seen.parity, 'E')
  assert.equal(seen.dataBits, 7)
})

test('preflight cancellation and timeout stop before a physical session exists', async () => {
  const control = new AbortController()
  const cancelled = await prepareSerialSession({ port: 'COM9', signal: control.signal }, async () => {
    control.abort(); return { code: null, stdout: '', aborted: true }
  })
  assert.equal(cancelled.error, 'CANCELLED')
  assert.equal(cancelled.hardwareAccess, false)
  const timedOut = await prepareSerialSession({ port: 'COM9' }, async () => ({ code: null, stdout: '', timedOut: true }))
  assert.equal(timedOut.error, 'SESSION_PREFLIGHT_TIMEOUT')
  assert.equal(timedOut.hardwareAccess, false)
})
