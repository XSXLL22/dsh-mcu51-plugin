// Flash preflight and summaries. Programming uses the bundled open protocol
// engine in isp.js; there is no vendor executable or GUI automation path.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { parseIntelHex, locateHex, resolveProjectTarget } from './build.js'

export function preflightHex(hexPath, flashKB) {
  if (!hexPath || !existsSync(hexPath) || !statSync(hexPath).isFile()) {
    return { ok: false, error: 'HEX_NOT_FOUND', message: `hex 文件不存在：${hexPath ?? '(未提供)'}` }
  }
  const stat = statSync(hexPath)
  const content = readFileSync(hexPath)
  const info = parseIntelHex(content.toString('latin1'))
  const errors = []
  if (!info.ok) errors.push('HEX 记录长度、类型、校验和或 EOF 不合法')
  if (!info.bytes) errors.push('HEX 没有可烧录数据')
  if (info.maxAddr > 0xffff) errors.push('HEX 超过本版支持的 8051 64KB 地址空间')
  if (flashKB && info.maxAddr >= flashKB * 1024) errors.push(`HEX 最高地址 0x${info.maxAddr.toString(16)} 超过芯片 Flash ${flashKB * 1024} 字节`)
  const ageMinutes = Math.round((Date.now() - stat.mtimeMs) / 60000)
  return {
    ok: errors.length === 0, error: errors.length ? 'INVALID_HEX' : null,
    message: errors.join('；'), path: hexPath, name: basename(hexPath),
    sizeBytes: stat.size, dataBytes: info.bytes,
    minAddr: info.minAddr === null ? null : `0x${info.minAddr.toString(16).toUpperCase()}`,
    maxAddr: info.maxAddr === null ? null : `0x${info.maxAddr.toString(16).toUpperCase()}`,
    checksumOk: info.ok, sha256: createHash('sha256').update(content).digest('hex'),
    mtime: new Date(stat.mtimeMs).toISOString(), ageMinutes,
    warnings: ageMinutes > 30 ? [`hex 已经 ${ageMinutes} 分钟没更新，请核对源码与产物`] : [],
  }
}

export function resolveHexTarget({ hex, project }) {
  const input = hex ?? project
  if (!input) return { ok: false, error: 'NO_TARGET', message: '需要 hex 或 project 其中一个' }
  if (hex && existsSync(hex) && statSync(hex).isFile()) return { ok: true, path: hex, source: 'explicit' }
  const target = resolveProjectTarget(input)
  if (!target.ok) return { ok: false, error: 'PROJECT_NOT_FOUND', message: target.reason }
  const located = locateHex(target.dir, target.uvproj)
  if (!located.path) return { ok: false, error: 'HEX_NOT_FOUND', message: `工程里没有 hex（先编译）：${target.dir}` }
  return { ok: true, path: located.path, source: 'project', uvproj: target.uvproj, dir: target.dir }
}

export function summarizeFlash(result) {
  if (result.preflight && !result.preflight.ok) return `❌ ${result.preflight.message}`
  const confirmed = result.ok && result.programmed === true && result.stage === 'complete'
  const head = confirmed ? '✅ 烧录成功（已收到协议应答）' : /gui|pzisp/.test(result.flasher ?? '') ? '⚠️ 待人工操作，烧录未确认' : '❌ 烧录未完成'
  return [head,
    result.preflight ? `hex：${result.preflight.path}（${result.preflight.dataBytes} 字节数据，SHA256 ${result.preflight.sha256}）` : null,
    ...(result.preflight?.warnings ?? []).map((w) => `⚠️ ${w}`),
    result.chip ? `芯片：${result.chip.model}，BSL ${result.chip.bslVersion}，进入下载时 ${result.chip.freqHz} Hz` : null,
    result.calibration ? `本轮 IRC 校准：${result.calibration.actualFreqHz} Hz（请求 ${result.calibration.requestedFreqHz} Hz）` : null,
    result.stage ? `阶段：${result.stage}` : null,
    result.error ? `${result.error}：${result.message ?? ''}` : null,
    confirmed ? '验证依据：烧录器协议应答；未执行独立 Flash 读回。' : null,
    result.nextAction,
  ].filter(Boolean).join('\n')
}
