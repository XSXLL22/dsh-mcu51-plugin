import { bundledRuntime, runSidecar } from './runtime.js'
import { normalizeIspParameters, matchesExpectedUid } from './session-parameters.js'

export function protocolForMcu(mcu) {
  if (!mcu) return 'auto'
  const name = String(mcu).toUpperCase()
  if (/^STC(89|90)(C|LE)\d/.test(name)) return 'stc89'
  if (/^(STC|IAP)15[FL][012]0\d(E|EA)?$/.test(name)) return 'stc15a'
  if (/^(STC|IAP|IRC)15\D/.test(name)) return 'stc15'
  throw new Error(`当前发布版未验证该芯片系列：${mcu}；支持 STC89/90 和 STC15。`)
}

export function makeIspPlan(options) {
  const runtime = bundledRuntime()
  const parameters = normalizeIspParameters(options)
  const protocol = protocolForMcu(parameters.mcu)
  if (options.memoryApplication !== undefined && options.optionsApplication !== undefined) throw new Error('不能混用存储与选项应用计划。')
  if (options.imageBinding !== undefined) {
    const binding = options.imageBinding
    if (!binding || options.action !== 'flash' || binding.schemaVersion !== 1 || binding.buffer !== 'code' ||
        Object.keys(binding).sort().join(',') !== 'buffer,denseBytes,denseSha256,hexSha256,imageId,schemaVersion' ||
        !['imageId', 'denseSha256', 'hexSha256'].every(key => typeof binding[key] === 'string' && /^[0-9a-f]{64}$/.test(binding[key])) ||
        !Number.isSafeInteger(binding.denseBytes) || binding.denseBytes < 1 || binding.denseBytes > 65536 || binding.hexSha256 !== options.expectedSha256) {
      throw new Error('冻结镜像绑定格式、文件哈希或字节数不正确。')
    }
  }
  return {
    ...parameters, flasher: 'builtin', protocol, hex: options.hex ?? null,
    expectedSha256: options.expectedSha256 ?? null,
    ...(options.optionsApplication ? { optionsApplication: options.optionsApplication, applicationId: options.applicationId } : {}),
    ...(options.memoryApplication ? { memoryApplication: options.memoryApplication, applicationId: options.applicationId } : {}),
    ...(options.imageBinding ? { imageBinding: { ...options.imageBinding } } : {}),
    runtime: { ok: runtime.ok, path: runtime.path, error: runtime.error ?? null },
    ...(parameters.expectedUid !== undefined ? { targetVerification: { expectedUid: parameters.expectedUid,
      phase: 'erase-response', beforeEraseIdentityVerified: false } } : {}),
    requires: { powerCycle: true, uac: false, clickDownload: false, externalSoftware: false },
    hint: '开始等待后按板载下载键，或给 MCU 断电重上电；是否能自动复位取决于板子的电路。',
  }
}

