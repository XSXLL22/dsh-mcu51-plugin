import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflightHex, summarizeFlash } from '../lib/flash.js'
import { parseIntelHex } from '../lib/build.js'
import { bundledRuntime, probeRuntime } from '../lib/runtime.js'
import { protocolForMcu } from '../lib/isp.js'
import { buildToolSpecs, registerTools } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

test('GUI launch evidence must never be presented as a successful flash', () => {
  // Real recorded result: the board was not programmed by this call.
  const summary = summarizeFlash({ ok: true, flasher: 'stcisp-gui', nextAction: '点下载并按板载下载键' })
  assert.doesNotMatch(summary, /烧录成功/)
  assert.match(summary, /未确认|未完成|待人工/)
})

const fixtureDir = mkdtempSync(join(tmpdir(), 'mcu51-hex-'))
for (const [name, content, capacity] of [
  ['bad-checksum', ':01000000AA00\n:00000001FF\n', 8],
  ['no-eof', ':01000000AA55\n', 8],
  ['no-data', ':00000001FF\n', 8],
  ['address-overflow', ':020000040001F9\n:01000000AA55\n:00000001FF\n', 8],
  ['truncated-record', ':02000000AA54\n:00000001FF\n', 8],
]) {
  test(`flash preflight rejects ${name}`, () => {
    const path = join(fixtureDir, `${name}.hex`)
    writeFileSync(path, content)
    assert.equal(preflightHex(path, capacity).ok, false)
  })
}

test('STC15 model maps to the correct protocol', () => {
  assert.equal(protocolForMcu('IAP15F2K61S2'), 'stc15')
  assert.equal(protocolForMcu('STC15F104E'), 'stc15a')
  assert.equal(protocolForMcu('STC89C52RC'), 'stc89')
  assert.throws(() => protocolForMcu('STC8H1K08'), /未验证/)
})

test('Intel HEX extended linear address is unsigned', () => {
  const info = parseIntelHex(':0200000480007A\n:01000000AA55\n:00000001FF\n')
  assert.equal(info.maxAddr, 0x80000000)
})

test('missing bundled runtime is an error even on a machine with Python installed', () => {
  assert.equal(bundledRuntime(fixtureDir).error, 'BUNDLED_RUNTIME_MISSING')
})

test('runtime ignores hostile system/user Python paths', async () => {
  const previous = { PATH: process.env.PATH, PYTHONPATH: process.env.PYTHONPATH, PYTHONHOME: process.env.PYTHONHOME }
  try {
    process.env.PATH = ''
    process.env.PYTHONPATH = fixtureDir
    process.env.PYTHONHOME = fixtureDir
    const result = await probeRuntime()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.isolated, 1)
    assert.ok(result.paths.every((path) => path.startsWith(PACKAGE_ROOT)))
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('all 12 tools register and dispose, with self-contained dry-run plans', async () => {
  const config = resolveConfig({ dataDir: fixtureDir })
  const specs = buildToolSpecs({ defineTool: (spec) => spec, config })
  assert.equal(specs.length, 12)
  const valid = join(fixtureDir, 'valid.hex')
  writeFileSync(valid, ':01000000AA55\n:00000001FF\n')
  const flash = specs.find((spec) => spec.name === 'mcu_flash')
  const result = await flash.execute({ hex: valid, port: 'COM9', mcu: 'IAP15F2K61S2', dryRun: true })
  assert.equal(result.ok, true, result.summary)
  assert.equal(result.data.plan.protocol, 'stc15')
  assert.deepEqual(result.data.plan.requires, { powerCycle: true, uac: false, clickDownload: false, externalSoftware: false })
  assert.equal((await flash.execute({ flasher: 'stcisp-gui' })).ok, false)
  assert.equal((await flash.execute({ verify: true })).ok, false)
  const chipinfo = await specs.find((spec) => spec.name === 'mcu_chipinfo').execute({ port: 'COM9', dryRun: true })
  assert.equal(chipinfo.data.plan.protocol, 'auto')
  let disposed = 0
  const dispose = registerTools({ defineTool: (spec) => spec, tools: { register: () => () => disposed++ } }, { dataDir: fixtureDir })
  assert.equal(dispose.toolNames.length, 12)
  assert.ok(dispose.toolNames.includes('mcu_catalog'))
  dispose()
  assert.ok(dispose.toolNames.includes('mcu_image'))
  assert.equal(disposed, 12)
})
