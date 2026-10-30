// 串口会话：调用 python sidecar（pyserial），拿结构化结果。
import { readFileSync } from 'node:fs'
import { createLog } from './config.js'
import { runSidecar } from './runtime.js'
import { prepareSerialSession } from './session-parameters.js'

/** Legacy helper only; execution uses the strict, byte-frozen session planner. */
export function normalizeSend(send) {
  if (!send) return []
  const items = Array.isArray(send) ? send : String(send).split(';')
  return items
    .map((item) => {
      if (item && typeof item === 'object') {
        if (item.hex != null) return { hex: String(item.hex), delayMs: Number(item.delayMs ?? 0), newline: false }
        return { text: String(item.text ?? ''), delayMs: Number(item.delayMs ?? item.delay ?? 0), newline: item.newline !== false }
      }
      const text = String(item ?? '').trim()
      return text ? { text, delayMs: 0, newline: true } : null
    })
    .filter(Boolean)
}

/**
 * 抓一段串口。
 * @param {{port: string, baud?: number, seconds?: number, send?: any, until?: string[]|string,
 *          newline?: 'crlf'|'lf'|'cr'|'none', maxLines?: number, autoBaud?: boolean, baudCandidates?: number[],
 *          openDelayMs?: number, openRetrySeconds?: number, signal?: AbortSignal, encoding?: string}} options
 * executeSidecar is an internal test seam, never a DSH parameter.
 */
export async function captureSerial(options, executeSidecar) {
  if (options.signal?.aborted) return { ok: false, error: 'CANCELLED', message: '串口访问前已取消。', hardwareAccess: false, bytes: 0, sent: [] }
  const prepared = await prepareSerialSession(options)
  if (!prepared.ok) return prepared
  if (options.signal?.aborted) return { ok: false, error: 'CANCELLED', hardwareAccess: false, message: '会话预检后、串口访问前取消。' }
  const sessionPlan = prepared.plan
  const spec = sessionPlan.spec
  if (options.dryRun === true) return { ok: true, dryRun: true, hardwareAccess: false, sessionPlan, spec, bytes: 0, sent: [] }
  const result = await (executeSidecar ?? runSidecar)('serial_io.py', { sessionPlan, expectedSessionPlanId: sessionPlan.sessionPlanId }, {
    timeoutMs: sessionPlan.budget.timeoutMs,
    signal: options.signal,
  })

  const events = result.stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { const event = JSON.parse(line); return event && typeof event === 'object' && !Array.isArray(event) ? [event] : [] } catch { return [] }
  })
  const parsed = events.findLast(event => typeof event?.ok === 'boolean')
  const cancelled = Boolean(options.signal?.aborted || result.aborted)
  if (!parsed) {
    return {
      ok: false,
      error: cancelled ? 'CANCELLED' : result.timedOut ? 'TIMEOUT' : 'SIDECAR_FAILED',
      message: (result.stderr || result.stdout || result.error || '序列脚本没有返回 JSON').slice(0, 2000),
      spec, sessionPlan,
      exitCode: result.code,
      processClosed: result.processClosed ?? null,
      processErrors: result.errors ?? [],
      bytes: null,
      sent: events.filter(event => event.event === 'serial-sent').map(event => event.sent),
      session: events.findLast(event => event.event === 'session-acquired')?.session ?? null,
      captureIncomplete: true,
      transmitState: spec.send.length ? 'unknown-without-final-receipt' : 'not-requested',
      sendMayHaveStarted: spec.send.length ? (events.some(event => event.stage === 'sending') ? true : null) : false,
    }
  }
  const executionError = cancelled ? 'CANCELLED' : result.timedOut ? 'TIMEOUT' : parsed.ok === true && (result.error || result.code !== 0) ? 'SIDECAR_EXIT_FAILED' : null
  const receipt = { ...parsed, ok: parsed.ok === true && result.code === 0 && !result.error && !result.timedOut && !cancelled, spec, sessionPlan, exitCode: result.code,
    processClosed: result.processClosed ?? null,
    processErrors: result.errors ?? [],
    ...(executionError ? { error: executionError, message: result.error || '执行取消、超时或异常退出；保留收发回执，不能撤销已发送数据。',
      ...(parsed.error ? { sidecarError: { error: parsed.error, message: parsed.message } } : {}), captureIncomplete: true } : {}) }
  if (receipt.ok && parsed.sessionPlanId !== sessionPlan.sessionPlanId) Object.assign(receipt, {
    ok: false, error: 'SESSION_RECEIPT_MISMATCH', message: '发送/抓包可能已发生，但完成回执未确认会话计划身份；保留全部回执，不自动重试。',
  })
  return receipt
}

