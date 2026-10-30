// 工具定义（纯数据 + execute，不 import dsh-tools，方便脱离宿主自测）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createLog, loadBoards, resolveConfig } from './config.js'
import { buildProject, summarizeBuild } from './build.js'
import { baudTable, calcBaud, calcDac, calcDelay, calcTimer, calcUltrasonic } from './calc.js'
import { doctor, summarizeDoctor } from './doctor.js'
import { detectKeil, resetDiscoveryCache } from './discover.js'
import { preflightHex, resolveHexTarget, summarizeFlash } from './flash.js'
import { makeIspPlan, runIsp } from './isp.js'
import { matchesExpectedUid } from './session-parameters.js'
import { optionSchema, planOptions } from './hardware-options.js'
import { queryCatalog } from './catalog.js'
import { runImageAction } from './image.js'
import { runMemoryPlan } from './memory-plan.js'
import { prepareMemoryApplication, applyMemoryApplication, readMemoryApplication } from './memory-application.js'
import { prepareImageFlash } from './image-flash.js'
import { prepareOptionsApplication, applyOptionsApplication } from './options-application.js'
import { renderGlyph, summarizeGlyph } from './glyph.js'
import { findProject, listProjects, registerProject, removeProject } from './projects.js'
import { captureSerial, logSerial, summarizeSerial } from './serial.js'
import { parseScore, summarizeTone } from './tone.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true, description: '这次操作是否成功。' },
    summary: { type: 'string', required: true, description: '人能直接读的结论（markdown，含关键数字与下一步）。' },
    data: { type: 'json', description: '结构化明细，字段随工具不同。' },
    logPath: { type: 'string', description: '完整日志落盘路径（长输出都在这里）。' },
  },
  additionalProperties: true,
}

const renderText = (markdown) => [{ type: 'text', text: markdown }]

/** 统一包一层 try/catch：工具永远返回结构化结果而不是抛异常。 */
function safe(name, fn) {
  return async (args, exec) => {
    try {
      const value = await fn(args ?? {}, exec)
      return {
        ok: Boolean(value?.ok),
        summary: value?.summary ?? '',
        ...(value?.data !== undefined ? { data: value.data } : {}),
        ...(value?.logPath !== undefined ? { logPath: value.logPath } : {}),
        ...(value?.extra ?? {}),
      }
    } catch (error) {
      return { ok: false, summary: `❌ ${name} 崩了：${error?.message ?? error}`, data: { error: String(error?.stack ?? error) } }
    }
  }
}

function boardById(boards, id) {
  return (boards.boards ?? []).find((b) => b.id === id) ?? null
}

function boardByMcu(boards, mcu) {
  if (!mcu) return null
  const upper = String(mcu).toUpperCase()
  return (boards.boards ?? []).find((b) => upper.includes(String(b.mcu).toUpperCase().slice(0, 5))) ?? null
}

/** 从工程登记 / 参数推断板子、型号、主频。 */
function inferTarget(boards, config, { mcu, board, fosc }) {
  const byBoard = board ? boardById(boards, board) : null
  const byMcu = mcu ? boardByMcu(boards, mcu) : null
  const chosen = byBoard ?? byMcu ?? null
  return {
    board: chosen,
    mcu: mcu ?? chosen?.mcu ?? config.defaultMcu ?? null,
    fosc: fosc ?? chosen?.fosc ?? null,
    port: config.defaultPort,
  }
}

/**
 * 组装全部工具定义。
 * @param {{defineTool: Function, config: ReturnType<typeof resolveConfig>, ispRunner?: Function, serialRunner?: Function}} options
 * Execution seams are internal; the DSH tool schema cannot set them.
 */
