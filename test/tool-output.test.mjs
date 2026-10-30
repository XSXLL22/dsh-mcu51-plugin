import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

test('tools without a log return lossless JSON instead of undefined optional fields', async () => {
  const config = resolveConfig({ dataDir: mkdtempSync(join(tmpdir(), 'mcu-output-')) })
  const tools = buildToolSpecs({ defineTool: value => value, config })
  const hex = join(config.dataDir, 'sample.hex')
  writeFileSync(hex, ':01000000AA55\n:00000001FF\n')
  for (const [name, args] of [['mcu_calc', { kind: 'baud', fosc: 12000000, baud: 2400 }], ['mcu_tone', { score: '1 2 3' }]]) {
    const result = await tools.find(tool => tool.name === name).execute(args)
    assert.equal(result.ok, true)
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)))
    assert.equal(Object.hasOwn(result, 'logPath'), false)
  }
  for (const [name, args] of [['mcu_flash', { hex, port: 'COM99', mcu: 'IAP15F2K61S2', dryRun: true }], ['mcu_chipinfo', { port: 'COM99', dryRun: true }]]) {
    const result = await tools.find(tool => tool.name === name).execute(args)
    assert.equal(result.ok, true)
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)))
  }
  const serial = await tools.find(tool => tool.name === 'mcu_serial').execute({ port: 'COM99', baud: 2400, dryRun: true })
  assert.equal(serial.ok, true)
  assert.deepEqual(serial, JSON.parse(JSON.stringify(serial)))
})