export async function runIsp(options, executeSidecar = runSidecar) {
  const plan = makeIspPlan(options)
  if (options.signal?.aborted) return { ok: false, error: 'CANCELLED', message: '串口访问前已取消。', stage: 'preflight',
    hardwareAccess: false, programmed: false, eraseStarted: false, programAcknowledged: false, hardwareOptionsWritten: false,
    applicationId: options.applicationId ?? null, plan }
  if (!plan.runtime.ok) return { ok: false, error: plan.runtime.error, message: '缺少插件内置运行时，请安装完整发布包。', stage: 'preflight',
    applicationId: options.applicationId ?? null, programmed: false, programAcknowledged: false, eraseStarted: false,
    hardwareOptionsWriteStarted: false, hardwareOptionsWritten: false, hardwareAccess: false, plan }
  let progressBuffer = ''
  const child = await executeSidecar('isp.py', plan, { signal: options.signal, timeoutMs: plan.timeoutMs,
    onStdout(chunk) {
      progressBuffer += chunk.toString('utf8')
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop()
      for (const line of lines) {
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.event === 'stage') options.onProgress?.(event)
      }
    },
  })
  const events = child.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { const event = JSON.parse(line); return event && typeof event === 'object' && !Array.isArray(event) ? [event] : [] } catch { return [] }
  })
  const final = events.findLast((event) => event.event === 'result')
  const stage = events.findLast((event) => event.event === 'stage')?.stage ?? 'startup'
  if (!final) {
    const eraseMayHaveStarted = options.action === 'flash' && ['erase', 'program', 'options', 'preserve_options', 'disconnect', 'complete'].includes(stage)
    const optionsMayHaveStarted = options.action === 'flash' && plan.clockMode !== 'preserve' && ['options', 'disconnect', 'complete'].includes(stage)
    return { ok: false, programmed: false, stage, error: options.signal?.aborted || child.aborted ? 'CANCELLED' : child.timedOut ? 'TIMEOUT' : 'SIDECAR_FAILED',
      eraseMayHaveStarted, eraseStarted: eraseMayHaveStarted ? null : false,
      hardwareOptionsWriteMayHaveStarted: optionsMayHaveStarted, hardwareOptionsWriteStarted: optionsMayHaveStarted ? null : false,
      hardwareOptionsWritten: optionsMayHaveStarted ? null : false, programAcknowledged: eraseMayHaveStarted ? null : false,
      operationState: eraseMayHaveStarted ? 'unknown-after-process-loss' : 'no-erase-stage-observed',
      message: child.error || child.stderr || '内置 ISP 未返回完成结果', output: child.out, events, plan,
      processClosed: child.processClosed ?? null, processErrors: child.errors ?? [], session: events.findLast(event => event.event === 'session-acquired')?.session ?? null,
      nextAction: optionsMayHaveStarted ? '子进程中断，选项可能已写入；先冷启动只读核对，勿自动重试。' : eraseMayHaveStarted ? '子进程中断，代码区可能已擦写，需按恢复计划检查固件。' : '没有观察到擦写阶段；核对错误后重新准备。' }
  }
  const result = { ...final, ok: final.ok === true && child.code === 0 && !child.error && !child.timedOut && !options.signal?.aborted && !child.aborted,
    flasher: 'builtin', exitCode: child.code, output: child.stderr, events, plan, processClosed: child.processClosed ?? null, processErrors: child.errors ?? [] }
  const executionError = options.signal?.aborted || child.aborted ? 'CANCELLED' : child.timedOut ? 'TIMEOUT' :
    final.ok === true && (child.error || child.code !== 0) ? 'SIDECAR_EXIT_FAILED' : null
  if (executionError) Object.assign(result, { ok: false, error: executionError,
    ...(final.error ? { sidecarError: { error: final.error, message: final.message } } : {}),
    message: child.error || '执行已取消、超时或异常退出；保留已收到的步骤确认，不撤销已发生的擦写。' })
  if (result.ok === true && plan.imageBinding && (final.boundImageVerified !== true || !final.imageBinding ||
      Object.keys(final.imageBinding).length !== Object.keys(plan.imageBinding).length ||
      Object.keys(plan.imageBinding).some(key => final.imageBinding[key] !== plan.imageBinding[key]))) {
    Object.assign(result, { ok: false, error: 'IMAGE_RECEIPT_MISMATCH', message: '完成回执未确认绑定的镜像身份；保留已经发生的擦写状态。',
      nextAction: '镜像身份回执不符，不自动重试；核对原始日志与实际硬件状态。' })
  }
  if (result.ok === true && !matchesExpectedUid(final, plan.expectedUid)) {
    Object.assign(result, { ok: false, error: 'TARGET_RECEIPT_MISMATCH',
      message: '缺少已知UID/完整擦除应答/超时恢复确认；保留已发生的擦写状态。',
      nextAction: '核对原始回执和目标，不自动重试；UID核对发生在擦除请求之后。' })
  }
  return result
}