export function buildToolSpecs({ defineTool, config, ispRunner = runIsp, serialRunner = captureSerial }) {
  const boards = loadBoards(config.dataDir)
  const wrap = (spec) => defineTool({ ...spec, output: { schema: OUTPUT_SCHEMA, render: (_a, v) => renderText(v.summary) } })
  const specs = []

  // ---------------------------------------------------------------- doctor
  specs.push(
    wrap({
      name: 'mcu_doctor',
      description:
        '51 插件体检：检查内置运行时、串口、板级档案和工程登记。串口、取模和 ISP 无需安装 Python 或厂商软件。Keil 是可选编译器，未安装不影响其它功能。',
      parameters: {
        refresh: { type: 'boolean', description: 'true = 丢掉探测缓存重新扫盘（换了软件位置或插了新板子时用）' },
        serial: { type: 'boolean', description: '是否枚举串口，默认 true；只想看编译链时可以设 false 加速' },
      },
      execute: safe('mcu_doctor', async (args) => {
        if (args.refresh) resetDiscoveryCache()
        const result = await doctor({ dataDir: config.dataDir, config, serial: args.serial !== false })
        const log = createLog(config.dataDir, 'doctor')
        log.write(JSON.stringify(result, null, 2))
        return { ok: result.ok, summary: summarizeDoctor(result), data: result, logPath: log.path }
      }),
    }),
  )

  // ----------------------------------------------------------------- build
  specs.push(
    wrap({
      name: 'mcu_build',
      description:
        '用 Keil UV4 命令行编译 51 工程，把 build log 解析成结构化错误（文件(行): error Cxxx: 消息）+ Program Size + 产物 hex 的字节数与地址范围，并检查“hex 比源码旧”这个坑。改了代码要验证、或要出 hex 烧录时用。project 可以是 mcu_project 登记过的名字，也可以是工程目录或 .uvproj 绝对路径。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名（mcu_project 登记过）或工程目录 / .uvproj 绝对路径' },
        rebuild: { type: 'boolean', description: 'true = 全量重编（-r），默认增量' },
        flashKB: { type: 'number', description: '目标芯片 Flash 容量（KB）；登记过的工程会自动带上' },
        timeoutSeconds: { type: 'number', description: '编译超时，默认 240 秒' },
      },
      execute: safe('mcu_build', async (args, exec) => {
        const registered = findProject(config.dataDir, args.project)
        const projectPath = registered.ok ? registered.uvproj : args.project
        const keil = config.keilPath ?? (await detectKeil(config)).path
        const board = registered.ok ? boardById(boards, registered.board) : null
        const flashKB = Number(args.flashKB ?? board?.flashKB ?? 0) || null
        const logPath = join(config.dataDir, 'logs', `${stamp()}-uv4.log`)
        const result = await buildProject({
          project: projectPath,
          rebuild: Boolean(args.rebuild),
          keilPath: keil,
          flashKB,
          logPath,
          dataDir: config.dataDir,
          timeoutMs: Number(args.timeoutSeconds ?? 240) * 1000,
          signal: exec?.signal,
        })
        const log = createLog(config.dataDir, 'build')
        log.write(JSON.stringify({ project: args.project, result: { ...result, stdout: undefined } }, null, 2))
        return { ok: result.ok, summary: summarizeBuild(result), data: result, logPath: result.logPath ?? log.path }
      }),
    }),
  )

  // ----------------------------------------------------------------- flash
  specs.push(wrap({
    name: 'mcu_flash',
    description: '使用插件内置 STC 串口协议烧录 HEX或冻结的代码镜像，无需安装 ISP 或 Python，无 GUI/UAC。当前适配 STC89/90、STC15。先核对镜像身份/文件哈希/地址，握手后比对实际型号，收到擦写/选项应答才报告成功。等待开始后需要按下载键或冷启动 MCU。dryRun不开串口，但可创建生成的HEX文件。',
    parameters: {
      hex: { type: 'string', description: 'HEX 绝对路径或工程目录' },
      project: { type: 'string', description: '登记名或工程目录，与 hex 二选一' },
      image: { type: 'string', description: 'mcu_image保存的冻结镜像JSON绝对路径，与hex/project互斥；仅接受非空code、空eeprom' },
      expectedImageId: { type: 'string', description: 'image输入必须提供其完整imageId；字节与生成HEX文件SHA会传至内置协议做二次核对' },
      expectedUid: { type: 'string', description: '可选已知7字节芯片UID（14个十六进制字符），仅F449/7.2.5S内部IRC烧录；在擦除应答核对，不能在擦除前独立确认身份' },
      memoryApplication: { type: 'string', description: 'mcu_image prepare的组合应用日志绝对路径；仅F449/7.2.5S；不能混入hex/project/image/目标覆盖参数' },
      expectedMemoryApplicationId: { type: 'string', description: '组合应用必填完整applicationId；与离线memoryPlanId不同' },
      port: { type: 'string', description: '目标串口；请从 mcu_doctor 的枚举结果选择' },
      mcu: { type: 'string', description: '必须核对的芯片型号，登记工程可自动带入' },
      flasher: { type: 'string', enum: ['auto', 'builtin'], description: '均使用内置协议；不再支持软件宏' },
      freqHz: { type: 'integer', description: 'STC15 写入的 IRC 频率（整数Hz）；STC89 仅核对晶振频率' },
      clockMode: { type: 'string', enum: ['calibrate', 'preserve'], description: 'calibrate 重新校准并设置频率（CT107D/BSL7.2.5S已实测）；preserve 实验性快速下载，尚未通过实机验收，保留原有频率和硬件选项，频率不符则拒绝' },
      waitSeconds: { type: 'integer', description: '等待冷启动握手，1~300整数秒，默认60' },
      verify: { type: 'boolean', description: 'true 请求独立 Flash 读回，当前不支持，会在擦写前拒绝；默认按协议应答验证' },
      dryRun: { type: 'boolean', description: '只预检、生成计划，不开串口' },
    },
    execute: safe('mcu_flash', async (args, exec) => {
      if (args.flasher && !['auto', 'builtin'].includes(args.flasher)) return { ok: false, summary: '旧的软件封装已移除，请使用 flasher=builtin。' }
      if (args.verify === true) return { ok: false, summary: '当前协议引擎不支持独立 Flash 读回；未打开串口、未擦写。默认验证依据为芯片对写入和选项设置的协议应答。' }
      if (args.verify !== undefined && typeof args.verify !== 'boolean') return { ok: false, summary: 'verify必须为布尔值；未打开串口。' }
      if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') return { ok: false, summary: 'dryRun必须为布尔值；未打开串口。' }
      if (args.hex !== undefined && args.project !== undefined) return { ok: false, summary: 'hex/project必须二选一；未打开串口。' }
      if (args.memoryApplication !== undefined || args.expectedMemoryApplicationId !== undefined) {
        let result
        if (Object.keys(args).some(k => !['memoryApplication', 'expectedMemoryApplicationId', 'dryRun', 'waitSeconds', 'flasher', 'verify', 'expectedUid'].includes(k))) {
          result = { ok: false, error: 'MEMORY_PARAMETER_CONFLICT', message: '组合应用只采用已绑定目标和文件，不能混入独立输入或目标覆盖。', hardwareAccess: false }
        } else {
          const application = readMemoryApplication(args.memoryApplication)
          result = application.ok ? await applyMemoryApplication(application, args.expectedMemoryApplicationId,
            { dryRun: args.dryRun, waitSeconds: args.waitSeconds, signal: exec?.signal, expectedUid: args.expectedUid }, ispRunner) : application
        }
        let logPath = null, logError = null
        try {
          const log = createLog(config.dataDir, 'memory-apply')
          log.write(JSON.stringify(result, null, 2)); logPath = log.path
        } catch (error) { logError = String(error.message) }
        const summary = result.ok ? result.dryRun ? '组合计划、来源及生成字节已复核；未打开串口。' :
          '组合代码/共享IAP数据和选项均收到协议确认；尚无独立Flash读回，需冷启动核对。' : '组合应用未完成：' + result.error + '；' + result.message
        return { ok: result.ok && !logError, summary: summary + (logError ? '\n日志保存失败，操作回执保留：' + logError : ''),
          data: { ...result, ...(logError ? { logError, logPersisted: false } : {}) }, logPath }
      }
      const registered = args.project ? findProject(config.dataDir, args.project) : { ok: false }
      const target = inferTarget(boards, config, {
        mcu: args.mcu ?? (registered.ok ? registered.mcu : null),
        board: registered.ok ? registered.board : null,
        fosc: args.freqHz ?? (registered.ok ? registered.fosc : null),
      })
      const file = args.image !== undefined || args.expectedImageId !== undefined ? prepareImageFlash(args, config.dataDir) : args.hex ? resolveHexTarget({ hex: args.hex }) :
        registered.ok ? resolveHexTarget({ hex: registered.hex && existsSync(registered.hex) ? registered.hex : undefined, project: registered.dir }) :
        resolveHexTarget({ project: args.project })
      if (!file.ok) return { ok: false, summary: file.message, data: file }
      const preflight = preflightHex(file.path, target.board?.flashKB)
      if (!preflight.ok) return { ok: false, summary: preflight.message, data: { preflight } }
      if (file.imageBinding && preflight.sha256 !== file.imageBinding.hexSha256) return { ok: false, summary: '生成HEX在镜像预检后发生变化，未打开串口。', data: { error: 'HEX_CHANGED', preflight } }
      const options = {
        action: 'flash', port: args.port ?? (registered.ok ? registered.port : null) ?? config.defaultPort,
        mcu: target.mcu, hex: preflight.path, expectedSha256: preflight.sha256,
        freqHz: target.fosc, clockMode: args.clockMode, expectedUid: args.expectedUid, waitSeconds: args.waitSeconds === undefined ? config.flashWaitSeconds : args.waitSeconds,
        signal: exec?.signal,
        ...(file.imageBinding ? { imageBinding: file.imageBinding } : {}),
      }
      const plan = makeIspPlan(options)
      if (plan.expectedUid !== undefined) options.expectedUid = plan.expectedUid
      if (args.dryRun) return { ok: plan.runtime.ok, summary: 'dryRun：未打开串口。\n内置协议：' + plan.protocol + '\n芯片：' + plan.mcu + ' @ ' + plan.port + (plan.imageBinding ? '\n镜像ID：' + plan.imageBinding.imageId + '\n代码字节SHA256：' + plan.imageBinding.denseSha256 : '') + '\nHEX SHA256：' + preflight.sha256 + '\n' + plan.hint, data: { plan, preflight } }
      const result = await ispRunner(options)
      if (result.ok === true && !matchesExpectedUid(result, plan.expectedUid)) Object.assign(result, {
        ok: false, error: 'TARGET_RECEIPT_MISMATCH', message: '执行回执缺少已知UID或超时恢复确认；保留已发生的擦写状态。',
        nextAction: '核对原始回执，不自动重试。UID核对位于擦除请求之后。' })
      result.preflight = preflight
      let logPath = null, logError = null
      try {
        const log = createLog(config.dataDir, 'flash')
        log.write(JSON.stringify({ plan, result }, null, 2))
        logPath = log.path
      } catch (error) { logError = String(error.message) }
      return { ok: result.ok && !logError, summary: summarizeFlash(result) + (logError ? '\n日志保存失败：' + logError : ''),
        data: { plan, result, ...(logError ? { logError, logPersisted: false } : {}) }, logPath }
    }),
  }))

  // -------------------------------------------------------------- chipinfo
  specs.push(wrap({
    name: 'mcu_chipinfo',
    description: '通过内置 STC 串口协议读取型号、BSL、频率及结构化硬件选项（含原始MSR、未知字段和解码来源），无 ISP、无 UAC。不擦除、不编程、不做 IRC 校准；需要按下载键或冷启动 MCU，读取后发送协议退出指令恢复运行。',
    parameters: {
      port: { type: 'string', description: '目标串口' },
      mcu: { type: 'string', description: '预期型号；省略时自动识别已适配系列' },
      waitSeconds: { type: 'integer', description: '等待启动握手，1~300整数秒，默认60' },
      dryRun: { type: 'boolean', description: '只生成计划，不开串口' },
    },
    execute: safe('mcu_chipinfo', async (args, exec) => {
      if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') return { ok: false, summary: 'dryRun必须为布尔值；未打开串口。' }
      const options = { action: 'chipinfo', port: args.port === undefined ? config.defaultPort : args.port, mcu: args.mcu ?? config.defaultMcu, waitSeconds: args.waitSeconds, signal: exec?.signal }
      const plan = makeIspPlan(options)
      if (args.dryRun) return { ok: plan.runtime.ok, summary: 'dryRun：内置协议 ' + plan.protocol + ' @ ' + plan.port + '；只读芯片状态，未打开串口。\n' + plan.hint, data: { plan } }
      const result = await runIsp(options)
      const log = createLog(config.dataDir, 'chipinfo')
      log.write(JSON.stringify(result, null, 2))
      const snapshot = result.chip?.hardwareOptions
      const optionSummary = snapshot?.available ? '\n硬件选项 ' + Object.keys(snapshot.values).length + ' 项；原始MSR：' + snapshot.rawMsrHex + (snapshot.unknownFields.length ? '；未识别字段：' + snapshot.unknownFields.join(', ') : '') : '\n硬件选项：本次会话尚无解码器。'
      const summary = result.ok ? '芯片：' + result.chip.model + '，BSL ' + result.chip.bslVersion + '，频率 ' + result.chip.freqHz + ' Hz；Flash 未擦写。' + optionSummary : '读取失败（' + result.stage + '）：' + result.error + ' ' + (result.message ?? '')
      return { ok: result.ok, summary, data: result, logPath: log.path }
    }),
  }))

  // --------------------------------------------------------------- options
  specs.push(wrap({
    name: 'mcu_options',
    description: '硬件选项：schema定义、read查询、plan差异、prepare应用计划。apply需要计划文件与预期ID；先重读基线，再请求代码擦除/重写HEX/重新IRC校准/写选项。实际物理擦除范围未知。apply的dryRun只复核文件，不开串口。独立04写入尚未支持。',
    parameters: {
      action: { type: 'string', required: true, enum: ['schema', 'read', 'plan', 'prepare', 'apply'], description: 'schema字段定义；read查询；plan差异；prepare应用计划；apply完整代码重刷及选项应用' },
      mcu: { type: 'string', description: 'schema的型号；read的预期型号；plan以快照身份为准' },
      port: { type: 'string', description: 'read的串口；prepare必须显式绑定目标COM端口' },
      hex: { type: 'string', description: 'prepare：将重写的HEX绝对路径，计划绑定SHA256' },
      freqHz: { type: 'number', description: 'prepare：明确重新校准的内部IRC频率Hz整数' },
      waitSeconds: { type: 'number', description: '仅read使用，等待启动握手1~300秒' },
      snapshot: { type: 'string', description: '仅plan：成功完成的只读chipinfo日志JSON文件' },
      patch: { type: 'json', description: '仅plan：字段名到严格类型值的JSON对象，不接受字符串布尔值/数字' },
      expectedUid: { type: 'string', description: '仅apply：可选已知14位十六进制UID，在擦除应答核对；不能在擦除前独立确认身份' },
      application: { type: 'string', description: 'apply：prepare生成的计划日志JSON绝对路径' },
      expectedApplicationId: { type: 'string', description: 'apply：已核对计划的完整applicationId，避免文件变化后执行不同意图' },
      dryRun: { type: 'boolean', description: 'apply设true只复核计划与HEX，不访问硬件' },
    },
    execute: safe('mcu_options', async (args, exec) => {
      if (args.expectedUid !== undefined && args.action !== 'apply') return { ok: false, summary: 'expectedUid仅用于apply；未访问串口。' }
      if (args.action === 'read') return specs.find(spec => spec.name === 'mcu_chipinfo').execute(args, exec)
      if (args.action === 'apply') {
        let result
        let prepared
        if (typeof args.application !== 'string' || !args.application) result = { ok: false, error: 'APPLICATION_PLAN_REQUIRED', message: '请提供prepare生成的计划文件和expectedApplicationId。', hardwareAccess: false }
        else {
          try {
            if (statSync(args.application).size > 2 * 1024 * 1024) throw new Error('应用计划超过2MiB限制。')
            prepared = JSON.parse(readFileSync(args.application, 'utf8').replace(/^\uFEFF/, ''))
          } catch (error) { result = { ok: false, error: 'INVALID_APPLICATION_FILE', message: String(error.message), hardwareAccess: false } }
        }
        if (!result) result = await applyOptionsApplication(prepared, args.expectedApplicationId, { dryRun: args.dryRun, waitSeconds: args.waitSeconds, signal: exec?.signal,
          port: args.port, mcu: args.mcu, hex: args.hex, freqHz: args.freqHz, patch: args.patch, snapshot: args.snapshot, expectedUid: args.expectedUid }, ispRunner)
        let logPath
        let logError
        try {
          const log = createLog(config.dataDir, 'options-apply')
          log.write(JSON.stringify(result, null, 2))
          logPath = log.path
        } catch (error) {
          logError = String(error.message)
          result.logError = logError
          result.logPersisted = false
        }
        const summary = result.ok ? result.dryRun ? '应用计划和HEX已复核：' + result.applicationId + '。未打开串口；真实apply会擦除整个代码区并重新校准。' : '代码重刷和选项写入已收到协议确认：' + result.applicationId + '。需另一次冷启动只读核对选项；不是独立Flash读回。' : '应用未完成：' + result.error + '；' + (result.message ?? '') + '\n' + (result.nextAction ?? '未开始新的硬件操作。')
        return { ok: result.ok && !logError, summary: summary + (logError ? '\n日志保存失败（操作回执保留）：' + logError : ''), data: result, logPath }
      }
      let result
      if (args.action === 'schema') result = optionSchema(args.mcu)
      else if (['plan', 'prepare'].includes(args.action)) {
        if (typeof args.snapshot !== 'string' || !args.snapshot) result = { ok: false, error: 'INVALID_SNAPSHOT_FILE', message: '请提供只读chipinfo JSON文件路径。', hardwareAccess: false, executable: false }
        else {
          try {
            if (statSync(args.snapshot).size > 2 * 1024 * 1024) result = { ok: false, error: 'SNAPSHOT_TOO_LARGE', message: '快照超过2MiB限制。', hardwareAccess: false, executable: false }
            else {
              const bytes = readFileSync(args.snapshot)
              const snapshot = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
              if (args.mcu && args.mcu !== (snapshot?.chip ?? snapshot?.data?.chip)?.model) result = { ok: false, error: 'TARGET_MISMATCH', message: '指定型号与快照不同。', hardwareAccess: false, executable: false }
              else {
                const metadata = { fileSha256: createHash('sha256').update(bytes).digest('hex') }
                result = args.action === 'prepare' ? prepareOptionsApplication(snapshot, args.patch, args, metadata) : planOptions(snapshot, args.patch, metadata)
              }
            }
          } catch (error) {
            result = { ok: false, error: 'INVALID_SNAPSHOT_FILE', message: String(error.message), hardwareAccess: false, executable: false }
          }
        }
      } else result = { ok: false, error: 'UNKNOWN_OPTIONS_ACTION', message: '仅提供schema/read/plan/prepare/apply。', hardwareAccess: false, executable: false }
      const log = createLog(config.dataDir, 'options-' + (['schema', 'prepare'].includes(args.action) ? args.action : 'plan'))
      log.write(JSON.stringify(result, null, 2))
      const summary = result.ok ? (args.action === 'schema' ? '离线字段定义：' + result.profile.model + '，' + result.fields.length + '项；未打开串口。' : args.action === 'prepare' ? '离线应用计划 ' + result.applicationId + '：请求代码区擦除并重写HEX，名义代码区' + result.effects.nominalCodeBytes + '字节；命令不编码精确代码擦除长度。重新校准IRC至请求' + result.intent.requestedFreqHz + 'Hz，再应用选项。\nHEX SHA256：' + result.intent.image.sha256 + '\n未执行；不承诺保留代码地址范围内的IAP数据。' : '离线选项计划：' + result.changes.length + '项变化，MSR ' + result.beforeMsrHex + ' → ' + result.afterMsrHex + '。未打开串口；需prepare后才能apply完整代码重刷。') : '选项操作失败：' + result.error + '；' + result.message
      return { ok: result.ok, summary, data: result, logPath: log.path }
    }),
  }))

  // --------------------------------------------------------------- catalog
  specs.push(wrap({
    name: 'mcu_catalog',
    description: '离线查询官方STC-ISP6.75型号名称、主/备用magic、分页、来源；memory按唯一记录ID读取官方容量表项和已核验手册布局，区分IAP/MOVC/文件地址。未核验布局/ISP读回及擦除影响保留未知；目录不代表下载支持。不开串口、不调用官方软件。',
    parameters: {
      action: { type: 'string', enum: ['search', 'get', 'stats', 'memory'], description: '默认search；get按记录ID读取；memory按唯一id查询存储；stats统计来源和范围' },
      query: { type: 'string', description: '名称子串，不区分大小写，最多80字符' },
      magic: { type: 'string', description: '四位十六进制magic，如F449；同时搜索主/备用ID，歧义保留全部匹配' },
      id: { type: 'string', description: 'get/memory使用search返回的记录ID，例如stc675:8；memory仅接受action和id' },
      labelKind: { type: 'string', enum: ['chip-name', 'device-label'], description: '名称前缀分类，非协议或硬件能力分类' },
      offset: { type: 'integer', description: 'search分页偏移，默认0' },
      limit: { type: 'integer', description: 'search每页1~100，默认20' },
    },
    execute: safe('mcu_catalog', async (args) => {
      const result = queryCatalog(args)
      const log = createLog(config.dataDir, 'catalog')
      log.write(JSON.stringify(result, null, 2))
      let summary
      if (!result.ok) summary = '目录查询失败：' + result.error + '；' + result.message
      else if (args.action === 'memory') {
        const { tableFacts, layout } = result.record.memory
        summary = result.record.id + '：' + result.record.name + '\n官方代码容量表项：' + tableFacts.codeBytes + '字节；EEPROM容量表项：' + tableFacts.eepromBytes + '字节；EEPROM文件地址基址：0x' + tableFacts.eepromFileBase.toString(16) + '。\n' +
          (layout ? (layout.dataOverlapsCode ? 'IAP数据与程序共享Flash；EEPROM栏为0不代表不能保存数据。' : '手册区分IAP数据地址和MOVC映射地址。') + ' IAP擦除扇区：' + layout.iapEraseSectorBytes + '字节。' : '物理布局和IAP擦除扇区尚未核验。') +
          '\n来源：官方6.75表/已列手册，离线核验。擦除保留效果和读回能力未知。' +
          (result.pluginOperations.memoryApplication ? '\nF449/7.2.5S有受约束组合重刷适配，需mcu_image prepare；仅离线验证，尚未实机。' : '\n此型号EEPROM下载尚未接入。')
      } else summary = (args.action === 'stats' ? '官方静态目录：' + result.totalRecords + '条记录，' + result.uniquePrimaryMagic + '个不同主magic。' : args.action === 'get' ? result.record.id + '：' + result.record.name + '，主magic ' + result.record.primaryMagic : '目录匹配' + result.totalMatches + '条，本页' + result.records.length + '条。\n' + result.records.map(record => record.id + ' ' + record.name + ' [' + record.primaryMagic + (record.alternateMagic ? '/' + record.alternateMagic : '') + ']').join('\n')) + '\n数据来源：STC-ISP6.75结构表；离线查询。容量表项/布局另见memory，目录不推断下载能力或协议。'
      return { ok: result.ok, summary, data: result, logPath: log.path }
    }),
  }))

  // ----------------------------------------------------------------- image
  specs.push(wrap({
    name: 'mcu_image',
    description: '离线代码/EEPROM逻辑缓冲区：导入HEX/BIN、合并/边界校验、冻结字节及导出。plan用冻结镜像和唯一targetId预览18个手册型号/声明BSL7.2的组合写入、填充及官方擦除参数；共享数据须显式放置，计划不可执行。不开串口、不烧录。',
    parameters: {
      action: { type: 'string', enum: ['compose', 'inspect', 'export', 'plan', 'prepare'], description: '默认compose；inspect查看；export导出；plan仅预览；prepare绑定F449受约束组合及恢复文件，仍不开串口' },
      sources: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true, description: '输入文件绝对路径' },
        buffer: { type: 'string', enum: ['code', 'eeprom'], description: '默认code；eeprom是独立逻辑空间' },
        format: { type: 'string', enum: ['hex', 'bin'], description: '默认按扩展名判断，其他扩展名须显式指定' },
        offset: { type: 'integer', description: '非负地址偏移；BIN从此地址放置，HEX原地址加此值，默认0' },
      } }, description: 'compose的0~32个输入；[]清空两缓冲区，每次compose都从空白开始' },
      fillByte: { type: 'integer', description: 'compose的空洞填充值0~255，默认255；导出从地址0至最高数据地址，HEX/BIN字节一致' },
      image: { type: 'string', description: 'inspect/export/plan使用compose返回的logPath镜像文件绝对路径' },
      expectedImageId: { type: 'string', description: 'export/plan必填完整imageId；inspect可选核对' },
      buffer: { type: 'string', enum: ['code', 'eeprom'], description: '导出哪一逻辑缓冲区，默认code' },
      format: { type: 'string', enum: ['hex', 'bin'], description: '导出格式，默认hex；含起始地址元数据时禁止丢失为BIN' },
      targetId: { type: 'string', description: 'plan必填，mcu_catalog返回的唯一记录id；当前仅18个已核对布局' },
      bslVersion: { type: 'string', description: 'plan必填，调用者声明的7.2族版本，如7.2.5S；预览不连接确认' },
      erasePolicy: { type: 'string', enum: ['code', 'code-and-data'], description: 'plan必填；独立EEPROM数据需code-and-data，共享IAP或无数据需code' },
      eepromOffset: { type: 'integer', description: 'plan中EEPROM逻辑地址0对应的IAP偏移；共享IAP数据必填且512对齐，独立数据默认0' },
      expectedMemoryPlanId: { type: 'string', description: 'prepare必填：先前核对的完整memoryPlanId' },
      snapshot: { type: 'string', description: 'prepare必填：成功完成的只读chipinfo日志绝对路径' },
      port: { type: 'string', description: 'prepare必填：绑定目标COM端口，不使用默认值' },
      freqHz: { type: 'integer', description: 'prepare必填：当前仅允许12000000；执行会重新校准' },
      recoveryHex: { type: 'string', description: 'prepare必填：与code缓冲区展开字节相同的代码恢复HEX绝对路径；另生成密集恢复副本' },
    },
    execute: safe('mcu_image', async (args) => {
      const mixed = !['plan', 'prepare'].includes(args.action) && ['targetId', 'bslVersion', 'erasePolicy', 'eepromOffset',
        'expectedMemoryPlanId', 'snapshot', 'port', 'freqHz', 'recoveryHex'].some(key => args[key] !== undefined)
      const result = mixed ? { ok: false, error: 'MEMORY_ARGUMENT', message: '存储预览参数只用于plan。', hardwareAccess: false } :
        args.action === 'plan' ? runMemoryPlan(args) : args.action === 'prepare' ? prepareMemoryApplication(args, config.dataDir) : runImageAction(args, config.dataDir)
      let logPath = null, logError = null
      try {
        const log = createLog(config.dataDir, 'image-' + (args.action ?? 'compose'))
        log.write(JSON.stringify(result, null, 2))
        logPath = log.path
      } catch (error) { logError = String(error.message) }
      // Keep segment hex in the saved artifact; summaries remain small in DSH.
      const data = result.buffers ? { ...result, buffers: Object.fromEntries(Object.entries(result.buffers).map(([role, { segments: _segments, ...summary }]) => [role, summary])) } : result
      const summary = result.ok ? (args.action === 'prepare' ? '组合应用已准备：' + result.applicationId + '\n组合写入' + result.intent.image.denseBytes + '字节；重新校准12MHz、写回原5字节MSR。\n最后512字节不编程；擦除保留未知。恢复文件：' + result.intent.codeRecovery.path + '\n未执行；新数据实测需明确授权。' : args.action === 'plan' ? '离线擦写影响预览 ' + result.memoryPlanId + '\n' + result.target.model + '，声明BSL ' + result.target.bslVersion + '；组合写入' + result.programImage.bytes + '字节，区域间填充FF共' + result.effects.interBufferFillBytes + '字节。\n擦除请求 ' + result.wire.erasePayloadHex + '；精确物理擦除范围未知，数据保留不保证。\n未执行；计划不能用于直接烧录。' : result.path ? '已导出：' + result.path + '\n文件SHA256 ' + result.sha256 :
        '离线镜像 ' + result.imageId + '\n' + Object.entries(result.buffers).map(([role, buffer]) => role + '：' + buffer.dataBytes + '字节数据，展开' + buffer.denseBytes + '字节，填充' + buffer.fillByte + '，SHA256 ' + buffer.denseSha256).join('\n')) +
        '\ncode/eeprom为独立逻辑缓冲区；未访问硬件。' : '镜像操作失败：' + result.error + '；' + result.message
      return { ok: result.ok && !logError, summary: summary + (logError ? '\n日志保存失败：' + logError : ''),
        data: logError ? { ...data, logError } : data, logPath }
    }),
  }))

  // ---------------------------------------------------------------- serial
  specs.push(
    wrap({
      name: 'mcu_serial',
      description:
        '带时间戳的串口抓包/文本与HEX发送。先验证编码、帧配置和预算，冻结发送字节后执行；支持自动试波特率、截止条件和流控。dryRun完整预检且不开串口。自动试速只读，正式发送只执行一次。',
      parameters: {
        port: { type: 'string', description: '串口，默认 config.defaultPort（本机 COM9）' },
        baud: { type: 'integer', description: '波特率1~4000000，实际支持由驱动决定；与autoBaud=true互斥' },
        autoBaud: { type: 'boolean', description: 'true = 逐档试波特率，取最像样的那档' },
        seconds: { type: 'number', description: '抓多久，默认 5 秒' },
        send: { type: 'json', description: '字符串数组、分号短写，或对象数组；对象用text/hex二选一，可设delayMs及newline。数组文本保留空白，HEX不加换行' },
        sendHex: { type: 'array', items: { type: 'string' }, description: '十六进制发送，例如 ["AA 55 00 FF"]，不追加换行' },
        dataMode: { type: 'string', enum: ['text', 'binary'], description: '默认 text；binary 按原始字节收发，不按可打印比例判错' },
        until: { type: 'string', description: '收到包含该子串的行就提前结束' },
        newline: { type: 'string', enum: ['crlf', 'lf', 'cr', 'none'], description: '每条指令后加什么，默认 crlf' },
        maxLines: { type: 'integer', description: '最多记录1~10000行，默认400；binary模式按字节/时间截止' },
        maxBytes: { type: 'integer', description: '最大接收字节数1~65536，默认65536；到限即结束并报告stopReason' },
        dataBits: { type: 'integer', enum: [5, 6, 7, 8], description: '数据位，默认8；当前采用8250兼容组合，不接受5数据位配2停止位；发送字节必须能放入数据位' },
        parity: { type: 'string', enum: ['N', 'E', 'O', 'M', 'S'], description: '无/偶/奇/标记/空格校验，默认N' },
        stopBits: { type: 'number', enum: [1, 1.5, 2], description: '停止位，默认1；1.5仅可配5数据位' },
        encoding: { type: 'string', enum: ['ascii', 'utf-8', 'gbk', 'latin1'], description: '文本发送/接收编码；默认ascii，无法严格编码时在串口访问前拒绝' },
        rtscts: { type: 'boolean', description: 'RTS/CTS硬件流控，默认false；启用需noReset=false，不与xonxoff同时使用' },
        dsrdtr: { type: 'boolean', description: 'DSR/DTR硬件流控，默认false；启用需noReset=false' },
        xonxoff: { type: 'boolean', description: '软件流控，默认false' },
        noReset: { type: 'boolean', description: '默认true，打开前请求DTR/RTS低；系统/驱动仍可能有毛刺，不能保证板子不复位' },
        baudCandidates: { type: 'array', items: { type: 'integer' }, description: 'autoBaud=true时的1~16个不同波特率；默认配置列表' },
        trialSeconds: { type: 'number', description: '自动试速每档0.05~10秒，默认2秒' },
        openDelayMs: { type: 'integer', description: '正式打开后的等待0~30000毫秒，默认0' },
        openRetrySeconds: { type: 'number', description: '初次打开失败的显式重试窗口0~30秒；默认0，不重试' },
        writeTimeoutSeconds: { type: 'number', description: '每条发送写超时0.05~10秒，默认2秒；总预算另含线路传输时间' },
        untilRegex: { type: 'string', description: '文本行截止条件，Python正则，最多512字符；无效表达式提前拒绝' },
        dryRun: { type: 'boolean', description: '验证全部参数/编码并返回冻结计划、发送字节与预算，不取得端口锁' },
        saveLog: { type: 'boolean', description: '是否把全文落盘，默认 true' },
      },
      execute: safe('mcu_serial', async (args, exec) => {
        if (args.saveLog !== undefined && typeof args.saveLog !== 'boolean') return { ok: false, summary: 'saveLog必须为布尔值；未打开串口。' }
        const port = args.port === undefined ? config.defaultPort : args.port
        const registeredWithBaud = typeof port === 'string' ? listProjects(config.dataDir).find((p) => typeof p.port === 'string' && p.port.toUpperCase() === port.toUpperCase() && p.baud) : null
        const baud = args.autoBaud === true ? args.baud : (args.baud === undefined ? registeredWithBaud?.baud : args.baud)
        const stats = await serialRunner({
          port,
          baud,
          autoBaud: args.autoBaud,
          baudCandidates: args.baudCandidates === undefined ? (args.autoBaud === true ? config.serialBauds : undefined) : args.baudCandidates,
          seconds: args.seconds,
          send: args.send,
          sendHex: args.sendHex,
          dataMode: args.dataMode,
          until: args.until,
          newline: args.newline,
          maxLines: args.maxLines, maxBytes: args.maxBytes, dataBits: args.dataBits, parity: args.parity, stopBits: args.stopBits,
          encoding: args.encoding, rtscts: args.rtscts, dsrdtr: args.dsrdtr, xonxoff: args.xonxoff, noReset: args.noReset,
          trialSeconds: args.trialSeconds, openDelayMs: args.openDelayMs, openRetrySeconds: args.openRetrySeconds,
          writeTimeoutSeconds: args.writeTimeoutSeconds, untilRegex: args.untilRegex, dryRun: args.dryRun,
          signal: exec?.signal,
        })
        let logPath, logError
        try { logPath = args.saveLog === false ? undefined : logSerial(config.dataDir, stats, 'serial') }
        catch (error) { logError = String(error.message) }
        const ok = Boolean(stats.ok) && !logError && (stats.dryRun === true || (args.dataMode === 'binary' ? (stats.bytes ?? 0) > 0 : ((stats.lineCount ?? 0) > 0 || ((stats.bytes ?? 0) > 0 && (stats.printableRatio ?? 0) > 0.8))))
        return { ok, summary: summarizeSerial(stats, { dataMode: args.dataMode }) + (logError ? '\n日志保存失败：' + logError : ''),
          data: { ...stats, ...(Array.isArray(stats.lines) ? { lines: stats.lines.slice(0, 200) } : {}), ...(logError ? { logError, logPersisted: false } : {}) }, logPath }
      }),
    }),
  )

  // ------------------------------------------------------------------ calc
  specs.push(
    wrap({
      name: 'mcu_calc',
      description:
        '51 计算器（替代「51波特率初值设定」与「单片机小精灵」）。kind=baud 算 TH1/SMOD 与误差；kind=baud_table 出某主频下全部标准波特率的可行性与误差表（能直接回答“12MHz 下 9600 行不行”）；kind=timer 算定时器重装值；kind=delay 算软件延时循环次数；kind=dac 算 PCF8591 的数值/电压/距离映射；kind=ultrasonic 算 PCA 计数与厘米。每条都带公式和可直接粘贴的 C 代码。',
      parameters: {
        kind: { type: 'string', required: true, enum: ['baud', 'baud_table', 'timer', 'delay', 'dac', 'ultrasonic'], description: '算哪一类' },
        fosc: { type: 'number', description: '主频 Hz：普中 STC89 用 11059200，CT107D 比赛用 12000000' },
        baud: { type: 'number', description: 'kind=baud 的目标波特率' },
        mode: { type: 'string', enum: ['timer1-12t', 'timer1-1t', 'timer2-1t'], description: '波特率发生器：12T/1T 的 Timer1，或 STC15 的 Timer2（1T）' },
        smod: { type: 'number', description: 'SMOD 位：0 或 1（1 = 波特率加倍）' },
        clock: { type: 'string', enum: ['12t', '1t'], description: 'kind=timer/delay 的定时器时钟' },
        ms: { type: 'number', description: 'kind=timer/delay 的时间（毫秒）' },
        us: { type: 'number', description: 'kind=timer 的时间（微秒），与 ms 二选一' },
        prescaler: { type: 'number', description: '定时器预分频，默认 1' },
        timerMode: { type: 'string', enum: ['1', '2', 'auto'], description: 'kind=timer：1=16 位，2=8 位自动重装，auto=自动' },
        value: { type: 'number', description: 'kind=dac：0~255 的 DAC 数值' },
        volt: { type: 'number', description: 'kind=dac：目标电压（0~5V）' },
        distanceCm: { type: 'number', description: 'kind=dac：12 届国赛距离映射（10cm→1.0V，80cm→5.0V）' },
        ticks: { type: 'number', description: 'kind=ultrasonic：PCA 计数值' },
        cm: { type: 'number', description: 'kind=ultrasonic：距离（厘米）' },
      },
      execute: safe('mcu_calc', async (args) => {
        const fosc = Number(args.fosc ?? boardById(boards, 'CT107D')?.fosc ?? 12_000_000)
        switch (args.kind) {
          case 'baud': {
            const result = calcBaud({ fosc, baud: Number(args.baud), mode: args.mode ?? 'timer1-12t', smod: Number(args.smod ?? 0) })
            return { ok: result.ok, summary: summarizeCalc(result), data: result }
          }
          case 'baud_table': {
            const result = baudTable({ fosc, mode: args.mode ?? 'timer1-12t', smod: Number(args.smod ?? 0) })
            return { ok: true, summary: summarizeBaudTable(result), data: result }
          }
          case 'timer': {
            const result = calcTimer({
              fosc,
              ms: Number(args.ms ?? 0),
              us: Number(args.us ?? 0),
              mode: args.timerMode === 'auto' ? 'auto' : Number(args.timerMode ?? 1),
              clock: args.clock ?? '12t',
              prescaler: Number(args.prescaler ?? 1),
            })
            return { ok: result.ok, summary: summarizeCalc(result), data: result }
          }
          case 'delay': {
            const result = calcDelay({ fosc, ms: Number(args.ms ?? 1), clock: args.clock ?? '12t' })
            return { ok: result.ok, summary: summarizeCalc(result), data: result }
          }
          case 'dac': {
            const result = calcDac({ value: args.value, volt: args.volt, distanceCm: args.distanceCm })
            return { ok: true, summary: summarizeCalc(result), data: result }
          }
          case 'ultrasonic': {
            const result = calcUltrasonic({ fosc, ticks: args.ticks, cm: args.cm })
            return { ok: result.ok, summary: summarizeCalc(result), data: result }
          }
          default:
            return { ok: false, summary: `❌ 不认识 kind=${args.kind}` }
        }
      }),
    }),
  )

  // ----------------------------------------------------------------- glyph
  specs.push(
    wrap({
      name: 'mcu_glyph',
      description:
        '取模（替代「取字模软件」和 Img2Lcd）：文字或图片 → 点阵 → 可直接粘贴的 C 数组，同时生成放大预览 PNG。汉字 12/14/16 用点阵字体原尺寸渲染最清楚，英文/图片走 4 倍超采样。可选横向/纵向取模、MSB/LSB、阴/阳码，正好对上 51 点阵屏（74HC595）与 OLED 的两种习惯。',
      parameters: {
        text: { type: 'string', description: '要取模的文字（可多个字，每个字一份数据）' },
        image: { type: 'string', description: '图片绝对路径（与 text 二选一）' },
        size: { type: 'string', description: '点阵尺寸，如 8x8 / 12x12 / 16x16 / 32x32，默认 16x16' },
        font: { type: 'string', description: '字体文件路径；默认汉字 simsun、英文 consola' },
        threshold: { type: 'number', description: '二值化阈值 0~255，默认 128' },
        invert: { type: 'boolean', description: 'true = 阴码（0 表示点亮，共阳点阵常用）' },
        scan: { type: 'string', enum: ['row', 'col'], description: 'row = 横向取模（一行一行），col = 纵向取模（一页一页，OLED 常用）' },
        bitOrder: { type: 'string', enum: ['msb', 'lsb'], description: '字节内位序，默认 msb（最左像素在 bit7）' },
        varName: { type: 'string', description: 'C 数组变量名，默认 glyph' },
        preview: { type: 'boolean', description: '是否生成预览 PNG，默认 true' },
      },
      execute: safe('mcu_glyph', async (args, exec) => {
        const result = await renderGlyph({
          text: args.text,
          image: args.image,
          size: args.size,
          font: args.font,
          threshold: args.threshold,
          invert: args.invert,
          scan: args.scan,
          bitOrder: args.bitOrder,
          varName: args.varName,
          preview: args.preview,
          dataDir: config.dataDir,
          signal: exec?.signal,
        })
        if (!result.ok) return { ok: false, summary: summarizeGlyph(result), data: result }
        const log = createLog(config.dataDir, 'glyph')
        log.write(result.cArray)
        return { ok: true, summary: summarizeGlyph(result), data: result, logPath: log.path }
      }),
    }),
  )

  // ------------------------------------------------------------------ tone
  specs.push(
    wrap({
      name: 'mcu_tone',
      description:
        '简谱 → 频率 / 半周期 / 时长表 + C 数组（替代「谱曲软件」），给蜂鸣器写《小星星》这类旋律。语法：1-7 音级，#/b 升降，^ 升八度（可叠）、, 降八度；- 每多一拍，_ 时值减半，. 附点，| 小节线，0 休止，1:2.5 直接指定拍数。输出 100µs 单位的两字一组数组，配 Timer0 非阻塞蜂鸣器直接用。',
      parameters: {
        score: { type: 'string', required: true, description: '简谱字符串，例如 "1 1 5 5 6 6 5- | 4 4 3 3 2 2 1-"' },
        key: { type: 'string', description: '调号，默认 C（可 G / F / Bb / F#）' },
        bpm: { type: 'number', description: '速度，默认 120（一拍 500ms）' },
        fosc: { type: 'number', description: '主频 Hz，仅用于注释，默认 12000000' },
      },
      execute: safe('mcu_tone', async (args) => {
        const result = parseScore({ score: args.score, key: args.key ?? 'C', bpm: Number(args.bpm ?? 120), fosc: Number(args.fosc ?? 12_000_000) })
        return { ok: result.ok, summary: summarizeTone(result), data: result }
      }),
    }),
  )

  // --------------------------------------------------------------- project
  specs.push(
    wrap({
      name: 'mcu_project',
      description:
        '工程登记簿：把「名字 → 目录 / uvproj / 芯片 / 主频 / 串口」记住，之后 mcu_build / mcu_flash 直接写名字。add 时会自动找 .uvproj，并从源码的 #include 与 FOSC 宏猜出芯片和主频。',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'add', 'remove'], description: 'list 列出；add 登记；remove 删除' },
        name: { type: 'string', description: '登记名（add / remove 用），默认取目录名' },
        dir: { type: 'string', description: '工程目录或 .uvproj（add 用）' },
        port: { type: 'string', description: '这块板用的串口' },
        mcu: { type: 'string', description: '覆盖自动探测的型号' },
        fosc: { type: 'number', description: '覆盖自动探测的主频' },
        baud: { type: 'number', description: '固件的串口波特率（9600 / 2400）' },
      },
      execute: safe('mcu_project', async (args) => {
        if (args.action === 'list') {
          const items = listProjects(config.dataDir)
          return {
            ok: true,
            summary: items.length
              ? `已登记 ${items.length} 个工程：\n` +
                items
                  .map((p) => `- ${p.name}: ${p.dir}${p.mcu ? ` [${p.mcu}]` : ''}${p.fosc ? ` @${(p.fosc / 1e6).toFixed(3)}MHz` : ''}${p.hex ? '\n    hex: ' + p.hex.path : ''}`)
                  .join('\n')
              : '登记簿是空的：mcu_project add 一个工程目录试试',
            data: { projects: items, dataDir: config.dataDir },
          }
        }
        if (args.action === 'add') {
          if (!args.dir) return { ok: false, summary: '❌ add 需要 dir' }
          const result = registerProject(config.dataDir, { name: args.name, dir: args.dir, port: args.port, mcu: args.mcu, fosc: args.fosc, baud: args.baud })
          if (!result.ok) return { ok: false, summary: `❌ ${result.error}`, data: result }
          const p = result.project
          return {
            ok: true,
            summary: `✅ 已登记「${p.name}」\n- 目录：${p.dir}\n- uvproj：${p.uvproj}\n- 芯片：${p.mcu ?? '未知'}${p.board ? `（${p.board}）` : ''}\n- 主频：${p.fosc ?? '未知'}${p.port ? `\n- 串口：${p.port}` : ''}${p.hex ? `\n- 最新 hex：${p.hex}` : ''}`,
            data: result,
          }
        }
        if (args.action === 'remove') {
          if (!args.name) return { ok: false, summary: '❌ remove 需要 name' }
          const result = removeProject(config.dataDir, args.name)
          return { ok: result.ok, summary: result.ok ? `✅ 已删除登记「${args.name}」` : `❌ ${result.error}`, data: result }
        }
        return { ok: false, summary: `❌ 不认识 action=${args.action}` }
      }),
    }),
  )

  return specs
}

