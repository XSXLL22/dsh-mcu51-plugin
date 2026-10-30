import test from 'node:test'
import assert from 'node:assert/strict'
import { assessSerialRuntime, probeRuntime } from '../lib/runtime.js'
import { doctor, summarizeDoctor } from '../lib/doctor.js'
import { resolveConfig } from '../lib/config.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('low/untrusted runtime is reported without requesting elevation or changing lock roots', () => {
  for (const rid of [0, 4096, 8191]) {
    const got = assessSerialRuntime({ ok: true, supported: true, platform: 'win32', rid })
    assert.equal(got.ok, false)
    assert.equal(got.error, 'RUNTIME_LOW_INTEGRITY')
    assert.match(got.message, /普通用户应用目录/)
    assert.match(got.message, /无需管理员/)
  }
})

test('medium and higher pass only the process integrity preflight', () => {
  for (const rid of [8192, 8448, 12288, 16384]) {
    const got = assessSerialRuntime({ ok: true, supported: true, platform: 'win32', rid })
    assert.equal(got.ok, true)
    assert.match(got.scope, /no-port-or-lock-access/)
  }
})

test('query failure, missing and malformed metadata never claim serial readiness', () => {
  for (const info of [undefined, {}, { ok: false, message: 'injected WinError' },
    ...[undefined, -1, 1.2, '8192', 0x100000000].map(rid => ({ ok: true, supported: true, platform: 'win32', rid })),
    { ok: true, supported: false, platform: 'win32' }, { ok: true, supported: false }]) {
    assert.equal(assessSerialRuntime(info).error, 'RUNTIME_INTEGRITY_UNKNOWN')
  }
  assert.match(assessSerialRuntime({ ok: false, message: 'injected WinError' }).message, /injected WinError/)
  assert.equal(assessSerialRuntime({ ok: true, supported: false, platform: 'linux' }).applicable, false)
})

test('real bundled process returns checked integrity; doctor agrees without accessing hardware', async () => {
  const runtime = await probeRuntime()
  assert.equal(runtime.ok, true, JSON.stringify(runtime))
  assert.equal(runtime.integrity.ok, true)
  if (process.platform === 'win32') {
    assert.equal(runtime.integrity.supported, true)
    assert.ok(Number.isInteger(runtime.integrity.rid))
    assert.equal(runtime.serialAccess.ok, runtime.integrity.rid >= 8192)
    assert.equal(runtime.integrity.source, 'GetTokenInformation(TokenIntegrityLevel)')
  }
  const config = resolveConfig({ dataDir: mkdtempSync(join(tmpdir(), 'mcu51-integrity-')) })
  const result = await doctor({ config, dataDir: config.dataDir, serial: false })
  assert.equal(result.serial.source, 'skipped')
  assert.equal(result.capabilities.serial, runtime.serialAccess.ok)
  assert.equal(result.capabilities.isp.available, runtime.serialAccess.ok)
  assert.equal(result.ok, runtime.serialAccess.ok)
  assert.match(summarizeDoctor(result), /进程完整性/)
  if (!runtime.serialAccess.ok) assert.ok(result.issues.includes(runtime.serialAccess.message))
})
