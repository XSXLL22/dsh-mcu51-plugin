// 进程与编码工具：spawn、GBK 解码与取消/超时。
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'

const MAX_BUFFER = 2 * 1024 * 1024

const EB = process.platform === 'win32'

/**
 * 解码子进程输出：优先 UTF-8，失败回退 GBK（Keil / STC-ISP 的中文日志都是 GBK）。
 * @param {Buffer} buf
 */
export function decode(buf) {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

/** 把 stdout/stderr 分片收集器收成一个 Buffer。 */
function collector() {
  const chunks = []
  let size = 0
  return {
    push(chunk) {
      if (size >= MAX_BUFFER) return
      const room = MAX_BUFFER - size
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
      size += Math.min(chunk.length, room)
    },
    buffer() {
      return Buffer.concat(chunks)
    },
  }
}

/**
 * 执行一个进程并收集输出。
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, input?: string}} [options]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, out: string, timedOut: boolean, error: string|null, durationMs: number, command: string}>}
 */
export function run(file, args = [], options = {}, spawnProcess = spawn) {
  if (options.signal?.aborted) return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', out: '', timedOut: false, aborted: true, processClosed: false, error: 'ABORTED', durationMs: 0, command: [file, ...args].join(' ') })
  const timeoutMs = options.timeoutMs ?? 60_000
  const command = [file, ...args].join(' ')
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const outBuf = collector()
    const errBuf = collector()
    let settled = false
    let timedOut = false
    let aborted = false
    let processError = null
    const processErrors = []
    const recordError = (message) => { processErrors.push(message); processError ??= message }
    let timer = null

    let child
    try {
      child = spawnProcess(file, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        out: '',
        timedOut: false,
        aborted: false,
        processClosed: false,
        error: `${error.code ?? 'SPAWN_FAILED'}: ${error.message}`,
        durationMs: Date.now() - startedAt,
        command,
      })
      return
    }

    const finish = (code, signal, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener?.('abort', onAbort)
      const stdout = decode(outBuf.buffer())
      const stderr = decode(errBuf.buffer())
      resolve({
        code,
        signal,
        stdout,
        stderr,
        out: [stdout, stderr].filter(Boolean).join('\n'),
        timedOut,
        aborted,
        processClosed: true,
        error: error ?? null,
        errors: processErrors,
        durationMs: Date.now() - startedAt,
        command,
      })
    }

    const onAbort = () => {
      aborted = true
      try {
        child.kill('SIGKILL')
      } catch (error) {
        recordError(`KILL_FAILED: ${error.message}`)
      }
    }

    child.stdout?.on('data', (chunk) => {
      outBuf.push(chunk)
      try { options.onStdout?.(chunk) }
      catch (error) {
        recordError(`OUTPUT_CALLBACK_FAILED: ${error.message}`)
        try { child.kill('SIGKILL') } catch (killError) { recordError(`KILL_FAILED: ${killError.message}`) }
      }
    })
    child.stderr?.on('data', (chunk) => errBuf.push(chunk))
    child.stdin?.on?.('error', (error) => { recordError(`STDIN_${error.code ?? 'ERROR'}: ${error.message}`) })
    child.on('error', (error) => { recordError(`${error.code ?? 'ERROR'}: ${error.message}`) })
    child.on('close', (code, signal) => finish(code, signal, processError))

    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch (error) {
        recordError(`KILL_FAILED: ${error.message}`)
      }
    }, timeoutMs)
    timer.unref?.()

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    if (options.input) {
      try {
        child.stdin?.end(options.input)
      } catch (error) {
        recordError(`STDIN_END_FAILED: ${error.message}`)
      }
    } else {
      try {
        child.stdin?.end()
      } catch (error) {
        recordError(`STDIN_END_FAILED: ${error.message}`)
      }
    }
  })
}

/** 在 PATH 里找一个可执行文件，返回绝对路径或 null。 */
export async function which(name) {
  const result = await run(EB ? 'where.exe' : 'which', [name], { timeoutMs: 6000 })
  if (result.code !== 0) return null
  const first = result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return first ?? null
}

/** 文件存在且是文件。 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
