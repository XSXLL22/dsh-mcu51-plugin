// Keil C51 编译：定位 uvproj、跑 UV4 -b、解析错误与 Program Size、校验产物 hex。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { run } from './util/exec.js'
import { mtimeMs } from './config.js'

const UV4_EXIT = {
  0: '无错误无警告',
  1: '有警告',
  2: '有错误',
  3: '致命错误',
  11: '无法打开工程文件',
  12: '器件库错误',
  13: '无法写输出文件',
  15: '无法读文件',
  20: '许可证错误',
}

/** 解析 Intel HEX，返回数据字节数与地址范围，同时校验记录校验和。 */
export function parseIntelHex(text) {
  let base = 0
  let bytes = 0
  let minAddr = Number.POSITIVE_INFINITY
  let maxAddr = -1
  let checksumErrors = 0
  let records = 0
  let eof = false
  const lines = String(text).split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!/^:[0-9a-f]+$/i.test(line) || line.length < 11 || eof) {
      checksumErrors += 1
      continue
    }
    const byteCount = Number.parseInt(line.slice(1, 3), 16)
    const address = Number.parseInt(line.slice(3, 7), 16)
    const recordType = Number.parseInt(line.slice(7, 9), 16)
    const fixedLength = { 1: 0, 2: 2, 3: 4, 4: 2, 5: 4 }
    if (line.length !== 11 + byteCount * 2 || recordType > 5 ||
        (recordType in fixedLength && (byteCount !== fixedLength[recordType] || address !== 0))) {
      checksumErrors += 1
      continue
    }
    if (!Number.isFinite(byteCount) || !Number.isFinite(address) || !Number.isFinite(recordType)) {
      checksumErrors += 1
      continue
    }
    const dataHex = line.slice(9, 9 + byteCount * 2)
    let sum = byteCount + (address >> 8) + (address & 0xff) + recordType
    const data = Buffer.from(dataHex, 'hex')
    for (const b of data) sum += b
    const checksum = Number.parseInt(line.slice(9 + byteCount * 2, 11 + byteCount * 2), 16)
    if (((sum + checksum) & 0xff) !== 0) checksumErrors += 1
    records += 1
    if (recordType === 0) {
      bytes += byteCount
      if (byteCount) {
        minAddr = Math.min(minAddr, base + address)
        maxAddr = Math.max(maxAddr, base + address + byteCount - 1)
      }
    } else if (recordType === 1) {
      eof = true
    } else if (recordType === 2) {
      base = Buffer.from(dataHex, 'hex').readUInt16BE(0) << 4
    } else if (recordType === 4) {
      base = Buffer.from(dataHex, 'hex').readUInt16BE(0) * 65536
    }
  }
  return {
    ok: checksumErrors === 0 && eof,
    records,
    bytes,
    minAddr: Number.isFinite(minAddr) ? minAddr : null,
    maxAddr: maxAddr >= 0 ? maxAddr : null,
    span: maxAddr >= 0 && Number.isFinite(minAddr) ? maxAddr - minAddr + 1 : 0,
    checksumErrors,
    eof,
  }
}

/** 解析 Keil build log。 */
export function parseBuildLog(text) {
  const errors = []
  const warnings = []
  let size = null
  let targetCreated = true
  const lines = String(text).split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue
    const withLoc = /^(.*?)\((\d+)\):\s*(error|warning|fatal error)\s+([A-Z]\d+)\s*:\s*(.*)$/i.exec(line)
    if (withLoc) {
      const item = {
        file: withLoc[1].trim(),
        line: Number(withLoc[2]),
        severity: withLoc[3].toLowerCase(),
        code: withLoc[4].toUpperCase(),
        message: withLoc[5].trim(),
        raw: line,
      }
      if (item.severity === 'warning') warnings.push(item)
      else errors.push(item)
      continue
    }
    const toolError = /^\*\*\*\s*(ERROR|WARNING|FATAL ERROR)\s+([A-Z]\d+)\s*:\s*(.*)$/i.exec(line)
    if (toolError) {
      const item = {
        file: null,
        line: null,
        severity: toolError[1].toLowerCase(),
        code: toolError[2].toUpperCase(),
        message: toolError[3].trim(),
        raw: line,
      }
      if (item.severity === 'warning') warnings.push(item)
      else errors.push(item)
      continue
    }
    const sizeMatch = /Program Size:\s*data=(\d+)(?:\.\d+)?\s*xdata=(\d+)\s*code=(\d+)/i.exec(line)
    if (sizeMatch) {
      size = { data: Number(sizeMatch[1]), xdata: Number(sizeMatch[2]), code: Number(sizeMatch[3]) }
      continue
    }
    if (/Target not created/i.test(line)) targetCreated = false
  }
  return { errors, warnings, size, targetCreated }
}

