// 计算器：51 波特率 / 定时器 / 软件延时 / DAC / 超声波换算。
// 所有公式都在返回值里给出，方便对着数据手册核对。

const STANDARD_BAUDS = [1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200]

function hex(value, width = 2) {
  return '0x' + Number(value).toString(16).toUpperCase().padStart(width, '0')
}

function roundTo(value, digits = 2) {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** 时钟分频：12T 定时器每个机器周期 = 12 个时钟。 */
function timerClockDiv(mode) {
  if (mode === '1t') return 1
  if (mode === '12t') return 12
  return null
}

/**
 * 波特率：Timer1 方式 2（8 位自动重装），12T / 1T 两种时钟。
 * 12T: baud = FOSC / (12 * 32 * (256 - TH1))，SMOD=1 时 16 倍分频
 * 1T : baud = FOSC / (32 * (256 - TH1))       （STC15 把 T1 设成 1T 时）
 */
export function calcBaud({ fosc, baud, mode = 'timer1-12t', smod = 0 }) {
  const errors = []
  if (!(fosc > 0)) errors.push('fosc 必须是正数（Hz），例如 12000000')
  if (!(baud > 0)) errors.push('baud 必须是正数，例如 9600')
  if (mode === 'timer2-1t') return calcBaudTimer2({ fosc, baud, errors })
  const divider = mode === 'timer1-1t' ? 32 / (smod ? 2 : 1) : (12 * 32) / (smod ? 2 : 1)
  if (errors.length) return { ok: false, errors }
  const exact = fosc / divider / baud
  const reload = Math.round(256 - exact)
  if (reload < 1 || reload > 255) {
    return {
      ok: false,
      errors: [`该主频下 ${baud} 的装载值 ${reload} 超出 1..255：换 SMOD、换 1T/12T，或改用 Timer2 做波特率发生器`],
      exact,
      divider,
    }
  }
  const actual = fosc / divider / (256 - reload)
  const errPct = ((actual - baud) / baud) * 100
  const code = [
    'TMOD &= 0x0F;  TMOD |= 0x20;      /* T1 方式 2，8 位自动重装 */',
    mode === 'timer1-12t' ? 'AUXR &= 0xBF;                  /* STC15: T1 用 12T */' : 'AUXR |= 0x40;                  /* STC15: T1 用 1T */',
    `TH1 = ${hex(reload)};  TL1 = ${hex(reload)};`,
    smod ? 'PCON |= 0x80;                    /* SMOD = 1 */' : 'PCON &= 0x7F;                   /* SMOD = 0 */',
    'TR1 = 1;',
  ].join('\n')
  return {
    ok: Math.abs(errPct) <= 2,
    mode,
    fosc,
    baud,
    smod,
    exact,
    ticks: 256 - reload,
    th1: hex(reload),
    tl1: hex(reload),
    actualBaud: Math.round(actual),
    errorPct: roundTo(errPct, 3),
    formula: mode === 'timer1-12t'
      ? `baud = FOSC / (12 × ${smod ? 16 : 32} × (256 − TH1))；TH1 = 256 − FOSC / (12 × ${smod ? 16 : 32} × baud)`
      : `baud = FOSC / (${smod ? 16 : 32} × (256 − TH1))；TH1 = 256 − FOSC / (${smod ? 16 : 32} × baud)`,
    code,
    note: Math.abs(errPct) > 2
      ? `误差 ${roundTo(errPct, 2)}% 偏大：11.0592MHz 下 9600 是 0 误差，晶体主频（12MHz）做不到整数分频`
      : `误差 ${roundTo(errPct, 2)}%，可用`,
  }
}

/** STC15 用 Timer2 做波特率发生器（1T）：baud = FOSC / (4 × (65536 − RL)) */
function calcBaudTimer2({ fosc, baud, errors }) {
  if (errors.length) return { ok: false, errors }
  const exact = fosc / 4 / baud
  const reload = Math.round(65536 - exact)
  if (reload < 0 || reload > 65535) {
    return { ok: false, errors: [`Timer2 装载值 ${reload} 超出 0..65535`], exact }
  }
  const actual = fosc / 4 / (65536 - reload)
  const errPct = ((actual - baud) / baud) * 100
  const code = [
    'AUXR |= 0x04;                  /* T2 用 1T 时钟 */',
    `T2L = ${hex(reload & 0xff)};  T2H = ${hex(reload >> 8)};`,
    'AUXR |= 0x01;                  /* T2 作为波特率发生器 */',
  ].join('\n')
  return {
    ok: Math.abs(errPct) <= 2,
    mode: 'timer2-1t',
    fosc,
    baud,
    exact,
    reload: 65536 - reload,
    t2l: hex(reload & 0xff),
    t2h: hex(reload >> 8),
    actualBaud: Math.round(actual),
    errorPct: roundTo(errPct, 3),
    formula: 'baud = FOSC / (4 × (65536 − RL))；RL = 65536 − FOSC / (4 × baud)',
    code,
    note: 'STC15 推荐用 Timer2 做波特率，1T 下误差最小',
  }
}

/**
 * 定时器初值。
 * mode 1 = 16 位；mode 2 = 8 位自动重装；auto = 能塞进 16 位就用 16 位。
 */
export function calcTimer({ fosc, ms = 0, us = 0, mode = 1, clock = '12t', prescaler = 1, round = 'floor' }) {
  const seconds = (Number(ms) || 0) / 1000 + (Number(us) || 0) / 1e6
  if (!(fosc > 0) || !(seconds > 0)) return { ok: false, errors: ['需要 fosc 与 ms/us 都大于 0'] }
  const div = timerClockDiv(clock) / (prescaler > 0 ? prescaler : 1)
  if (div === null) return { ok: false, errors: ['clock 只能是 12t 或 1t'] }
  const ticksRaw = (fosc / div) * seconds
  const rounding = round === 'floor' ? Math.floor : round === 'ceil' ? Math.ceil : Math.round
  const ticks = rounding(ticksRaw)

  if (mode === 'auto') mode = ticks <= 65536 ? 1 : 2
  if (mode === 1) {
    if (ticks > 65536) {
      const repeats = Math.ceil(ticks / 65536)
      return {
        ok: false,
        errors: [`${seconds * 1000}ms 需要 ${Math.round(ticksRaw)} 个计数，16 位定时器一次装不下（上限 65536）：把 prescaler 调到 ≥${repeats}，或让中断累加 ${repeats} 次`],
        ticks: Math.round(ticksRaw),
        repeats,
      }
    }
    const reload = 65536 - ticks
    const actual = (ticks * div) / fosc
    return {
      ok: true,
      mode: 1,
      clock,
      prescaler,
      ticks,
      reload: hex(reload, 4),
      th: hex(reload >> 8),
      tl: hex(reload & 0xff),
      actualMs: roundTo(actual * 1000, 4),
      errorPct: roundTo(((ticks - ticksRaw) / ticksRaw) * 100, 4),
      formula: `重装值 = 65536 − (FOSC / ${div} × 时间)；本机 ${fosc}Hz / ${div} = ${Math.round(fosc / div)}Hz`,
      code: [
        'TMOD &= 0xF0;  TMOD |= 0x01;   /* T0 方式 1（16 位） */',
        clock === '12t' ? 'AUXR &= 0x7F;                 /* T0 用 12T */' : 'AUXR |= 0x80;                  /* T0 用 1T */',
        `TL0 = ${hex(reload & 0xff)};  TH0 = ${hex(reload >> 8)};`,
        'TF0 = 0;  TR0 = 1;  ET0 = 1;  EA = 1;',
      ].join('\n'),
    }
  }
  if (mode === 2) {
    if (ticks > 256) {
      return { ok: false, errors: [`方式 2 只有 8 位（上限 256 个计数），本次需要 ${Math.round(ticksRaw)}`], ticks: Math.round(ticksRaw) }
    }
    const reload = 256 - ticks
    const actual = (ticks * div) / fosc
    return {
      ok: true,
      mode: 2,
      clock,
      prescaler,
      ticks,
      reload: hex(reload),
      th: hex(reload),
      tl: hex(reload),
      actualMs: roundTo(actual * 1000, 4),
      errorPct: roundTo(((ticks - ticksRaw) / ticksRaw) * 100, 4),
      formula: '重装值 = 256 − 计数（方式 2 自动重装，适合 50µs~1ms 级节拍）',
      code: ['TMOD &= 0xF0;  TMOD |= 0x02;', `TH0 = ${hex(reload)};  TL0 = ${hex(reload)};`, 'TR0 = 1;  ET0 = 1;  EA = 1;'].join('\n'),
    }
  }
  return { ok: false, errors: ['mode 只能是 1 / 2 / auto'] }
}

/**
 * 软件延时循环次数。C51 里一个空循环大约 2 个机器周期（while(--i)），for 约 8 个。
 */
export function calcDelay({ fosc, ms = 1, clock = '12t', cyclesPerLoop = 2 }) {
  if (!(fosc > 0) || !(ms > 0) || !(cyclesPerLoop > 0)) return { ok: false, errors: ['需要 fosc、ms、cyclesPerLoop 都大于 0'] }
  const div = timerClockDiv(clock)
  const machineCycleSec = (div / fosc)
  const loopsRaw = (ms / 1000) / (machineCycleSec * cyclesPerLoop)
  const loops = Math.max(1, Math.round(loopsRaw))
  const actualMs = loops * machineCycleSec * cyclesPerLoop * 1000
  const is8bit = loops <= 255
  return {
    ok: true,
    clock,
    cyclesPerLoop,
    loops,
    fitsInUchar: is8bit,
    actualMs: roundTo(actualMs, 4),
    errorPct: roundTo(((actualMs - ms) / ms) * 100, 3),
    formula: `循环次数 = 毫秒 / (机器周期 × 每循环周期数)；机器周期 = ${div}/${fosc}s = ${roundTo(machineCycleSec * 1e6, 3)}µs`,
    code: is8bit
      ? [
          `void Delay${Math.round(ms)}ms(void)          /* 约 ${roundTo(actualMs, 2)}ms @${fosc}Hz */`,
          '{',
          '\tunsigned char i;',
          `\ti = ${loops};`,
          '\twhile (--i);',
          '}',
        ].join('\n')
      : [
          `void Delay${Math.round(ms)}ms(void)          /* 约 ${roundTo(actualMs, 2)}ms @${fosc}Hz */`,
          '{',
          '\tunsigned int i;',
          `\ti = ${loops};`,
          '\twhile (--i);',
          '}',
        ].join('\n'),
    note: '循环次数随优化等级变化（Keil 的 0~8 级），要精确就改用定时器；这条只用来估算 ±10% 的场景',
  }
}

/** 主流主频下的波特率速查表。 */
export function baudTable({ fosc, mode = 'timer1-12t', smod = 0, bauds = STANDARD_BAUDS }) {
  const rows = bauds.map((baud) => {
    const r = calcBaud({ fosc, baud, mode, smod })
    return {
      baud,
      ok: Boolean(r.ok),
      th1: r.th1 ?? null,
      smod,
      actualBaud: r.actualBaud ?? null,
      errorPct: r.errorPct ?? null,
      note: r.ok ? null : r.errors?.[0] ?? '不可用',
    }
  })
  return {
    ok: true,
    fosc,
    mode,
    smod,
    rows,
    formula: rows.length ? '见 calcBaud：baud = FOSC / (12 × (SMOD?16:32) × (256 − TH1))' : '',
  }
}

/** PCF8591 DAC：数值 ↔ 电压；以及 12 届国赛的距离映射。 */
export function calcDac({ volt, value, distanceCm }) {
  const out = { ok: true }
  if (value !== undefined && value !== null) {
    const v = Number(value)
    out.value = v
    out.volt = roundTo((v / 255) * 5, 4)
  }
  if (volt !== undefined && volt !== null) {
    const v = Number(volt)
    out.volt = v
    out.value = Math.max(0, Math.min(255, Math.round((v / 5) * 255)))
  }
  if (distanceCm !== undefined && distanceCm !== null) {
    const d = Math.max(10, Math.min(80, Number(distanceCm)))
    out.distanceCm = d
    out.value = Math.round(((d - 10) * 204) / 70 + 51)
    out.volt = roundTo((out.value / 255) * 5, 4)
  }
  out.formula = 'value = V / 5.0 × 255；12 届国赛距离映射 value = (d − 10) × 204 / 70 + 51（10cm→1.0V，80cm→5.0V）'
  return out
}

/** 超声波：PCA 计数值 ↔ 厘米。 */
export function calcUltrasonic({ fosc, ticks, cm }) {
  if (!(fosc > 0)) return { ok: false, errors: ['需要 fosc'] }
  const k = 204000 / fosc
  const out = { ok: true, fosc, k: roundTo(k, 6), formula: 'cm = ticks × 204000 / FOSC（声速 340m/s，往返除以 2，12T 定时器）' }
  if (ticks !== undefined && ticks !== null) {
    out.ticks = Number(ticks)
    out.cm = roundTo(Number(ticks) * k, 2)
  }
  if (cm !== undefined && cm !== null) {
    out.cm = Number(cm)
    out.ticks = Math.round(Number(cm) / k)
  }
  return out
}

export { STANDARD_BAUDS }
