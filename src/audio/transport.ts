// ─── Transport ──────────────────────────────────────────────────────
// The musical clock. Time is integer context frames from one origin (SPEC
// rule 9): every boundary and beat is computed in closed form from
// (origin, loopFrames) and never accumulated, so the click and the loop can't
// drift apart however many cycles the loop runs.
//
// A 25 ms timer schedules clicks up to 100 ms ahead at exact frame times
// (the "two clocks" pattern). The timer only decides WHEN something gets
// scheduled; the grid alone decides where a beat falls.
//
// Origin = the first downbeat AFTER the count-in, so loop boundary 0 is where
// a base take begins. The count-in bar(s) sit just before it.

import type { Graph } from './graph'

// ─── Grid math (pure) ───

export function framesPerBeat(sampleRate: number, bpm: number): number {
  return sampleRate * 60 / bpm
}

/** Integer loop length. Rounded once; everything else is derived from it. */
export function loopFrames(sampleRate: number, bpm: number, beatsPerBar: number, bars: number): number {
  return Math.round(framesPerBeat(sampleRate, bpm) * beatsPerBar * bars)
}

/** Loop boundary k. Integer in, integer out: no float ever crosses a loop. */
export function boundaryFrame(origin: number, loopLength: number, k: number): number {
  return origin + k * loopLength
}

/**
 * Beat i (0-based, counted across the whole loop) of loop k. The in-loop offset
 * depends only on i, so beat i lands at the same distance from every boundary:
 * the click and a looping buffer of loopLength frames stay locked forever.
 */
export function beatFrame(origin: number, loopLength: number, beatsPerLoop: number, k: number, i: number): number {
  return origin + k * loopLength + Math.round(i * loopLength / beatsPerLoop)
}

export function countInFrames(sampleRate: number, bpm: number, beatsPerBar: number, countInBars: number): number {
  return Math.round(framesPerBeat(sampleRate, bpm) * beatsPerBar * countInBars)
}

/** Index of the first boundary at or after `frame` (never negative). */
export function nextBoundaryIndex(origin: number, loopLength: number, frame: number): number {
  let k = Math.max(0, Math.ceil((frame - origin) / loopLength))
  // The division is float; pin the answer with integer comparisons.
  while (boundaryFrame(origin, loopLength, k) < frame) k++
  while (k > 0 && boundaryFrame(origin, loopLength, k - 1) >= frame) k--
  return k
}

const f64 = new Float64Array(1)
const i64 = new BigInt64Array(f64.buffer)

function prevDouble(x: number): number {
  f64[0] = x
  i64[0] -= 1n
  return f64[0]
}

/**
 * Seconds for a start() call that lands ON `frame`. frame / sampleRate times
 * sampleRate comes back a hair above the integer for about 7% of frames
 * (352,391 of 5,000,000 at 44.1 kHz). The spec starts a source at the first
 * frame at or after `when`, so a browser that follows it literally would start
 * one frame late. Chromium 153 snaps to the frame either way (measured: 200 of
 * 200 such starts bit-exact with this and with the plain division); stepping
 * down keeps the plain division's exact cases and makes the rest safe.
 */
export function frameTime(frame: number, sampleRate: number): number {
  let t = frame / sampleRate
  while (t > 0 && t * sampleRate > frame) t = prevDouble(t)
  return t
}

// ─── Limits ───

export const BPM_MIN = 30
export const BPM_MAX = 300
export const BARS_MAX = 16
export const BEATS_PER_BAR_MAX = 12

const validBpm = (v: number): boolean => Number.isFinite(v) && v >= BPM_MIN && v <= BPM_MAX
const validCount = (v: number, max: number, min = 1): boolean => Number.isInteger(v) && v >= min && v <= max

// ─── Transport ───

export interface TransportOptions {
  bpm: number
  beatsPerBar: number
  bars: number
  countInBars?: number
}

export interface TransportParams {
  sampleRate: number
  bpm: number
  beatsPerBar: number
  bars: number
  countInBars: number
  loopFrames: number
}

