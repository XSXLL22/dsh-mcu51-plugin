// Optional compiler discovery and bundled-runtime serial enumeration.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { which } from './util/exec.js'
import { runSidecar } from './runtime.js'

const cache = new Map()
export function resetDiscoveryCache() { cache.clear() }
const isFile = (path) => {
  try { return !!path && statSync(path).isFile() } catch { return false }
}

export async function detectKeil(config = {}) {
  const key = JSON.stringify([config.keilPath, process.env.KEIL_PATH])
  if (cache.has(key)) return cache.get(key)
  const candidates = [
    config.keilPath, process.env.KEIL_PATH,
    ...['C', 'D', 'E', 'F'].flatMap((drive) => [drive + ':\\Keil_v5\\UV4\\UV4.exe', drive + ':\\Keil\\UV4\\UV4.exe']),
    join(homedir(), 'Keil_v5', 'UV4', 'UV4.exe'),
  ]
  const path = candidates.find(isFile) ?? await which('UV4.exe')
  const result = { ok: !!path && existsSync(path), path: path ?? null, optional: true }
  cache.set(key, result)
  return result
}

export async function listSerialPorts() {
  const child = await runSidecar('ports.py', {}, { timeoutMs: 15_000 })
  try {
    const result = JSON.parse(child.stdout.trim())
    if (child.code !== 0 || !result.ok) throw new Error(result.message || child.out)
    return { ...result, source: 'bundled-pyserial' }
  } catch (error) {
    return { ok: false, source: 'bundled-pyserial', items: [], error: String(error.message || child.error || child.out) }
  }
}
