// Resolve only the runtime shipped with this plugin. Never fall back to the
// developer's Python, registry, PATH or user site-packages.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from './config.js'
import { run } from './util/exec.js'

export function bundledRuntime(root = PACKAGE_ROOT, platform = process.platform, arch = process.arch) {
  const dir = join(root, 'runtime', `${platform}-${arch}`)
  const path = join(dir, platform === 'win32' ? 'python.exe' : 'python')
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(path) || !existsSync(manifestPath)) {
    return { ok: false, error: 'BUNDLED_RUNTIME_MISSING', path, message: `插件内置运行时缺失或平台不支持（${platform}-${arch}），请安装完整的 Windows x64 发布包。` }
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.platform !== `${platform}-${arch}`) throw new Error('运行时平台与清单不符')
    return { ok: true, path, dir, manifest, bundled: true }
  } catch (error) {
    return { ok: false, error: 'BUNDLED_RUNTIME_INVALID', path, message: error.message }
  }
}

export async function probeRuntime(root = PACKAGE_ROOT) {
  const runtime = bundledRuntime(root)
  if (!runtime.ok) return runtime
  const probe = await run(runtime.path, ['-I', '-B', join(root, 'sidecar', 'runtime_probe.py')], { timeoutMs: 15_000 })
  try {
    if (probe.code !== 0) throw new Error(probe.out || probe.error)
    const info = JSON.parse(probe.stdout.trim())
    if (!info.isolated) throw new Error('运行时没有隔离系统 Python 环境')
    return { ...runtime, ...info, serialAccess: assessSerialRuntime(info.integrity) }
  } catch (error) {
    return { ok: false, error: 'BUNDLED_RUNTIME_INVALID', path: runtime.path, message: String(error.message) }
  }
}

// This is a policy preflight, not proof of port/driver/lock-directory access.
// A runnable interpreter can still be unable to write the normal user's locks.
export function assessSerialRuntime(integrity) {
  const scope = 'process-integrity-only; no-port-or-lock-access'
  if (integrity?.ok === true && integrity.supported === false &&
      typeof integrity.platform === 'string' && integrity.platform.length > 0 && integrity.platform !== 'win32') {
    return { ok: true, scope, applicable: false }
  }
  if (integrity?.ok !== true || integrity.supported !== true || integrity.platform !== 'win32' ||
      !Number.isInteger(integrity.rid) || integrity.rid < 0 || integrity.rid > 0xffffffff) {
    return { ok: false, scope, error: 'RUNTIME_INTEGRITY_UNKNOWN',
      message: '无法核对内置 Python 进程完整性级别：' + (integrity?.message ?? '缺少有效的令牌查询结果') }
  }
  if (integrity.rid < 8192) return { ok: false, scope, error: 'RUNTIME_LOW_INTEGRITY',
    message: `内置 Python 进程完整性级别低于 Medium（RID ${integrity.rid}），可能无法写入标准用户串口锁目录。请将完整插件正常解压安装到普通用户应用目录后重新体检；无需管理员权限。` }
  return { ok: true, scope, applicable: true }
}

export async function runSidecar(script, spec, options = {}) {
  const runtime = bundledRuntime()
  if (!runtime.ok) return { ...runtime, code: null, stdout: '', stderr: '', out: runtime.message }
  return run(runtime.path, ['-I', '-B', join(PACKAGE_ROOT, 'sidecar', script)], {
    ...options,
    input: JSON.stringify(spec),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' },
  })
}
