import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../lib/config.js'
import { run } from '../lib/util/exec.js'

test('a relocated plugin runs glyph and all offline smoke cases without PATH or system Python', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcu51 relocated 中文 '))
  const copy = join(root, 'plugin with spaces')
  cpSync(PACKAGE_ROOT, copy, { recursive: true, filter: (source) => !source.includes('node_modules') && !source.includes('__pycache__') && !source.split(/[\\/]/).includes('.tmp') })
  const result = await run(process.execPath, ['test/smoke.mjs'], {
    cwd: copy,
    timeoutMs: 45_000,
    env: { ...process.env, PATH: '', PYTHONHOME: root, PYTHONPATH: root, DSH_MCU51_DATA: join(root, 'user data') },
  })
  assert.equal(result.code, 0, result.out)
  assert.match(result.stdout, /失败 0 个/)
  assert.match(result.stdout, /内置协议：stc15/)
  assert.match(result.stdout, /每字 32 字节/)
  assert.doesNotMatch(result.stdout, /SIDECAR_FAILED|NO_PYTHON|Traceback/)
})
