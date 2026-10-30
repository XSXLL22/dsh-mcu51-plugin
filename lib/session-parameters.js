// Shared ISP limits and a read-only Python serial planner for exact encodings.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runSidecar } from './runtime.js'

const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
})
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
function requireValue(ok, message) { if (!ok) throw Object.assign(new Error(message), { code: 'BAD_SESSION_PARAMETERS' }) }
const fail = error => ({ ok: false, error: error.code ?? 'BAD_SESSION_PARAMETERS', message: error.message, hardwareAccess: false, stage: 'preflight' })
function contract() {
  const data = JSON.parse(readFileSync(new URL('../data/session-contract.json', import.meta.url), 'utf8'))
  requireValue(data.schemaVersion === 1 && data.contractId === 'mcu51-sessions-v1' && data.isp.baud === 115200 && data.isp.handshakeBaud === 2400,
    '会话参数契约不正确。')
  return data
}
function numeric(value, limits, name, integral = true) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && (!integral || Number.isSafeInteger(value)) &&
    value >= limits[0] && value <= limits[1], name + '必须是' + limits.join('~') + (integral ? '的整数。' : '的数值。'))
  return value
}

export function normalizeExpectedUid(value) {
  requireValue(typeof value === 'string' && /^[0-9a-fA-F]{14}$/.test(value) && value.length === 14,
    'expectedUid必须是14个十六进制字符；仅在擦除应答核对UID，不能在擦除前独立确认身份。')
  return value.toUpperCase()
}

export function matchesExpectedUid(result, expectedUid) {
  if (expectedUid === undefined) return true
  const reply = result?.eraseReception
  return result?.chip?.uid === expectedUid && reply?.expectedUid === expectedUid && reply.actualUid === expectedUid &&
    reply.frameAndUidMatched === true && reply.originalEraseReturned === true && reply.nativeTimeouts?.restored === true &&
    reply.cleanupErrors?.length === 0 && reply.failure === null
}

export function normalizeIspParameters(options) {
  requireValue(options && typeof options === 'object' && !Array.isArray(options), 'ISP参数必须是对象。')
  const rules = contract().isp
  requireValue(typeof options.port === 'string' && /^COM[1-9]\d{0,5}$/i.test(options.port) && options.port.trim() === options.port, '请指定有效串口COM加1~6位数字，不能包含空白。')
  requireValue(['chipinfo', 'flash', 'handshake'].includes(options.action), 'ISP action不合法。')
  const waitSeconds = numeric(options.waitSeconds === undefined ? rules.waitSeconds : options.waitSeconds, rules.waitRange, 'waitSeconds')
  const freqHz = options.freqHz == null ? null : numeric(options.freqHz, rules.frequencyRange, 'freqHz')
  const clockMode = options.clockMode === undefined ? 'calibrate' : options.clockMode
  requireValue(['calibrate', 'preserve'].includes(clockMode), 'clockMode必须为calibrate/preserve。')
  requireValue(options.debug === undefined || typeof options.debug === 'boolean', 'debug必须为布尔值。')
  for (const name of ['baud', 'handshakeBaud']) requireValue(options[name] === undefined || (typeof options[name] === 'number' && options[name] === rules[name]), 'ISP ' + name + '固定为' + rules[name] + '。')
  requireValue(options.mcu == null || (typeof options.mcu === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(options.mcu) && options.mcu.trim() === options.mcu), 'mcu必须为型号字符串。')
  requireValue(options.action !== 'flash' || Boolean(options.mcu), '烧录必须提供mcu。')
  let expectedUid
  if (options.expectedUid !== undefined) {
    expectedUid = normalizeExpectedUid(options.expectedUid)
    requireValue(options.action === 'flash' && options.mcu?.toUpperCase() === 'IAP15F2K61S2' && clockMode === 'calibrate',
      'expectedUid仅支持IAP15F2K61S2的calibrate烧录；实时BSL/时钟仍需核对。')
  }
  return { action: options.action, port: options.port.toUpperCase(), mcu: options.mcu?.toUpperCase() ?? null, waitSeconds, freqHz, clockMode,
    ...(expectedUid !== undefined ? { expectedUid } : {}),
    debug: options.debug ?? false, baud: rules.baud, handshakeBaud: rules.handshakeBaud, timeoutMs: waitSeconds * 1000 + rules.overheadMs }
}

export function verifySerialPlan(plan, expectedId) {
  try {
    requireValue(plan && typeof plan === 'object' && !Array.isArray(plan) && plan.schemaVersion === 1 && plan.kind === 'mcu51-serial-session', '串口计划格式不正确。')
    const { sessionPlanId, ...core } = plan
    requireValue(typeof expectedId === 'string' && /^[0-9a-f]{64}$/.test(expectedId) && expectedId === sessionPlanId && digest(core) === expectedId &&
      plan.contractSha256 === digest(contract()) && Number.isSafeInteger(plan.budget?.timeoutMs) && plan.budget.timeoutMs > 0 && plan.budget.timeoutMs <= contract().serial.maxTimeoutMs,
    '串口计划身份、契约或超时预算不一致。')
    return { ok: true, plan, hardwareAccess: false }
  } catch (error) { return fail(error) }
}

export async function prepareSerialSession(options, executor = runSidecar) {
  try {
    requireValue(options && typeof options === 'object' && !Array.isArray(options), '串口参数必须为对象。')
    const { signal: _signal, dryRun, ...request } = options
    requireValue(dryRun === undefined || typeof dryRun === 'boolean', 'dryRun必须为布尔值。')
    const allowed = new Set([...Object.keys(contract().serial.defaults), 'port', 'send', 'sendHex', 'until', 'untilRegex'])
    requireValue(Object.keys(request).every(key => allowed.has(key)), '包含未支持的串口参数。')
    const encoded = JSON.stringify({ kind: 'serial', options: request })
    requireValue(Buffer.byteLength(encoded, 'utf8') <= 2 * 1024 * 1024, '串口参数超过2MiB。')
    const child = await executor('session_parameters.py', { kind: 'serial', options: request }, { signal: options.signal, timeoutMs: 15000 })
    if (options.signal?.aborted || child.aborted) return { ok: false, error: 'CANCELLED', message: '会话预检已取消，未打开串口。', hardwareAccess: false }
    if (child.timedOut) return { ok: false, error: 'SESSION_PREFLIGHT_TIMEOUT', message: '会话预检超时，未打开串口。', hardwareAccess: false }
    let result
    try { result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)) }
    catch { return { ok: false, error: options.signal?.aborted ? 'CANCELLED' : 'SESSION_PREFLIGHT_FAILED', message: child.error || child.stderr || '会话预检没有返回有效结果。', hardwareAccess: false } }
    if (result.ok !== true) return { ...result, ok: false, hardwareAccess: false }
    requireValue(child.code === 0 && !child.error && !child.timedOut && !options.signal?.aborted, '会话预检进程未成功完成。')
    return verifySerialPlan(result.plan, result.plan?.sessionPlanId)
  } catch (error) { return fail(error) }
}