/** 结构化结果 → 一段可读摘要（时间戳格式与 tools/cap.py 一致）。 */
export function summarizeSerial(result, options = {}) {
  if (result.dryRun) {
    const plan = result.sessionPlan ?? {}
    const spec = plan.spec ?? {}
    const sends = spec.send ?? []
    const baud = spec.autoBaud ? '自动：' + (spec.baudCandidates ?? []).join('/') : spec.baud ?? '?'
    const preview = sends.slice(0, 3).map((item, index) => (index + 1) + ': ' + item.hex.slice(0, 64) + (item.hex.length > 64 ? '…' : '')).join('\n')
    return 'dryRun：参数和发送字节已验证，未取得端口锁、未打开串口。\n' +
      (spec.port ?? '?') + ' @' + baud + '，' + (spec.dataBits ?? '?') + (spec.parity ?? '?') + (spec.stopBits ?? '?') + '，编码' + (spec.encoding ?? '?') +
      '\n计划ID：' + (plan.sessionPlanId ?? '') + '\n发送' + sends.length + '条/' + (plan.budget?.sendBytes ?? 0) + '字节；总超时预算' + (plan.budget?.timeoutMs ?? '?') + 'ms' +
      (preview ? '\nHEX预览：\n' + preview : '') + '\n完整字节和参数见结构化结果/日志。'
  }

  if (!result.ok && result.error && !result.lines) {
    const trials = result.trials?.length ? `\n试过的波特率：${result.trials.map((t) => `${t.baud}${t.ok ? '' : '(打不开)'}`).join(' / ')}` : ''
    return `❌ 串口抓包失败：${result.error}\n${result.message ?? ''}${trials}`
  }
  const maxLines = options.maxInlineLines ?? 60
  const lines = result.lines ?? []
  const ratio = result.printableRatio ?? 0
  if (options.dataMode === 'binary') return `${!result.ok ? '❌ ' + (result.error ?? '收发未完成') + ' ' + (result.message ?? '') + '\n' : ''}串口 ${result.port} @${result.baud}，${result.bytes ?? '未知'} 字节\nHEX：${result.rawHex ?? ''}${result.rawTruncated ? '\n（显示前 64KB）' : ''}${result.sendError ? '\n发送失败：' + result.sendError : ''}${result.readError ? '\n读取失败：' + result.readError : ''}${result.cleanupErrors?.length ? '\n清理失败：' + result.cleanupErrors.join('；') : ''}`
  const head = `串口 ${result.port} @${result.baud} 抓到 ${lines.length} 行 / ${result.bytes} 字节（可打印比例 ${ratio.toFixed(2)}）`
  const body = lines
    .slice(0, maxLines)
    .map((l) => `${String(l.t).padStart(6)}  ${l.text}`)
    .join('\n')
  const tail = lines.length > maxLines ? `\n… 其余 ${lines.length - maxLines} 行见日志` : ''
  const matched = result.matched ? `\n命中截止条件：${result.matched}` : ''
  const sent = result.sent?.length ? `\n已发送：${result.sent.map((s) => s.text).join(' | ')}` : ''
  const trials = result.trials?.length ? `\n试过的波特率：${result.trials.map((t) => `${t.baud}${t.ok ? `(${t.lines ?? 0}行/${t.printableRatio ?? 0})` : '(打不开)'}`).join('  ')}` : ''
  const warn = []
  if (!result.ok && result.error) warn.push(result.error + '：' + (result.message ?? ''))
  if (result.readError) warn.push('读取失败：' + result.readError)
  if (result.cleanupErrors?.length) warn.push('清理失败：' + result.cleanupErrors.join('；'))
  if ((result.bytes ?? 0) === 0) warn.push('未收到数据：先核对固件是否启用串口上报，再检查运行状态、TXD接线和波特率')
  else if (lines.length === 0 && ratio < 0.5) warn.push('未收到有效文本：可能是二进制数据、复位噪声或波特率不匹配；若预期文本，核对固件波特率或使用 autoBaud=true')
  else if (ratio < 0.9 && lines.length > 0) warn.push('有可读行但夹杂不可打印字节：波特率可能只是“接近”，或者上位机把二进制也算进去了')
  if (result.sendError) warn.push(`发送失败：${result.sendError}`)
  return [head, body, tail, matched, sent, trials, ...warn.map((w) => `⚠️ ${w}`)].filter(Boolean).join('\n')
}

/** 把整段抓包落盘，返回日志路径。 */
export function logSerial(dataDir, result, tag = 'serial') {
  const log = createLog(dataDir, tag)
  const lines = (result.lines ?? []).map((l) => `${String(l.t).padStart(6)}  ${l.text}`)
  log.write(
    [
      `# port=${result.port} baud=${result.baud} bytes=${result.bytes} lines=${lines.length}`,
      `# spec=${JSON.stringify(result.spec ?? {})}`,
      `# receipt=${JSON.stringify({ ...result, lines: undefined })}`,
      ...lines,
      result.residual ? `# residual: ${result.residual}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return log.path
}

export { readFileSync }
