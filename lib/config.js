// 配置与数据目录：路径探测、boards/projects 读写、日志落盘。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 数据目录：显式配置 > 环境变量 > ~/.dsh-mcu51 */
export function resolveDataDir(configured) {
  const raw = configured ?? process.env.DSH_MCU51_DATA ?? join(homedir(), '.dsh-mcu51')
  const dir = resolve(raw)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`无法读取配置 ${path}：${error.message}`, { cause: error })
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 随插件发布的板级事实（只读模板）。 */
export function shippedBoards() {
  return readJson(join(PACKAGE_ROOT, 'data', 'boards.json'), { boards: [] })
}

/** 用户侧覆盖（dataDir/boards.local.json），合并到随包数据之上。 */
export function loadBoards(dataDir) {
  const shipped = shippedBoards()
  const local = readJson(join(dataDir, 'boards.local.json'), null)
  if (!local || !Array.isArray(local.boards)) return shipped
  const byId = new Map((shipped.boards ?? []).map((b) => [b.id, b]))
  for (const board of local.boards) {
    if (board && board.id) byId.set(board.id, { ...(byId.get(board.id) ?? {}), ...board })
  }
  return { ...shipped, boards: [...byId.values()] }
}

/** 已登记的工程（dataDir/projects.json）。 */
export function loadProjects(dataDir) {
  return readJson(join(dataDir, 'projects.json'), { projects: {} })
}

export function saveProjects(dataDir, value) {
  writeJson(join(dataDir, 'projects.json'), value)
}

/** 工具链探测缓存（dataDir/toolchain.json）。 */
export function loadToolchainCache(dataDir) {
  return readJson(join(dataDir, 'toolchain.json'), {})
}

export function saveToolchainCache(dataDir, value) {
  writeJson(join(dataDir, 'toolchain.json'), value)
}

/** 一次调用一份日志文件，返回 {path, write, writeLine}。 */
export function createLog(dataDir, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(dataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${stamp}-${tag}-${randomUUID()}.log`)
  writeFileSync(path, '', { flag: 'wx' })
  const chunks = []
  return {
    path,
    write(text) {
      chunks.push(text)
      writeFileSync(path, chunks.join('\n'), 'utf8')
      return path
    },
    writeRaw(text) {
      chunks.push(text)
      writeFileSync(path, chunks.join('\n'), 'utf8')
      return path
    },
  }
}

/** 把 config 与应用默认值合成最终配置。 */
export function resolveConfig(config = {}) {
  const dataDir = resolveDataDir(config.dataDir)
  return {
    dataDir,
    keilPath: config.keilPath ?? null,
    defaultPort: config.defaultPort ?? null,
    defaultMcu: config.defaultMcu ?? null,
    serialBauds: Array.isArray(config.serialBauds) && config.serialBauds.length ? config.serialBauds : [9600, 2400, 115200, 4800],
    flashWaitSeconds: config.flashWaitSeconds ?? 60,
    searchRoots: Array.isArray(config.searchRoots) ? config.searchRoots : [],
    projectsRoots: Array.isArray(config.projectsRoots) ? config.projectsRoots : [],
  }
}

/** 路径归一化：相对路径按给定基准目录解析。 */
export function absolutize(path, base) {
  if (!path) return null
  return isAbsolute(path) ? resolve(path) : resolve(base ?? process.cwd(), path)
}

/** 递归找文件（限深度，跳过常见垃圾目录）。 */
export function findFiles(root, predicate, options = {}) {
  const maxDepth = options.maxDepth ?? 4
  const limit = options.limit ?? 200
  const skip = new Set(['node_modules', '.git', 'Objects', 'Listings', 'Backup', '$RECYCLE.BIN', 'System Volume Information'])
  const found = []
  const walk = (dir, depth) => {
    if (found.length >= limit || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
      } else if (entry.isFile() && predicate(full, entry.name)) {
        found.push(full)
      }
    }
  }
  if (existsSync(root)) walk(root, 0)
  return found
}

/** 文件 mtime（毫秒），失败返回 0。 */
export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export { readJson, writeJson }