export interface Beat {
  /** Context frame the click sounds at (before output latency). */
  frame: number
  /** Beat within its bar; 0 is the downbeat. */
  beat: number
  /** Bar within the loop, or within the count-in. */
  bar: number
  countIn: boolean
}

export interface Transport {
  /** Start (count-in first). Returns the origin: the first downbeat after the count-in. */
  start(): number
  stop(): void
  running(): boolean
  /** Current origin frame, or null when stopped. */
  origin(): number | null
  /** The requested params; a tempo change while running takes effect at the next bar line. */
  params(): TransportParams
  /** False when locked or out of range. */
  setBpm(bpm: number): boolean
  setBars(bars: number): boolean
  /** The looper locks bpm and bars while a loop exists. */
  lock(on: boolean): void
  locked(): boolean
  /** Count-in clicks always sound; this switches the click after it. */
  setClick(on: boolean): void
  clickOn(): boolean
  setClickLevel(v: number): void
  /** ctx.currentTime as an integer frame. */
  framesNow(): number
  /** Fires on the main thread once each beat's frame has been rendered. */
  onBeat(cb: (beat: Beat) => void): () => void
  dispose(): void
}

const TICK_MS = 25
const LOOKAHEAD_S = 0.1
// The first click is at least this far ahead of now, so it is never late.
// Not more than LOOKAHEAD_S, or start() could not schedule it at once.
const START_LEAD_S = 0.1
// A beat closer than this to "now" is skipped, not played late (after a stall).
const MIN_LEAD_S = 0.005
const RAMP = 0.015

interface Voice { freq: number; type: OscillatorType; peak: number }

// Click voice adapted from ModalRuns (same author): sine 1200/800 Hz blips,
// 0.3/0.15 peak, 60 ms exponential decay. The count-in gets a triangle voice
// at different pitches so the player can hear where the take begins.
function voiceFor(b: Beat): Voice {
  if (b.countIn) return { type: 'triangle', freq: b.beat === 0 ? 1600 : 1000, peak: b.beat === 0 ? 0.35 : 0.2 }
  return { type: 'sine', freq: b.beat === 0 ? 1200 : 800, peak: b.beat === 0 ? 0.3 : 0.15 }
}

