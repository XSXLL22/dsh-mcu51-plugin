// 简谱 → 频率 / 半周期 / 时长（100µs 单位）+ C 数组。
// 语法：1-7 为音级，#/b 升降，^ 升八度（可叠），, 降八度（可叠）；
//      - 每多一拍（延长），_ 时值减半，. 附点，| 小节线，0 休止，
//      也可以写 1:2.5 直接指定拍数。

const SEMITONE = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 }
const KEY_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

const NOTE_RE = /^([#b]?)([0-7])(:?)([\^',]*)([-_.]*)(?::(\d+(?:\.\d+)?))?$/
const NOTE_RE_ALT = /^([#b]?)([0-7])([\^',]*)([-_.]*)(?::(\d+(?:\.\d+)?))?$/

/** 解析调号，返回根音相对 C4 的半音数。 */
export function parseKey(key = 'C') {
  const m = /^([A-Ga-g])([#b]?)$/.exec(String(key).trim())
  if (!m) return { ok: false, error: `调号看不懂：${key}（写 C / G / F# / Bb 这种）` }
  const base = KEY_SEMITONE[m[1].toUpperCase()]
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return { ok: true, offset: base + accidental, name: m[1].toUpperCase() + m[2] }
}

/** MIDI 音高 → 频率（A4=440）。 */
export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12)
}

/**
 * 解析简谱。
 * @param {{score: string, key?: string, bpm?: number, beatMs?: number, fosc?: number}} options
 */
export function parseScore({ score, key = 'C', bpm = 120, beatMs, fosc = 12_000_000 }) {
  const keyInfo = parseKey(key)
  if (!keyInfo.ok) return { ok: false, error: keyInfo.error }
  const beat = Number(beatMs ?? 60000 / (Number(bpm) || 120))
  if (!(beat > 0)) return { ok: false, error: 'bpm / beatMs 必须大于 0' }

  const raw = String(score ?? '')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/[|]+/g, ' ')
    .trim()
  if (!raw) return { ok: false, error: 'score 是空的' }

  const tokens = raw.split(/\s+/).filter(Boolean)
  const notes = []
  let position = 0
  for (const token of tokens) {
    position += 1
    const m = NOTE_RE.exec(token) ?? NOTE_RE_ALT.exec(token)
    if (!m) {
      return { ok: false, error: `第 ${position} 个记号看不懂：${token}（示例：1 2 3- #4 5_ 6. 0 7,）`, token, position }
    }
    const [, accidental, degreeText, , octaveMarks, durationMarks, explicitBeats] = m
    const degree = Number(degreeText)
    let beats = explicitBeats ? Number(explicitBeats) : 1

    // 延长线：每多一个 - 加一拍
    const dashes = (durationMarks.match(/-/g) ?? []).length
    beats += dashes
    // 下划线：每多一个 _ 时值减半
    const unders = (durationMarks.match(/_/g) ?? []).length
    beats *= 0.5 ** unders
    // 附点：每个 . 乘 1.5
    const dots = (durationMarks.match(/\./g) ?? []).length
    for (let i = 0; i < dots; i++) beats *= 1.5

    const octave = (octaveMarks.match(/[\^']/g) ?? []).length - (octaveMarks.match(/,/g) ?? []).length
    const isRest = degree === 0
    let midi = null
    let freq = null
    if (!isRest) {
      const accidentalOffset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0
      midi = 60 + keyInfo.offset + SEMITONE[degree] + accidentalOffset + 12 * octave
      freq = midiToFreq(midi)
    }
    const ms = beats * beat
    notes.push({
      token,
      degree,
      accidental: accidental || null,
      octave,
      rest: isRest,
      beats: Number(beats.toFixed(4)),
      ms: Math.round(ms),
      freq: freq === null ? null : Number(freq.toFixed(2)),
      halfUs: freq === null ? null : Math.round(500000 / freq),
      halfTicks: freq === null ? null : Math.max(1, Math.round(500000 / freq / 100)),
      durationTicks: Math.max(1, Math.round(ms * 10)),
      midi,
    })
  }

  const playable = notes.filter((n) => !n.rest)
  const totalMs = notes.reduce((sum, n) => sum + n.ms, 0)

  const pairs = []
  for (const note of notes) {
    pairs.push(note.rest ? 0 : note.halfTicks, note.durationTicks)
  }
  const cArray = [
    `/* 简谱：${raw.replace(/\s+/g, ' ')} */`,
    `/* 调 ${keyInfo.name}，${bpm ? bpm + ' BPM' : Math.round(beat) + 'ms/拍'}，共 ${notes.length} 个记号 / ${(totalMs / 1000).toFixed(1)} 秒，FOSC=${fosc} */`,
    `/* 每两个字一组：半周期(100µs 单位)、时长(100µs 单位)，0x0000 是结束标记 */`,
    'unsigned int code music[] = {',
  ]
  for (let i = 0; i < pairs.length; i += 8) {
    cArray.push('    ' + pairs.slice(i, i + 8).map((v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`).join(', ') + ',')
  }
  cArray.push('    0x0000, 0x0000', '};')

  return {
    ok: true,
    key: keyInfo.name,
    bpm: bpm ? Number(bpm) : null,
    beatMs: Number(beat.toFixed(2)),
    totalMs,
    totalSeconds: Number((totalMs / 1000).toFixed(2)),
    noteCount: notes.length,
    playableCount: playable.length,
    freqRange: playable.length
      ? { min: Math.min(...playable.map((n) => n.freq)), max: Math.max(...playable.map((n) => n.freq)) }
      : null,
    notes,
    cArray: cArray.join('\n'),
    halts: '(100µs 单位)：freq 越高 halfTicks 越小，>1kHz 时分辨率已经不够，建议改用定时器重装值',
  }
}

/** 简谱结果 → 可读摘要。 */
export function summarizeTone(result) {
  if (!result.ok) return `❌ 解析失败：${result.error}`
  const lines = []
  lines.push(`✅ 调 ${result.key}，${result.bpm ? result.bpm + ' BPM' : result.beatMs + 'ms/拍'}，${result.noteCount} 个记号 / ${result.totalSeconds} 秒`)
  if (result.freqRange) lines.push(`音域 ${result.freqRange.min.toFixed(1)} ~ ${result.freqRange.max.toFixed(1)} Hz`)
  lines.push('')
  lines.push('记号   音高     频率(Hz)   半周期  C 数组用')
  for (const note of result.notes.slice(0, 40)) {
    if (note.rest) {
      lines.push(`${note.token.padEnd(6)} 休止     -          -       ${note.durationTicks}`)
    } else {
      lines.push(`${note.token.padEnd(6)} ${String(note.midi).padEnd(6)} ${String(note.freq).padEnd(10)} ${String(note.halfUs + 'µs').padEnd(8)} ${note.halfTicks}, ${note.durationTicks}`)
    }
  }
  if (result.notes.length > 40) lines.push(`… 其余 ${result.notes.length - 40} 个记号略`)
  lines.push('')
  lines.push('```c')
  lines.push(result.cArray)
  lines.push('```')
  if (result.halts) lines.push(result.halts)
  return lines.join('\n')
}