/** 从 uvproj 里读输出名、输出目录、CreateHexFile。 */
export function parseUvproj(uvprojPath) {
  let xml = ''
  try {
    xml = readFileSync(uvprojPath, 'utf8')
  } catch {
    return { outputName: null, outputDir: null, createHex: null }
  }
  const pick = (tag) => {
    const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(xml)
    return m ? m[1] : null
  }
  return {
    outputName: pick('OutputName'),
    outputDir: pick('OutputDirectory'),
    createHex: pick('CreateHexFile') === '1',
    targetName: pick('TargetName'),
  }
}

/** 收集工程源码的最新修改时间（用来判断 hex 是否过期）。 */
function newestSourceMtime(projectDir) {
  let newest = 0
  let count = 0
  const walk = (dir, depth) => {
    if (depth > 5) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/^(Objects|Listings|Backup|\.git|node_modules)$/i.test(entry.name)) continue
        walk(full, depth + 1)
      } else if (/\.(c|h|a51|s)$/i.test(entry.name)) {
        count += 1
        newest = Math.max(newest, mtimeMs(full))
      }
    }
  }
  walk(projectDir, 0)
  return { newest, count }
}

/** 解析工程参数：目录 / uvproj / 名字，都能定位。 */
export function resolveProjectTarget(project) {
  if (!project) return { ok: false, reason: '未提供工程路径' }
  const abs = resolve(project)
  if (!existsSync(abs)) return { ok: false, reason: `路径不存在：${abs}` }
  const stat = statSync(abs)
  if (stat.isFile()) {
    if (!/\.uvproj$/i.test(abs)) return { ok: false, reason: `不是 .uvproj：${abs}` }
    return { ok: true, uvproj: abs, dir: dirname(abs) }
  }
  const candidates = []
  const walk = (dir, depth) => {
    if (depth > 3 || candidates.length > 12) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (/^(Objects|Listings|Backup|\.git|node_modules)$/i.test(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (/\.uvproj$/i.test(entry.name)) {
        candidates.push(join(dir, entry.name))
      }
    }
  }
  walk(abs, 0)
  if (candidates.length === 0) return { ok: false, reason: `目录下没有 .uvproj：${abs}` }
  const preferred = candidates.find((p) => /\\User\\/i.test(p)) ?? candidates.find((p) => /project\.uvproj$/i.test(p)) ?? candidates[0]
  return { ok: true, uvproj: preferred, dir: dirname(preferred), candidates }
}

/** 找产物 hex（优先工程声明的输出路径，其次全目录最新）。 */
export function locateHex(projectDir, uvproj) {
  const info = uvproj ? parseUvproj(uvproj) : { outputName: null, outputDir: null }
  const declared = []
  if (info.outputName && info.outputDir) {
    declared.push(resolve(projectDir, info.outputDir, `${info.outputName}.hex`))
  }
  if (info.outputName) {
    declared.push(join(projectDir, 'Objects', `${info.outputName}.hex`))
    declared.push(join(projectDir, `${info.outputName}.hex`))
  }
  for (const candidate of declared) {
    if (existsSync(candidate)) return { path: candidate, source: 'uvproj', declared }
  }
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/^(Backup|\.git|node_modules)$/i.test(entry.name)) continue
        walk(full, depth + 1)
      } else if (/\.hex$/i.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(projectDir, 0)
  if (found.length === 0) return { path: null, source: 'none', declared }
  found.sort((a, b) => mtimeMs(b) - mtimeMs(a))
  return { path: found[0], source: 'scan', declared, all: found.slice(0, 8) }
}

/**
 * 编译一个 Keil 工程。
 * @param {{project: string, rebuild?: boolean, keilPath?: string, timeoutMs?: number, flashKB?: number, logPath?: string, signal?: AbortSignal}} args
 */