export function createTransport(graph: Graph, options: TransportOptions): Transport {
  const { ctx } = graph
  const sampleRate = ctx.sampleRate
  const countInBars = options.countInBars ?? 1
  if (!validBpm(options.bpm)) throw new RangeError(`bpm must be ${BPM_MIN}-${BPM_MAX}`)
  if (!validCount(options.beatsPerBar, BEATS_PER_BAR_MAX)) throw new RangeError(`beatsPerBar must be 1-${BEATS_PER_BAR_MAX}`)
  if (!validCount(options.bars, BARS_MAX)) throw new RangeError(`bars must be 1-${BARS_MAX}`)
  if (!validCount(countInBars, 4, 0)) throw new RangeError('countInBars must be 0-4')

  // `wanted` is what the UI asked for; `active` is what the scheduler is
  // playing. They differ only between a tempo change and the next bar line.
  let wanted = { bpm: options.bpm, beatsPerBar: options.beatsPerBar, bars: options.bars }
  let active = { ...wanted }
  let isLocked = false
  let originFrame: number | null = null
  let nextBeat = 0 // global beat index from origin; negative during the count-in
  let timer: ReturnType<typeof setInterval> | null = null
  let clickEnabled = true
  let clickLevel = 1
  const queue: Beat[] = []
  const listeners = new Set<(b: Beat) => void>()
  const live = new Set<OscillatorNode>()

  const clickOut = ctx.createGain()
  const countInOut = ctx.createGain()
  clickOut.connect(graph.clickBus)
  countInOut.connect(graph.clickBus)

  const framesNow = (): number => Math.round(ctx.currentTime * sampleRate)
  const loopLen = (): number => loopFrames(sampleRate, active.bpm, active.beatsPerBar, active.bars)
  const countInLen = (): number => countInFrames(sampleRate, active.bpm, active.beatsPerBar, countInBars)

  function beatAt(n: number): Beat {
    const origin = originFrame as number
    const { beatsPerBar } = active
    if (n < 0) {
      const beats = beatsPerBar * countInBars
      const j = n + beats
      const len = countInLen()
      return {
        frame: origin - len + Math.round(j * len / beats),
        beat: j % beatsPerBar, bar: Math.floor(j / beatsPerBar), countIn: true,
      }
    }
    const perLoop = beatsPerBar * active.bars
    const k = Math.floor(n / perLoop)
    const i = n - k * perLoop
    return {
      frame: beatFrame(origin, loopLen(), perLoop, k, i),
      beat: i % beatsPerBar, bar: Math.floor(i / beatsPerBar), countIn: false,
    }
  }

  function blip(b: Beat): void {
    const v = voiceFor(b)
    const t = frameTime(b.frame, sampleRate)
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = v.type
    osc.frequency.value = v.freq
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(v.peak, t + 0.002)
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
    osc.connect(env).connect(b.countIn ? countInOut : clickOut)
    osc.onended = () => {
      live.delete(osc)
      osc.disconnect()
      env.disconnect()
    }
    live.add(osc)
    osc.start(t)
    osc.stop(t + 0.07)
  }

  function tick(): void {
    if (originFrame === null) return
    const now = framesNow()
    // Inclusive, so start()'s own tick schedules the first click with its full lead.
    const horizon = now + Math.ceil(LOOKAHEAD_S * sampleRate)
    const minLead = now + Math.round(MIN_LEAD_S * sampleRate)
    for (;;) {
      // A tempo change re-anchors the grid at the first bar line not yet scheduled.
      if (nextBeat >= 0 && nextBeat % active.beatsPerBar === 0 && changed()) {
        originFrame = beatAt(nextBeat).frame
        active = { ...wanted }
        nextBeat = 0
      }
      const b = beatAt(nextBeat)
      if (b.frame > horizon) break
      if (b.frame >= minLead && (b.countIn || clickEnabled)) blip(b)
      queue.push(b)
      nextBeat++
    }
    while (queue.length > 0 && queue[0].frame <= now) {
      const b = queue.shift() as Beat
      for (const cb of listeners) cb(b)
    }
  }

  const changed = (): boolean =>
    wanted.bpm !== active.bpm || wanted.beatsPerBar !== active.beatsPerBar || wanted.bars !== active.bars

  function setGain(param: AudioParam, value: number): void {
    const now = ctx.currentTime
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(value, now + RAMP)
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    originFrame = null
    queue.length = 0
    // Clicks already scheduled ahead must not sound after a stop.
    for (const osc of live) {
      try { osc.stop() } catch { /* already stopped */ }
    }
  }

  return {
    start() {
      if (originFrame !== null) return originFrame
      active = { ...wanted }
      const first = framesNow() + Math.ceil(START_LEAD_S * sampleRate)
      originFrame = first + countInLen()
      nextBeat = -active.beatsPerBar * countInBars
      tick()
      timer = setInterval(tick, TICK_MS)
      return originFrame
    },
    stop,
    running: () => originFrame !== null,
    origin: () => originFrame,
    params: () => ({
      sampleRate, ...wanted, countInBars,
      loopFrames: loopFrames(sampleRate, wanted.bpm, wanted.beatsPerBar, wanted.bars),
    }),
    setBpm(bpm) {
      if (isLocked || !validBpm(bpm)) return false
      wanted = { ...wanted, bpm }
      return true
    },
    setBars(bars) {
      if (isLocked || !validCount(bars, BARS_MAX)) return false
      wanted = { ...wanted, bars }
      return true
    },
    lock(on) { isLocked = on },
    locked: () => isLocked,
    setClick(on) {
      clickEnabled = on
      setGain(clickOut.gain, on ? clickLevel : 0)
    },
    clickOn: () => clickEnabled,
    setClickLevel(v) {
      clickLevel = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
      if (clickEnabled) setGain(clickOut.gain, clickLevel)
      setGain(countInOut.gain, clickLevel)
    },
    framesNow,
    onBeat(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    dispose() {
      stop()
      listeners.clear()
      clickOut.disconnect()
      countInOut.disconnect()
    },
  }
}
