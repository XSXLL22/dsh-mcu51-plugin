// Reviewable application preparation; this module never imports a transport.
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { preflightHex } from './flash.js'
import { planOptions } from './hardware-options.js'
import { runIsp } from './isp.js'
import { normalizeExpectedUid, matchesExpectedUid } from './session-parameters.js'

const fail = (error, message) => ({ ok: false, error, message, hardwareAccess: false, executable: false })
const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const canonical = value => JSON.stringify(sorted(value))
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex')

export function prepareOptionsApplication(input, patch, options = {}, metadata = {}) {
  const diff = planOptions(input, patch, metadata)
  if (!diff.ok) return diff
  if (!diff.hasChanges) return fail('NO_OPTION_CHANGES', '没有字段变化，不准备不必要的代码区重刷。')
  const snapshot = input?.action ? input : input.data
  const chip = snapshot.chip
  if (chip.codeBytes !== 62464 || !Number.isSafeInteger(chip.freqHz) || chip.freqHz < 100000 || chip.freqHz > 40000000) {
    return fail('INVALID_APPLICATION_BASELINE', '需要当前profile的代码容量和有效启动频率。')
  }
  if (chip.hardwareOptions.values.clock_source !== 'internal' || diff.patch.clock_source === 'external') {
    return fail('APPLICATION_CLOCK_UNAVAILABLE', '当前应用流程仅适配内部IRC；外部时钟变化仍只提供差异预览。')
  }
  if (!Number.isSafeInteger(options.freqHz) || options.freqHz < 100000 || options.freqHz > 40000000) {
    return fail('APPLICATION_FREQUENCY_REQUIRED', '请明确提供重新校准的freqHz整数，范围100000~40000000。')
  }
  if (typeof options.port !== 'string' || !/^COM[1-9][0-9]*$/i.test(options.port)) return fail('APPLICATION_PORT_REQUIRED', '请明确提供目标COM端口。')
  if (typeof options.hex !== 'string' || !isAbsolute(options.hex)) return fail('APPLICATION_IMAGE_REQUIRED', '该应用方式需要将重写的HEX绝对路径。')
  let image
  try { image = preflightHex(resolve(options.hex), chip.codeBytes / 1024) }
  catch (error) { return fail('APPLICATION_IMAGE_INVALID', String(error.message)) }
  if (!image.ok) return fail(image.error, image.message)
  const imageBytes = Number.parseInt(image.maxAddr, 16) + 1
  const paddedBytes = Math.ceil(imageBytes / 512) * 512
  if (paddedBytes > chip.codeBytes) return fail('APPLICATION_IMAGE_OVERFLOW', '填充后的镜像超过当前代码区。')
  const sourceSnapshot = {
    ok: true, action: 'chipinfo', stage: 'complete', programmed: false, eraseStarted: false, hardwareOptionsWritten: false,
    chip: { model: chip.model, magic: chip.magic, bslVersion: chip.bslVersion, freqHz: chip.freqHz, codeBytes: chip.codeBytes,
      hardwareOptions: structuredClone(chip.hardwareOptions) },
  }
  const intent = {
    method: 'reflash-code', profileId: diff.profile.id, port: options.port.toUpperCase(),
    baseline: { model: chip.model, magic: chip.magic, bslVersion: chip.bslVersion, freqHz: chip.freqHz, codeBytes: chip.codeBytes, rawMsrHex: diff.beforeMsrHex },
    patch: diff.patch, afterMsrHex: diff.afterMsrHex, requestedFreqHz: options.freqHz,
    image: { path: image.path, sha256: image.sha256, dataBytes: image.dataBytes, imageBytes, paddedBytes },
    snapshotFileSha256: metadata.fileSha256 ?? null,
  }
  return {
    ok: true, kind: 'mcu51-options-reflash', schemaVersion: 1, applicationId: fingerprint(intent), intent,
    sourceSnapshot, optionDiff: diff, hardwareAccess: false, executable: false, implementationAvailable: true, hardwareValidated: false,
    effects: { codeFlash: 'request-bootloader-code-erase-and-reprogram', codeEraseBytes: null, nominalCodeBytes: chip.codeBytes,
      explicitCodeEraseLengthEncoded: false, codeEraseExtent: 'bootloader-defined; not independently read',
      codeWriteBytes: paddedBytes, addressesOutsideImage: 'not-preserved-or-independently-read', eepromEraseRequest: false,
      iapDataPreservation: 'not-guaranteed-inside-erased-code-addresses', calibration: 'recalibrate-internal-irc',
      requestedFreqHz: options.freqHz, hardwareOptions: 'write-after-code-programming',
      unrequestedMsrBits: 'preserved', optionsOutsideMsr: 'existing-engine-template; not independently read',
      serialConfiguration: 'existing-verified-download-sequence' },
    stages: ['waiting_for_bootloader', 'identify', 'validate_application_baseline', 'handshake', 'erase', 'program', 'options', 'disconnect', 'complete'],
    requiresFreshReadBeforeErase: true, uidAvailableBeforeErase: false, independentFlashReadback: false,
    verification: 'protocol-acknowledgements; later independent cold-start status query required for options',
    standaloneOptionWrite: { available: false, reason: 'No hardware evidence that04 is accepted independently of03/07; UID is absent from04 but that does not prove independence.' },
    nextAction: '本计划尚未执行。apply需要计划文件与预期applicationId；会先重读基线，再重刷代码区和重新校准。',
  }
}

