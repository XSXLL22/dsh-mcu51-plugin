// 脱离 DSH 的自测：用假的 defineTool 走一遍 schema 编译与 execute。
// 用法：node test/smoke.mjs [toolName ...]
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { buildToolSpecs } from '../lib/tools.js'
import { resolveConfig, PACKAGE_ROOT } from '../lib/config.js'

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])
const KEYS = new Set(['type', 'description', 'required', 'items', 'properties', 'additionalProperties', 'enum', 'const', 'oneOf', 'title', 'default', 'examples'])

function validateSchema(node, path) {
  if (!node || typeof node !== 'object') throw new Error(`${path} 不是对象`)
  if (!TYPES.has(node.type)) throw new Error(`${path}.type 非法：${node.type}`)
  for (const key of Object.keys(node)) if (!KEYS.has(key)) throw new Error(`${path}.${key} 不被 DSL 支持`)
  if (node.required !== undefined && node.required !== true) throw new Error(`${path}.required 只能是 true`)
  if (node.type === 'object' && node.properties) {
    for (const [key, child] of Object.entries(node.properties)) validateSchema(child, `${path}.properties.${key}`)
  }
  if (node.type === 'array') {
    if (!node.items) throw new Error(`${path}.items 缺失`)
    validateSchema(node.items, `${path}.items`)
  }
}

function validateTool(spec) {
  if (!spec.name) throw new Error('工具缺 name')
  if (!spec.description) throw new Error(`${spec.name} 缺 description`)
  for (const [key, child] of Object.entries(spec.parameters ?? {})) validateSchema(child, `${spec.name}.parameters.${key}`)
  validateSchema(spec.output.schema, `${spec.name}.output.schema`)
  if (typeof spec.output.render !== 'function') throw new Error(`${spec.name} 缺 render`)
  if (typeof spec.execute !== 'function') throw new Error(`${spec.name} 缺 execute`)
}

const definitions = []
const defineTool = (spec) => {
  validateTool(spec)
  definitions.push(spec)
  return spec
}

const config = resolveConfig(
  process.env.DSH_MCU51_DATA ? { dataDir: process.env.DSH_MCU51_DATA } : { dataDir: join(tmpdir(), 'dsh-mcu51-smoke') },
)
const specs = buildToolSpecs({ defineTool, config })
const byName = new Map(specs.map((s) => [s.name, s]))
const sampleHex = join(config.dataDir, 'smoke.hex')
writeFileSync(sampleHex, ':01000000AA55\n:00000001FF\n')

const CASES = {
  mcu_doctor: {},
  mcu_build: { project: process.env.DSH_MCU51_SMOKE_PROJECT ?? '' },
  mcu_flash: { hex: sampleHex, port: 'COM9', mcu: 'IAP15F2K61S2', dryRun: true },
  mcu_chipinfo: { port: 'COM9', dryRun: true },
  mcu_options: { action: 'schema' },
  mcu_catalog: { action: 'memory', id: 'stc675:8' },
  mcu_image: { action: 'compose', sources: [{ path: sampleHex }] },
  mcu_serial: { port: 'COM9', seconds: 2, baud: 9600, dryRun: true },
  mcu_calc: { kind: 'baud', fosc: 12000000, baud: 2400 },
  mcu_glyph: { text: '中', size: '16x16' },
  mcu_tone: { score: '1 1 5 5 6 6 5-' },
  mcu_project: { action: 'list' },
}

const wanted = process.argv.slice(2)
const run = wanted.length ? wanted : Object.keys(CASES).filter((name) => name !== 'mcu_build')

let failed = 0
let calls = 0
for (const name of run) {
  const spec = byName.get(name)
  if (!spec) {
    console.error(`✗ 没有这个工具：${name}`)
    failed += 1
    continue
  }
  if (!CASES[name]) {
    console.log(`\n=== ${name}（没有默认用例，跳过）`)
    continue
  }
  const started = Date.now()
  const value = await spec.execute(CASES[name], { signal: new AbortController().signal, agent: { id: 'smoke' } })
  calls++
  const ms = Date.now() - started
  const badge = value.ok ? '✓' : '✗'
  if (!value.ok) failed += 1
  console.log(`\n=== ${name} ${badge} (${ms}ms)`)
  console.log(String(value.summary ?? '').slice(0, 2500))
  if (name === 'mcu_image' && value.ok) {
    const planned = await spec.execute({ action: 'plan', image: value.logPath, expectedImageId: value.data.imageId,
      targetId: 'stc675:8', bslVersion: '7.2.5S', erasePolicy: 'code' })
    calls++
    if (!planned.ok) failed++
    console.log(`\n=== mcu_image plan ${planned.ok ? '✓' : '✗'}`)
    console.log(String(planned.summary ?? '').slice(0, 2500))
    if (planned.ok) {
      const prepared = await spec.execute({ action: 'prepare', image: value.logPath, expectedImageId: value.data.imageId,
        targetId: 'stc675:8', bslVersion: '7.2.5S', erasePolicy: 'code', expectedMemoryPlanId: planned.data.memoryPlanId,
        snapshot: join(PACKAGE_ROOT, 'test/fixtures/stc15-options-status.json'), recoveryHex: sampleHex, port: 'COM9', freqHz: 12000000 })
      calls++
      if (!prepared.ok) failed++
      console.log(`\n=== mcu_image prepare ${prepared.ok ? '✓' : '✗'}`)
      console.log(String(prepared.summary ?? '').slice(0, 2500))
      if (prepared.ok) {
        const checked = await byName.get('mcu_flash').execute({ memoryApplication: prepared.logPath,
          expectedMemoryApplicationId: prepared.data.applicationId, dryRun: true })
        calls++
        if (!checked.ok) failed++
        console.log(`\n=== mcu_flash memory dryRun ${checked.ok ? '✓' : '✗'}`)
        console.log(String(checked.summary ?? '').slice(0, 2500))
      }
    }
  }
}

console.log(`\n共 ${calls} 个调用，失败 ${failed} 个；工具总数 ${specs.length}：${specs.map((s) => s.name).join(', ')}`)
process.exitCode = failed ? 1 : 0