export async function buildProject(args) {
  const target = resolveProjectTarget(args.project)
  if (!target.ok) return { ok: false, reason: target.reason, errors: [], warnings: [] }

  if (!args.keilPath || !existsSync(args.keilPath)) {
    return { ok: false, reason: '找不到 UV4.exe（Keil C51）', errors: [], warnings: [], project: target }
  }

  const logPath = args.logPath ?? join(args.dataDir ?? target.dir, '.mcu51-build.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const uvArgs = ['-b', target.uvproj]
  if (args.rebuild) uvArgs.push('-r')
  uvArgs.push('-j0', '-o', logPath)

  const result = await run(args.keilPath, uvArgs, {
    cwd: target.dir,
    timeoutMs: args.timeoutMs ?? 240_000,
    signal: args.signal,
  })

  let logText = ''
  try {
    logText = readFileSync(logPath, 'utf8')
  } catch {
    logText = result.out
  }
  const parsed = parseBuildLog(logText)
  const codeSize = parsed.size?.code ?? null
  const flashKB = args.flashKB ?? null
  const overflow = codeSize !== null && flashKB ? codeSize > flashKB * 1024 : null

  const located = locateHex(target.dir, target.uvproj)
  let hex = null
  if (located.path) {
    try {
      const text = readFileSync(located.path, 'latin1')
      const info = parseIntelHex(text)
      const uvInfo = parseUvproj(target.uvproj)
      hex = {
        path: located.path,
        source: located.source,
        sizeBytes: statSync(located.path).size,
        dataBytes: info.bytes,
        minAddr: info.minAddr === null ? null : `0x${info.minAddr.toString(16).toUpperCase()}`,
        maxAddr: info.maxAddr === null ? null : `0x${info.maxAddr.toString(16).toUpperCase()}`,
        checksumOk: info.checksumErrors === 0 && info.eof,
        checksumErrors: info.checksumErrors,
        createHexFlag: uvInfo.createHex,
        mtime: new Date(mtimeMs(located.path)).toISOString(),
      }
    } catch (error) {
      hex = { path: located.path, error: String(error?.message ?? error) }
    }
  }

  const sources = newestSourceMtime(target.dir)
  const stale = hex && sources.newest ? mtimeMs(located.path) + 1500 < sources.newest : null

  const ok = result.code === 0 || (result.code === 1 && parsed.errors.length === 0 && parsed.targetCreated)
  return {
    ok,
    exitCode: result.code,
    exitMeaning: UV4_EXIT[result.code] ?? '未知退出码',
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    project: {
      uvproj: target.uvproj,
      dir: target.dir,
      outputName: parseUvproj(target.uvproj).outputName,
      flashKB,
    },
    errors: parsed.errors,
    warnings: parsed.warnings,
    size: parsed.size,
    overflow,
    hex,
    hexStale: stale,
    sourceFiles: sources.count,
    logPath,
    stdout: result.out,
  }
}

/** 把编译结果写成一段人可读的摘要（给工具 render 用）。 */
export function summarizeBuild(result) {
  if (!result.ok && result.reason) return `❌ ${result.reason}`
  const lines = []
  lines.push(`${result.ok ? '✅ 编译通过' : '❌ 编译失败'}（退出码 ${result.exitCode}：${result.exitMeaning}，${(result.durationMs / 1000).toFixed(1)}s）`)
  lines.push(`工程：${result.project?.uvproj}`)
  if (result.size) {
    lines.push(`Program Size：data=${result.size.data}  xdata=${result.size.xdata}  code=${result.size.code}` + (result.project?.flashKB ? `  / ${result.project.flashKB * 1024} 字节 Flash` : ''))
  }
  if (result.overflow) lines.push(`⚠️ code 段已超出芯片 Flash 容量`)
  if (result.errors.length) {
    lines.push(`错误 ${result.errors.length} 条：`)
    for (const e of result.errors.slice(0, 12)) lines.push(`  - ${formatDiagnostic(e)}`)
    if (result.errors.length > 12) lines.push(`  … 其余 ${result.errors.length - 12} 条见日志`)
  }
  if (result.warnings.length) {
    lines.push(`警告 ${result.warnings.length} 条（前 6）：`)
    for (const w of result.warnings.slice(0, 6)) lines.push(`  - ${formatDiagnostic(w)}`)
  }
  if (result.hex) lines.push(`产物：${result.hex.path}（${result.hex.dataBytes ?? '?'} 字节数据，${result.hex.mtime ?? ''}）`)
  if (result.hexStale) lines.push('⚠️ hex 比源码旧，可能烧到的是旧程序')
  lines.push(`日志：${result.logPath}`)
  return lines.join('\n')
}

export function formatDiagnostic(item) {
  const head = item.file ? `${basename(item.file)}(${item.line})` : '链接/工具链'
  return `${head}: ${item.severity} ${item.code}: ${item.message}`
}

export { writeFileSync }