export function verifyOptionsApplication(input, expectedApplicationId) {
  const artifact = input?.kind ? input : input?.ok === true ? input.data : null
  if (!artifact || artifact.kind !== 'mcu51-options-reflash' || artifact.schemaVersion !== 1 ||
      typeof expectedApplicationId !== 'string' || !/^[0-9a-f]{64}$/.test(expectedApplicationId) ||
      artifact.applicationId !== expectedApplicationId || !artifact.intent) {
    return fail('INVALID_APPLICATION_PLAN', '需要prepare生成的应用计划和一致的expectedApplicationId。')
  }
  const intent = artifact.intent
  const rebuilt = prepareOptionsApplication(artifact.sourceSnapshot, intent.patch,
    { port: intent.port, hex: intent.image?.path, freqHz: intent.requestedFreqHz },
    { fileSha256: intent.snapshotFileSha256 })
  if (!rebuilt.ok) return rebuilt
  if (rebuilt.applicationId !== expectedApplicationId || canonical(rebuilt.intent) !== canonical(intent)) {
    return fail('APPLICATION_CHANGED', '镜像或应用计划已变化，请重新prepare并核对新的应用ID。')
  }
  return { ok: true, plan: rebuilt, hardwareAccess: false, executable: false }
}

export async function applyOptionsApplication(input, expectedApplicationId, settings = {}, runner = runIsp) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return fail('INVALID_APPLICATION_ARGUMENT', '执行设置必须是对象。')
  if (settings.dryRun !== undefined && typeof settings.dryRun !== 'boolean') return fail('INVALID_APPLICATION_ARGUMENT', 'dryRun必须为布尔值。')
  const waitSeconds = settings.waitSeconds ?? 60
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 300) return fail('INVALID_APPLICATION_ARGUMENT', 'waitSeconds必须为1~300整数。')
  let expectedUid
  try { if (settings.expectedUid !== undefined) expectedUid = normalizeExpectedUid(settings.expectedUid) }
  catch (error) { return fail(error.code, error.message) }
  const verified = verifyOptionsApplication(input, expectedApplicationId)
  if (!verified.ok) return verified
  const plan = verified.plan
  const intent = plan.intent
  for (const [name, expected] of [['port', intent.port], ['mcu', intent.baseline.model], ['hex', intent.image.path], ['freqHz', intent.requestedFreqHz]]) {
    if (settings[name] !== undefined && settings[name] !== expected) return fail('APPLICATION_PARAMETER_CONFLICT', 'apply参数与计划冲突：' + name + '；请重新prepare。')
  }
  if (settings.patch !== undefined || settings.snapshot !== undefined) return fail('APPLICATION_PARAMETER_CONFLICT', 'apply只采用已绑定计划，不接收独立patch/snapshot。')
  if (settings.dryRun === true) return { ok: true, dryRun: true, ...(expectedUid !== undefined ? { expectedUid } : {}), applicationId: plan.applicationId, applicationPlan: plan, hardwareAccess: false }
  if (settings.signal?.aborted) return fail('CANCELLED', '应用在串口访问前取消。')
  let result
  try {
    result = await runner({ action: 'flash', port: intent.port, mcu: intent.baseline.model,
      hex: intent.image.path, expectedSha256: intent.image.sha256, freqHz: intent.requestedFreqHz,
      clockMode: 'calibrate', waitSeconds, signal: settings.signal, onProgress: settings.onProgress,
      applicationId: plan.applicationId, optionsApplication: intent, debug: true, ...(expectedUid !== undefined ? { expectedUid } : {}) })
  } catch (error) {
    return { ok: false, error: 'APPLICATION_EXECUTOR_FAILED', message: String(error.message), executionRequested: true,
      applicationId: plan.applicationId, applicationPlan: plan, operationState: 'unknown-after-executor-error',
      eraseStarted: null, programAcknowledged: null, hardwareOptionsWritten: null,
      nextAction: '执行器异常，无法确认已经发生的步骤；先核对日志和冷启动状态，不能自动重试。' }
  }
  if (!result || typeof result !== 'object' || result.applicationId !== plan.applicationId) {
    return { ok: false, error: 'APPLICATION_NOT_CONFIRMED', message: '缺少有效执行回执或返回应用ID不符。',
      executionRequested: true, applicationId: plan.applicationId, applicationPlan: plan, executorReceipt: result ?? null,
      operationState: 'unknown-invalid-executor-receipt', eraseStarted: null, programAcknowledged: null, hardwareOptionsWritten: null,
      nextAction: '执行状态无法确认；核对回执和冷启动状态，不要自动重试。' }
  }
  const confirmed = result.ok === true && matchesExpectedUid(result, expectedUid) && result.stage === 'complete' && result.programmed === true &&
    result.hardwareOptionsWritten === true && result.optionsWrite?.acknowledged === true && result.optionsWrite.msrHex === intent.afterMsrHex
  return { ...result, ok: confirmed, applicationId: plan.applicationId, applicationPlan: plan, executionRequested: true,
    ...(!confirmed && result.ok === true ? { error: 'APPLICATION_NOT_CONFIRMED', message: '执行器未返回完整的代码/选项确认或应用ID不符。' } : {}) }
}