// ------------------------------------------------------------------ helpers

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function summarizeCalc(result) {
  if (!result?.ok) return `❌ ${(result?.errors ?? ['算不出来']).join('；')}`
  const lines = []
  const pick = (label, value) => value !== undefined && value !== null && lines.push(`- ${label}：${value}`)
  if (result.th1) pick('TH1 / TL1', `${result.th1} / ${result.tl1}（SMOD=${result.smod}）`)
  if (result.actualBaud) pick('实际波特率', `${result.actualBaud}（误差 ${result.errorPct}%）`)
  if (result.t2l) pick('T2L / T2H', `${result.t2l} / ${result.t2h}`)
  if (result.th && !result.th1) pick('TH / TL', `${result.th} / ${result.tl}（方式 ${result.mode}）`)
  if (result.actualMs !== undefined) pick('实际时间', `${result.actualMs} ms`)
  if (result.loops) pick('循环次数', `${result.loops}${result.fitsInUchar ? '（unsigned char）' : '（unsigned int）'}`)
  if (result.value !== undefined && result.volt !== undefined) pick('数值 / 电压', `${result.value} / ${result.volt} V`)
  if (result.cm !== undefined && result.ticks !== undefined) pick('计数 / 距离', `${result.ticks} → ${result.cm} cm`)
  if (result.note) lines.push(`- 注意：${result.note}`)
  if (result.formula) lines.push(`- 公式：${result.formula}`)
  if (result.code) {
    lines.push('```c')
    lines.push(result.code)
    lines.push('```')
  }
  return lines.join('\n')
}

function summarizeBaudTable(result) {
  const lines = [`${(result.fosc / 1e6).toFixed(4)}MHz，${result.mode}，SMOD=${result.smod}：`, '', '波特率     TH1      实际      误差']
  for (const row of result.rows) {
    lines.push(
      `${String(row.baud).padEnd(9)} ${String(row.th1 ?? '—').padEnd(8)} ${String(row.actualBaud ?? '—').padEnd(9)} ${row.errorPct === null ? '—' : row.errorPct + '%'}${row.ok ? '' : '  ← 不可用'}`,
    )
  }
  lines.push('')
  lines.push('经验：11.0592MHz 是“为串口而生”的晶振（9600 零误差）；12MHz 的 2400 可用，9600 误差 8.5% 会乱码。')
  return lines.join('\n')
}

/** 由 dist/index.js 调用：绑定宿主配置后注册全部工具。 */
export function registerTools(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const specs = buildToolSpecs({ defineTool: ctx.defineTool, config })
  const disposers = specs.map((spec) => ctx.tools.register(spec))
  const dispose = () => disposers.forEach((dispose) => dispose?.())
  dispose.toolNames = specs.map(spec => spec.name)
  return dispose
}
