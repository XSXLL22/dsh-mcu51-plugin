// The core toolbox is self-contained; Keil is an optional build adapter.
import { loadBoards } from './config.js'
import { detectKeil, listSerialPorts } from './discover.js'
import { probeRuntime } from './runtime.js'
import { listProjects } from './projects.js'

export async function doctor(options) {
  const [runtime, keil] = await Promise.all([probeRuntime(), detectKeil(options.config)])
  const serial = options.serial === false ? { ok: true, source: 'skipped', items: [] } : await listSerialPorts()
  const issues = []
  if (!runtime.ok) issues.push(runtime.message)
  else if (!runtime.serialAccess.ok) issues.push(runtime.serialAccess.message)
  if (!serial.ok) issues.push(serial.error)
  const serialReady = runtime.ok && runtime.serialAccess.ok
  return {
    ok: issues.length === 0, runtime, keil, serial, issues,
    boards: loadBoards(options.dataDir).boards.map(({ id, name, mcu, fosc, flashKB }) => ({ id, name, mcu, fosc, flashKB })),
    projects: listProjects(options.dataDir),
    capabilities: {
      serial: serialReady, glyph: runtime.ok, calc: true, tone: true,
      isp: { available: serialReady, engine: 'bundled-stcgal', hardwareValidation: 'CT107D IAP15F2K61S2/BSL7.2.5S gs12完整烧录已实测；其它型号待验收', families: ['STC89/90', 'STC15'] },
      build: { available: keil.ok, optional: true, provider: 'Keil C51' },
    },
    notes: [
      '串口、取模、ISP 使用插件内置运行时；不扫描或调用系统 Python、STC-ISP、普中软件。',
      'ISP 使用普通用户串口访问权限，不请求管理员权限。',
      '运行时完整性体检只查询自身进程，不打开串口、不获取串口锁，也不改变安全标签或 ACL。',
      '硬件仍需 USB 串口驱动；MCU 是否能自动进入下载模式取决于板级电路。',
      keil.ok ? '已找到可选的 Keil 编译器。' : '未找到可选的 Keil 编译器；仍可烧录已有 HEX 并使用其它工具。',
      serial.source === 'skipped' ? '本次未枚举串口。' : serial.items.length ? '串口已枚举。' : '未检测到串口；插入板子并检查驱动后重试。',
    ],
  }
}

export function summarizeDoctor(result) {
  return [
    result.ok ? '插件内置环境检查通过' : '插件环境检查失败',
    '运行时：' + (result.runtime.ok ? '内置 Python ' + result.runtime.version + '（隔离系统环境）' : result.runtime.message),
    ...(result.runtime.integrity ? ['进程完整性：' + (result.runtime.integrity.ok ?
      `${result.runtime.integrity.level ?? '不适用'}（RID ${result.runtime.integrity.rid ?? 'N/A'}）` : result.runtime.integrity.message)] : []),
    'ISP：内置开放协议；当前硬件验证状态 ' + result.capabilities.isp.hardwareValidation,
    '串口：' + (result.serial.items.map((p) => p.port + ' ' + (p.description ?? '')).join('；') || '无'),
    'Keil（可选）：' + (result.keil.path ?? '未安装'),
    ...result.issues,
    ...result.notes,
  ].join('\n')
}
