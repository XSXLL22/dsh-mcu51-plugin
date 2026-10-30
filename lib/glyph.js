// 取模：文字 / 图片 → C 数组 + 预览图（PIL sidecar）。
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runSidecar } from './runtime.js'

const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\simsun.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simkai.ttf',
]
const MONO_CANDIDATES = ['C:\\Windows\\Fonts\\consola.ttf', 'C:\\Windows\\Fonts\\cour.ttf', ...FONT_CANDIDATES]

function pickFont(text, height, preferred) {
  if (preferred && existsSync(preferred)) return preferred
  const hasCjk = /[^\x00-\x7f]/.test(text ?? '')
  const list = hasCjk ? FONT_CANDIDATES : MONO_CANDIDATES
  return list.find((p) => existsSync(p)) ?? FONT_CANDIDATES[0]
}

/** 解析 "16x16" / "8x8" / {width,height}。 */
export function parseSize(size, width, height) {
  if (width && height) return { width: Number(width), height: Number(height) }
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size ?? ''))
  if (m) return { width: Number(m[1]), height: Number(m[2]) }
  return { width: 16, height: 16 }
}

/**
 * 取模。
 * @param {{python: string, text?: string, image?: string, size?: string, width?: number, height?: number,
 *          font?: string, fontIndex?: number, threshold?: number, invert?: boolean, scan?: 'row'|'col',
 *          bitOrder?: 'msb'|'lsb', varName?: string, preview?: boolean, previewPath?: string, dataDir: string,
 *          scale?: number, signal?: AbortSignal}} options
 */
export async function renderGlyph(options) {
  if (!options.text && !options.image) {
    return { ok: false, error: 'NO_INPUT', message: 'text 与 image 至少给一个' }
  }
  const { width, height } = parseSize(options.size, options.width, options.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 512) {
    return { ok: false, error: 'BAD_SIZE', message: '点阵宽高必须是 1~512 的整数' }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.varName ?? 'glyph')) {
    return { ok: false, error: 'BAD_VARIABLE', message: 'varName 必须是有效的 C 变量名' }
  }
  const font = pickFont(options.text, height, options.font)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let previewPath = options.previewPath
  if (!previewPath && options.preview !== false) {
    const dir = join(options.dataDir, 'glyphs')
    mkdirSync(dir, { recursive: true })
    const label = (options.text ?? 'image').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 24) || 'glyph'
    previewPath = join(dir, `${label}-${width}x${height}-${stamp}.png`)
  }

  const spec = {
    text: options.text ?? '',
    image: options.image ?? null,
    width,
    height,
    font,
    fontIndex: Number(options.fontIndex ?? 0),
    threshold: Number(options.threshold ?? 128),
    invert: Boolean(options.invert),
    scan: options.scan === 'col' ? 'col' : 'row',
    bitOrder: options.bitOrder === 'lsb' ? 'lsb' : 'msb',
    preview: options.preview !== false,
    previewPath,
    scale: Number(options.scale ?? 8),
    varName: options.varName ?? 'glyph',
  }

  const result = await runSidecar('glyph.py', spec, {
    timeoutMs: 60_000,
    signal: options.signal,
  })
  const line = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop()
  let parsed = null
  try {
    parsed = JSON.parse(line)
  } catch {
    parsed = null
  }
  if (!parsed) {
    return {
      ok: false,
      error: 'SIDECAR_FAILED',
      message: (result.stderr || result.stdout || result.error || '取模脚本没有返回 JSON').slice(0, 2000),
      spec,
    }
  }
  return { ...parsed, ok: parsed.ok && result.code === 0 && !result.timedOut && !options.signal?.aborted, previewPath: parsed.previewPath ?? previewPath, spec }
}

/** 取模结果 → 可读摘要（带 ASCII 点阵图）。 */
export function summarizeGlyph(result) {
  if (!result.ok) return `❌ 取模失败：${result.error ?? ''} ${result.message ?? ''}`
  const parts = []
  parts.push(`✅ ${result.width}×${result.height} ${result.scan === 'col' ? '列' : '行'}取模，${result.bitOrder.toUpperCase()}-first，${result.invert ? '阴码' : '阳码'}，每字 ${result.bytesPerChar} 字节`)
  for (const c of result.chars.slice(0, 4)) {
    parts.push(`\n【${c.char}】`)
    parts.push(c.bits)
  }
  if (result.chars.length > 4) parts.push(`… 共 ${result.chars.length} 个字`)
  parts.push('\n```c')
  parts.push(result.cArray)
  parts.push('```')
  if (result.previewPath) parts.push(`预览图：${result.previewPath}`)
  return parts.join('\n')
}
