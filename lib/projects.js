// 工程登记簿：把「名字 → 目录 / uvproj / 芯片 / 主频 / 串口」记住，build / flash 就不用每次问路径。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadProjects, saveProjects } from './config.js'
import { resolveProjectTarget, locateHex } from './build.js'

const HEADER_HINTS = [
  { re: /STC15F2K60S2\.H|STC15F2K61S2/i, mcu: 'IAP15F2K61S2', board: 'CT107D', fosc: 12_000_000 },
  { re: /STC15W|STC15L|STC15F/i, mcu: 'STC15', board: 'CT107D', fosc: 12_000_000 },
  { re: /STC8[HAG]/i, mcu: 'STC8', board: null, fosc: 11_059_200 },
  { re: /REGX52\.H|REG52\.H|AT89X52|STC89/i, mcu: 'STC89C52RC', board: 'PREICHIN', fosc: 11_059_200 },
]

/** 从工程源码里猜芯片 / 主频 / 板子。 */
export function detectProjectFacts(dir) {
  const files = []
  const walk = (current, depth) => {
    if (depth > 3 || files.length > 60) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (/^(Objects|Listings|Backup|\.git|node_modules)$/i.test(entry.name)) continue
        walk(full, depth + 1)
      } else if (/\.(c|h)$/i.test(entry.name)) {
        files.push(full)
      }
    }
  }
  walk(dir, 0)

  let header = null
  let fosc = null
  let uartBaud = null
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!header) header = HEADER_HINTS.find((h) => h.re.test(text)) ?? null
    if (fosc === null) {
      const m = /#define\s+FOSC\s+(\d+)/i.exec(text)
      if (m) fosc = Number(m[1])
    }
    if (uartBaud === null) {
      const m = /#define\s+(?:UART_)?BAUD\w*\s+(\d+)/i.exec(text)
      if (m) uartBaud = Number(m[1])
    }
  }
  return {
    mcu: header?.mcu ?? null,
    board: header?.board ?? null,
    fosc: fosc ?? header?.fosc ?? null,
    uartBaud,
    sourceFiles: files.length,
  }
}

/** 登记一个工程（可只给目录）。 */
export function registerProject(dataDir, input) {
  const target = resolveProjectTarget(input.dir)
  if (!target.ok) return { ok: false, error: target.reason }
  const facts = detectProjectFacts(target.dir)
  const hex = locateHex(target.dir, target.uvproj)
  const name = input.name ?? target.dir.split(/[\\/]/).filter(Boolean).pop()
  const registry = loadProjects(dataDir)
  registry.projects[name] = {
    name,
    dir: target.dir,
    uvproj: target.uvproj,
    mcu: input.mcu ?? facts.mcu ?? null,
    board: input.board ?? facts.board ?? null,
    fosc: Number(input.fosc ?? facts.fosc ?? 0) || null,
    port: input.port ?? null,
    baud: Number(input.baud ?? facts.uartBaud ?? 0) || null,
    hex: hex.path ?? null,
    updatedAt: new Date().toISOString(),
  }
  saveProjects(dataDir, registry)
  return { ok: true, project: registry.projects[name], detected: facts }
}

/** 按名字或路径解析工程（先查登记簿，再当路径用）。 */
export function findProject(dataDir, nameOrPath) {
  const registry = loadProjects(dataDir)
  const hit = registry.projects?.[nameOrPath]
  if (hit) return { ok: true, ...hit, registered: true }
  if (nameOrPath && existsSync(nameOrPath)) {
    const target = resolveProjectTarget(nameOrPath)
    if (target.ok) {
      const facts = detectProjectFacts(target.dir)
      return { ok: true, name: nameOrPath, dir: target.dir, uvproj: target.uvproj, ...facts, registered: false }
    }
  }
  return { ok: false, error: `登记簿里没有「${nameOrPath}」，也不是能打开的路径；先 mcu_project add 一下` }
}

/** 列出登记簿里的工程，顺带刷新 hex 状态。 */
export function listProjects(dataDir) {
  const registry = loadProjects(dataDir)
  const items = Object.values(registry.projects ?? {})
  return items.map((item) => {
    let hex = null
    try {
      if (item.uvproj && existsSync(item.uvproj)) {
        const located = locateHex(item.dir, item.uvproj)
        if (located.path) {
          const stat = statSync(located.path)
          hex = { path: located.path, mtime: new Date(stat.mtimeMs).toISOString(), sizeBytes: stat.size }
        }
      }
    } catch {
      hex = null
    }
    return { ...item, hex }
  })
}

export function removeProject(dataDir, name) {
  const registry = loadProjects(dataDir)
  if (!registry.projects?.[name]) return { ok: false, error: `没有登记「${name}」` }
  delete registry.projects[name]
  saveProjects(dataDir, registry)
  return { ok: true, removed: name }
}

export { resolveProjectTarget }
