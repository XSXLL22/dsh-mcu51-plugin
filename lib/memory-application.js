// A deliberately narrow full-reflash adapter. Preview IDs are never execution IDs.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { composeImage, encodeDenseHex, exportImage, runImageAction } from './image.js'
import { materializeMemoryPlan } from './memory-plan.js'
import { planOptions } from './hardware-options.js'
import { runIsp } from './isp.js'
import { normalizeExpectedUid, matchesExpectedUid } from './session-parameters.js'

const PROFILE = 'stc15-f449-725s-memory-v1'
const LIMIT = 61952 // Conservative last-sector programming exclusion, not a preservation claim.
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const demand = (ok, code, message) => { if (!ok) throw Object.assign(new Error(message), { code }) }
const fail = error => ({ ok: false, error: error.code ?? 'MEMORY_APPLICATION_INVALID', message: String(error.message), hardwareAccess: false, executable: false })
const check = result => { demand(result.ok, result.error, result.message); return result }
const defined = (input, names) => Object.fromEntries(names.filter(k => input[k] !== undefined).map(k => [k, input[k]]))

function source(path, limit = 16 * 1024 * 1024) {
  demand(typeof path === 'string' && isAbsolute(path), 'MEMORY_PATH_REQUIRED', '需要绝对文件路径。')
  const stat = statSync(path)
  demand(stat.isFile() && stat.size <= limit, 'MEMORY_FILE_SIZE', '来源文件过大或不是普通文件。')
  const bytes = readFileSync(path)
  demand(bytes.length <= limit, 'MEMORY_FILE_SIZE', '读取期间文件超过大小限制。')
  return { path: resolve(path), sha256: sha(bytes), bytes }
}
function freeze(path, bytes, write) {
  if (write) {
    mkdirSync(dirname(path), { recursive: true })
    try { writeFileSync(path, bytes, { flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const file = source(path)
  demand(file.bytes.equals(bytes), 'MEMORY_FILE_CHANGED', '冻结文件缺失或内容变化；不覆盖、不修复：' + path)
  return { path: file.path, sha256: file.sha256 }
}

/** write is an internal rebuild seam, never a tool parameter. */
export function prepareMemoryApplication(args, dataDir, write = true) {
  try {
    demand(args && args.action === 'prepare' && Object.keys(args).every(k => ['action', 'image', 'expectedImageId', 'targetId', 'bslVersion',
      'erasePolicy', 'eepromOffset', 'expectedMemoryPlanId', 'snapshot', 'port', 'freqHz', 'recoveryHex'].includes(k)),
    'MEMORY_ARGUMENT', 'prepare只接收已声明的镜像/预览/快照/恢复/目标参数。')
    demand(typeof dataDir === 'string' && isAbsolute(dataDir), 'MEMORY_PATH_REQUIRED', '需要插件数据目录绝对路径。')
    const imageFile = source(args.image)
    const image = check(runImageAction({ action: 'inspect', image: imageFile.path, expectedImageId: args.expectedImageId }))
    const options = defined(args, ['targetId', 'bslVersion', 'erasePolicy', 'eepromOffset'])
    const { plan, bytes } = check(materializeMemoryPlan(image, args.expectedImageId, options))
    demand(plan.memoryPlanId === args.expectedMemoryPlanId, 'MEMORY_PLAN_CHANGED', '需要已核对且一致的完整expectedMemoryPlanId。')
    demand(plan.target.model === 'IAP15F2K61S2' && plan.target.magic === 'F449' && plan.target.bslVersion === '7.2.5S' &&
      plan.erasePolicy === 'code' && bytes.length <= LIMIT && plan.wire.bundledEngineEraseMatches,
    'MEMORY_PROFILE_UNAVAILABLE', '执行仅适配F449/7.2.5S、code擦除请求；组合填充终点不得超过F200H。')
    demand(typeof args.port === 'string' && /^COM[1-9][0-9]*$/i.test(args.port) && args.freqHz === 12000000,
      'MEMORY_TARGET_REQUIRED', '请明确COM端口与freqHz=12000000整数。')
    const snapshotFile = source(args.snapshot, 2 * 1024 * 1024)
    const saved = JSON.parse(snapshotFile.bytes.toString('utf8').replace(/^\uFEFF/, ''))
    const diff = check(planOptions(saved, {}))
    const chip = (saved.action ? saved : saved.data).chip
    demand(chip.codeBytes === 62464 && Number.isSafeInteger(chip.freqHz) && Math.abs(chip.freqHz - 12000000) <= 240000 &&
      chip.hardwareOptions.values.clock_source === 'internal' && chip.hardwareOptions.values.eeprom_erase_enabled === false,
    'MEMORY_BASELINE_UNSUPPORTED', '需要12MHz附近的内部IRC且EEPROM擦除位关闭的成功只读快照。')
    const recoverySource = source(args.recoveryHex)
    const recovery = check(composeImage({ sources: [{ path: recoverySource.path, format: 'hex' }], fillByte: image.buffers.code.fillByte }))
    demand(recovery.buffers.code.denseSha256 === image.buffers.code.denseSha256 && recovery.buffers.code.denseBytes === image.buffers.code.denseBytes &&
      recovery.buffers.code.startAddress === null, 'MEMORY_RECOVERY_MISMATCH', '恢复HEX必须与冻结代码缓冲区展开字节完全一致，且不含入口元数据。')
    const codeHex = check(exportImage(image, image.imageId, 'code', 'hex'))
    const directory = join(resolve(dataDir), 'memory-applications')
    const combined = freeze(join(directory, plan.programImage.sha256 + '.hex'), encodeDenseHex(bytes), write)
    const codeRecovery = freeze(join(directory, image.buffers.code.denseSha256 + '-recovery.hex'), codeHex.bytes, write)
    const intent = {
      method: 'reflash-shared-iap', profileId: PROFILE, port: args.port.toUpperCase(), requestedFreqHz: args.freqHz,
      baseline: { model: chip.model, magic: chip.magic, bslVersion: chip.bslVersion, freqHz: chip.freqHz, codeBytes: chip.codeBytes, rawMsrHex: diff.beforeMsrHex },
      sourceImage: { path: imageFile.path, sha256: imageFile.sha256, imageId: image.imageId },
      snapshot: { path: snapshotFile.path, sha256: snapshotFile.sha256 },
      recoverySource: { path: recoverySource.path, sha256: recoverySource.sha256 },
      preview: { options, memoryPlanId: plan.memoryPlanId },
      image: { ...combined, denseBytes: bytes.length, denseSha256: plan.programImage.sha256 },
      codeRecovery: { ...codeRecovery, denseBytes: image.buffers.code.denseBytes, denseSha256: image.buffers.code.denseSha256 },
      data: plan.placement.eeprom ? { offset: plan.placement.eeprom.linearAddress, bytes: image.buffers.eeprom.denseBytes,
        sha256: image.buffers.eeprom.denseSha256 } : null,
      tailPolicy: { programmingEndExclusive: LIMIT, erasePreservation: 'unknown' },
    }
    return { ok: true, kind: 'mcu51-memory-application', schemaVersion: 1, applicationId: sha(canonical(intent)), intent,
      hardwareAccess: false, executable: false, implementationAvailable: true, hardwareValidated: false, preview: plan,
      requiresFreshReadBeforeErase: true, uidAvailableBeforeErase: false, independentFlashReadback: false,
      effects: { ...plan.effects, hardwareOptions: 'write-unchanged-five-msr-bytes; other bytes use existing engine template',
        clockCalibration: 'recalibrate-12MHz', recovery: 'explicit code-only reflash; prior shared-IAP data cannot be recovered without a backup',
        tail: 'last 512-byte sector excluded from programming; erase preservation unknown' },
      verification: 'bootloader-ack only; no independent Flash readback; cold-start option query and firmware checks still required',
      nextAction: 'prepare未执行。mcu_flash需要memoryApplication文件和expectedMemoryApplicationId；新组合数据实测须明确授权，不自动恢复或重试。' }
  } catch (error) { return fail(error) }
}

export function verifyMemoryApplication(input, expectedId) {
  try {
    demand(input?.ok === true && input.kind === 'mcu51-memory-application' && input.schemaVersion === 1 &&
      typeof expectedId === 'string' && /^[0-9a-f]{64}$/.test(expectedId) && input.applicationId === expectedId,
    'MEMORY_APPLICATION_ID', '需要prepare生成的计划及一致的完整expectedMemoryApplicationId。')
    const intent = input.intent
    const rebuilt = check(prepareMemoryApplication({ action: 'prepare', image: intent.sourceImage.path, expectedImageId: intent.sourceImage.imageId,
      ...intent.preview.options, expectedMemoryPlanId: intent.preview.memoryPlanId, snapshot: intent.snapshot.path,
      port: intent.port, freqHz: intent.requestedFreqHz, recoveryHex: intent.recoverySource.path }, dirname(dirname(intent.image.path)), false))
    demand(rebuilt.applicationId === expectedId && canonical(rebuilt.intent) === canonical(intent), 'MEMORY_APPLICATION_CHANGED', '来源、预览或应用意图已变化，请重新prepare。')
    return { ok: true, plan: rebuilt, hardwareAccess: false }
  } catch (error) { return fail(error) }
}

export async function applyMemoryApplication(input, expectedId, settings = {}, runner = runIsp) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).some(k => !['dryRun', 'waitSeconds', 'signal', 'onProgress', 'expectedUid'].includes(k)) ||
      settings.dryRun !== undefined && typeof settings.dryRun !== 'boolean' ||
      settings.waitSeconds !== undefined && (!Number.isSafeInteger(settings.waitSeconds) || settings.waitSeconds < 1 || settings.waitSeconds > 300)) {
    return fail(Object.assign(new Error('执行设置仅接受dryRun布尔值及1~300整数waitSeconds。'), { code: 'MEMORY_ARGUMENT' }))
  }
  let expectedUid
  try { if (settings.expectedUid !== undefined) expectedUid = normalizeExpectedUid(settings.expectedUid) }
  catch (error) { return fail(error) }
  const verified = verifyMemoryApplication(input, expectedId)
  if (!verified.ok) return verified
  const { plan } = verified, { intent } = plan
  const imageBinding = { schemaVersion: 1, imageId: intent.sourceImage.imageId, buffer: 'code', hexSha256: intent.image.sha256,
    denseSha256: intent.image.denseSha256, denseBytes: intent.image.denseBytes }
  if (settings.dryRun) return { ok: true, dryRun: true, hardwareAccess: false, ...(expectedUid !== undefined ? { expectedUid } : {}), applicationId: expectedId, applicationPlan: plan }
  if (settings.signal?.aborted) return fail(Object.assign(new Error('串口访问前已取消。'), { code: 'CANCELLED' }))
  let result
  try {
    result = await runner({ action: 'flash', port: intent.port, mcu: intent.baseline.model, hex: intent.image.path,
      expectedSha256: intent.image.sha256, freqHz: intent.requestedFreqHz, clockMode: 'calibrate', waitSeconds: settings.waitSeconds ?? 60,
      signal: settings.signal, onProgress: settings.onProgress, ...(expectedUid !== undefined ? { expectedUid } : {}), memoryApplication: intent, applicationId: expectedId, imageBinding })
  } catch (error) {
    result = { ok: false, error: 'MEMORY_EXECUTOR_FAILED', message: String(error.message), operationState: 'unknown-after-executor-error',
      eraseStarted: null, programAcknowledged: null, hardwareOptionsWritten: null }
  }
  const confirmed = result?.ok === true && matchesExpectedUid(result, expectedUid) && result.applicationId === expectedId && result.stage === 'complete' && result.programmed === true &&
    result.programAcknowledged === true && result.hardwareOptionsWritten === true && result.optionsWrite?.acknowledged === true &&
    result.optionsWrite.msrHex === intent.baseline.rawMsrHex && result.boundImageVerified === true && canonical(result.imageBinding) === canonical(imageBinding)
  return { ...result, ok: confirmed, ...(!confirmed && result?.ok !== false ? { error: 'MEMORY_RECEIPT_INVALID', message: '回执缺少完整的组合字节/代码/选项确认。' } : {}),
    executorApplicationId: result?.applicationId ?? null, applicationId: expectedId, applicationPlan: plan, executionRequested: true,
    ...(!confirmed ? { nextAction: '执行未完整确认；核对原始回执和冷启动状态，不自动重试或恢复。',
      ...(!result || result.ok === true ? { operationState: 'unknown-invalid-executor-receipt', eraseStarted: result?.eraseStarted ?? null,
        programAcknowledged: result?.programAcknowledged ?? null, hardwareOptionsWritten: result?.hardwareOptionsWritten ?? null } : {}) } : {}) }
}

export function readMemoryApplication(path) {
  try { return JSON.parse(source(path, 2 * 1024 * 1024).bytes.toString('utf8')) }
  catch (error) { return fail(error) }
}
