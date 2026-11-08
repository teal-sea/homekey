import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeWav } from '../export/wav'
import type { Graph } from './graph'
import {
  LOOPER_IDLE, buildTakeFiles, clampLatencyMs, createLooper, defaultLatencyMs, looperReducer, mixLayers,
  type Looper, type LooperEvent, type LooperMode, type LooperState,
} from './looper'
import type { Transport, TransportParams } from './transport'

// ─── Reducer ───

const S = (mode: LooperMode, hasBase = false, hasOverdub = false, error: string | null = null): LooperState =>
  ({ mode, hasBase, hasOverdub, error })

const EVENTS: LooperEvent[] = [
  { type: 'record' }, { type: 'take-started' }, { type: 'take-done' }, { type: 'overdub' },
  { type: 'stop' }, { type: 'play' }, { type: 'undo' }, { type: 'clear' },
]

describe('looperReducer', () => {
  it('walks the happy path: base, overdub, undo, stop, play, clear', () => {
    let s = LOOPER_IDLE
    const step = (e: LooperEvent, expected: LooperState): void => {
      s = looperReducer(s, e)
      expect(s).toEqual(expected)
    }
    step({ type: 'record' }, S('count-in'))
    step({ type: 'take-started' }, S('recording-base'))
    step({ type: 'take-done' }, S('playing', true))
    step({ type: 'overdub' }, S('overdub-armed', true))
    step({ type: 'take-started' }, S('recording-overdub', true))
    step({ type: 'take-done' }, S('playing', true, true))
    step({ type: 'undo' }, S('playing', true, false))
    step({ type: 'stop' }, S('idle', true))
    step({ type: 'play' }, S('playing', true))
    step({ type: 'clear' }, LOOPER_IDLE)
  })

  // For every state, which events change it (to what mode); all others must return the same object.
  const table: [LooperState, Partial<Record<LooperEvent['type'], LooperState>>][] = [
    [S('idle'), { record: S('count-in') }],
    [S('idle', true), { play: S('playing', true), stop: undefined, clear: LOOPER_IDLE }],
    [S('idle', true, true), { play: S('playing', true, true), undo: S('idle', true), clear: LOOPER_IDLE }],
    [S('count-in'), { 'take-started': S('recording-base'), stop: LOOPER_IDLE, clear: LOOPER_IDLE }],
    [S('recording-base'), { 'take-done': S('playing', true), stop: LOOPER_IDLE, clear: LOOPER_IDLE }],
    [S('playing', true), { overdub: S('overdub-armed', true), stop: S('idle', true), clear: LOOPER_IDLE }],
    [S('playing', true, true), { undo: S('playing', true), stop: S('idle', true, true), clear: LOOPER_IDLE }],
    [S('overdub-armed', true), {
      'take-started': S('recording-overdub', true), undo: S('playing', true), stop: S('idle', true), clear: LOOPER_IDLE,
    }],
    [S('recording-overdub', true), {
      'take-done': S('playing', true, true), undo: S('playing', true), stop: S('idle', true), clear: LOOPER_IDLE,
    }],
    [S('error', true, false, 'x'), { play: S('playing', true), stop: S('idle', true), clear: LOOPER_IDLE }],
    [S('error', false, false, 'x'), { stop: LOOPER_IDLE, clear: LOOPER_IDLE }],
  ]

  for (const [state, valid] of table) {
    it(`${state.mode}${state.hasBase ? '+base' : ''}${state.hasOverdub ? '+overdub' : ''}: only the valid events apply`, () => {
      for (const e of EVENTS) {
        const next = looperReducer(state, e)
        const expected = valid[e.type]
        if (expected === undefined) {
          if (next !== state) throw new Error(`${e.type} should be ignored in ${state.mode}`)
        } else {
          expect(next, e.type).toEqual(expected)
          expect(next).not.toBe(state)
        }
      }
    })
  }

  it('fail moves any state to error and keeps what was recorded', () => {
    const msg = { type: 'fail', message: 'dropped out' } as const
    expect(looperReducer(S('recording-overdub', true), msg)).toEqual(S('error', true, false, 'dropped out'))
    expect(looperReducer(S('count-in'), msg)).toEqual(S('error', false, false, 'dropped out'))
  })

  it('never mutates its input', () => {
    const s = Object.freeze(S('playing', true))
    for (const e of EVENTS) looperReducer(s, e)
    expect(s).toEqual(S('playing', true))
  })
})

// ─── Export ───

describe('take files', () => {
  const info = { bpm: 97, beatsPerBar: 4, bars: 1, sampleRate: 48000, loopFrames: 6, latencyMs: 21, overdubLatencyMs: null }
  const meta = { toneMode: 'amp' as const, modelName: 'Test Amp', channelLayout: 'input 1, mono on L and R' }
  const base = [Float32Array.from([0, 0.25, 0.5, 0.75, -0.5, 0]), Float32Array.from([0, 0, 0, 0, 0, 0.5])]
  const over = [Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), Float32Array.from([0, 0, 0, 0, 0, 0.75])]

  it('mixes by straight sum without touching the layers', () => {
    const mix = mixLayers(base, over)
    expect(Array.from(mix[0])).toEqual([0.5, 0.75, 1, 1.25, 0, 0.5])
    expect(Array.from(mix[1])).toEqual([0, 0, 0, 0, 0, 1.25])
    expect(base[0][3]).toBe(0.75)
    expect(Array.from(mixLayers(base, null)[0])).toEqual(Array.from(base[0]))
  })

  it('writes base, overdub, mix and take.json, all WAVs the same length', async () => {
    const files = buildTakeFiles(base, over, info, meta)
    expect(files.map((f) => f.name)).toEqual(['base.wav', 'overdub.wav', 'mix.wav', 'take.json'])
    for (const f of files.slice(0, 3)) {
      const wav = decodeWav(await f.blob.arrayBuffer())
      expect(wav.sampleRate).toBe(48000)
      expect(wav.channels.map((c) => c.length)).toEqual([6, 6])
    }
    const take = JSON.parse(await files[3].blob.text())
    expect(take).toMatchObject({
      bpm: 97, beatsPerBar: 4, bars: 1, sampleRate: 48000, loopFrames: 6, latencyMs: 21,
      bitDepth: 24, channels: 2, channelLayout: 'input 1, mono on L and R', toneMode: 'amp', modelName: 'Test Amp',
      files: ['base.wav', 'overdub.wav', 'mix.wav'],
    })
    expect(take).not.toHaveProperty('overdubLatencyMs')
    // The mix clips at full scale in the file.
    const mix = decodeWav(await files[2].blob.arrayBuffer())
    expect(mix.channels[0][3]).toBe((2 ** 23 - 1) / 2 ** 23)
  })

  it('without an overdub: base, mix (= base) and take.json; notes a changed overdub offset', async () => {
    const files = buildTakeFiles(base, null, info, meta)
    expect(files.map((f) => f.name)).toEqual(['base.wav', 'mix.wav', 'take.json'])
    const both = buildTakeFiles(base, over, { ...info, overdubLatencyMs: 40 }, meta)
    expect(JSON.parse(await both[3].blob.text()).overdubLatencyMs).toBe(40)
  })
})

describe('latency', () => {
  it('defaults to output + base latency + 10 ms, clamped to 0-300', () => {
    expect(defaultLatencyMs({ outputLatency: 0.0123, baseLatency: 0.0058 })).toBe(28)
    expect(defaultLatencyMs({})).toBe(10)
    expect(defaultLatencyMs({ outputLatency: Number.NaN, baseLatency: 0.005 })).toBe(15)
    expect(defaultLatencyMs({ outputLatency: 1 })).toBe(300)
    expect(clampLatencyMs(-5)).toBe(0)
    expect(clampLatencyMs(12.6)).toBe(13)
    expect(clampLatencyMs(Number.NaN)).toBe(0)
  })
})

// ─── Looper against a fake context ───
// Checks WHAT gets armed and scheduled at WHICH frame. Real audio is verified
// in Chromium (see the report); this pins the arithmetic.

const SR = 48000
const LF = 4800 * 4 // keeps chunk math readable: 4.69 chunks per loop
const LAT_MS = 25 // round((0.0100 + 0.0050) * 1000) + 10
const LAT = Math.round(LAT_MS * SR / 1000)

interface FakeSource {
  buffer: { length: number; data: Float32Array[] } | null
  loop: boolean
  startAt: number | null
  stopAt: number | null
  onended: (() => void) | null
  connect(n: unknown): unknown
  disconnect(): void
  start(t: number): void
  stop(t?: number): void
}

function setup() {
  const posted: Record<string, unknown>[] = []
  const sources: FakeSource[] = []
  let port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: Record<string, unknown>): void } | null = null
  const param = () => ({
    value: 1,
    cancelScheduledValues() { return this },
    setValueAtTime() { return this },
    linearRampToValueAtTime() { return this },
  })
  const node = () => ({ connect: (n: unknown) => n, disconnect() {} })
  const ctx = {
    sampleRate: SR, currentTime: 0, outputLatency: 0.01, baseLatency: 0.005,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: () => ({ ...node(), gain: param() }),
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return {
        length, data,
        copyToChannel(src: Float32Array, ch: number, at = 0) { data[ch].set(src, at) },
        getChannelData: (ch: number) => data[ch],
      }
    },
    createBufferSource: () => {
      const s: FakeSource = {
        ...node(), buffer: null, loop: false, startAt: null, stopAt: null, onended: null,
        start(t) { this.startAt = t },
        stop(t) { this.stopAt = t ?? 0 },
      }
      sources.push(s)
      return s
    },
  }
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = class {
    port = { onmessage: null, postMessage: (m: Record<string, unknown>) => { posted.push(m) } }
    onprocessorerror = null
    constructor() { port = this.port }
    connect(n: unknown) { return n }
    disconnect() {}
  }
  const graph = { ctx, guitarBus: node(), loopBus: node() } as unknown as Graph

  let now = 0
  let origin: number | null = null
  let locked = false
  const transport = {
    start: vi.fn(() => { origin = now + 4800 + LF; return origin }), // 100 ms lead + a one-bar count-in
    stop: vi.fn(() => { origin = null }),
    running: () => origin !== null,
    origin: () => origin,
    params: (): TransportParams => ({ sampleRate: SR, bpm: 60, beatsPerBar: 4, bars: 1, countInBars: 1, loopFrames: LF }),
    lock: (on: boolean) => { locked = on },
    locked: () => locked,
    framesNow: () => now,
  } as unknown as Transport

  const at = (frame: number): void => {
    now = frame
    ctx.currentTime = frame / SR
    vi.advanceTimersByTime(20)
  }
  const reply = (data: Record<string, unknown>): void => port?.onmessage?.({ data })
  const frameOf = (s: FakeSource): number => Math.ceil((s.startAt as number) * SR - 1e-6)
  // Deliver a whole take as the worklet would, in 4096-frame chunks, value = take frame + 1.
  const deliver = (id: number, fill = (t: number) => t + 1): void => {
    for (let off = 0; off < LF; off += 4096) {
      const n = Math.min(4096, LF - off)
      const ch = Float32Array.from({ length: n }, (_, i) => fill(off + i))
      reply({ type: 'chunk', id, offset: off, channels: [ch, ch.slice()] })
    }
  }
  return { ctx, graph, transport, posted, sources, at, reply, deliver, frameOf, origin: () => origin }
}

describe('createLooper (fake context)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  async function recordBase(env: ReturnType<typeof setup>, looper: Looper) {
    looper.record()
    const origin = env.origin() as number
    const arm = env.posted.at(-1) as { id: number; startFrame: number; frames: number }
    env.at(origin) // the downbeat after the count-in
    env.at(origin + 4096 + LAT) // first chunk captured
    env.deliver(arm.id)
    env.at(origin + LF + LAT + 10)
    env.reply({ type: 'done', id: arm.id, startFrame: arm.startFrame, frames: LF, discontinuous: false })
    return { origin, arm }
  }

  it('records a base: count-in, frame-exact window, first pass on the next downbeat, then one looping source', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    expect(env.ctx.audioWorklet.addModule).toHaveBeenCalledWith('/worklets/recorder.js')
    expect(looper.latencyMs()).toBe(LAT_MS)
    const seen: string[] = []
    looper.subscribe((s) => seen.push(s.state))

    looper.record()
    const origin = env.origin() as number
    expect(env.transport.locked()).toBe(true)
    expect(env.posted).toEqual([{ type: 'arm', id: 1, startFrame: origin + LAT, frames: LF }])
    expect(looper.snapshot()).toMatchObject({ state: 'count-in', locked: true, loopFrames: LF, position: 0 })
    expect(looper.isBusy()).toBe(true)

    env.at(origin - 100)
    expect(looper.snapshot().state).toBe('count-in')
    env.at(origin)
    expect(looper.snapshot().state).toBe('recording-base')

    env.deliver(1)
    // Each chunk is scheduled one loop after the boundary it was played against.
    const firstPass = env.sources.filter((s) => !s.loop)
    expect(firstPass.map((s) => env.frameOf(s))).toEqual([0, 4096, 8192, 12288, 16384].map((o) => origin + LF + o))
    expect(firstPass.map((s) => s.buffer?.length)).toEqual([4096, 4096, 4096, 4096, LF - 16384])

    env.at(origin + LF + LAT + 10)
    env.reply({ type: 'done', id: 1, startFrame: origin + LAT, frames: LF, discontinuous: false })
    const main = env.sources.filter((s) => s.loop)
    expect(main.length).toBe(1)
    expect(env.frameOf(main[0])).toBe(origin + 2 * LF)
    expect(main[0].buffer?.length).toBe(LF)
    expect(main[0].buffer?.data[0][LF - 1]).toBe(LF)
    expect(looper.snapshot()).toMatchObject({ state: 'playing', hasBase: true, locked: true })
    expect(looper.isBusy()).toBe(false)
    expect(seen).toEqual(['count-in', 'recording-base', 'playing'])

    env.at(origin + 2 * LF + LF / 4)
    expect(looper.snapshot().position).toBeCloseTo(0.25, 6)
  })

  it('arms the overdub for the next cycle, re-arms after a late arm, and plays it in step with the base', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    const { origin } = await recordBase(env, looper)

    looper.overdub()
    expect(env.posted.at(-1)).toEqual({ type: 'arm', id: 2, startFrame: origin + 2 * LF + LAT, frames: LF })
    expect(looper.snapshot().state).toBe('overdub-armed')
    // The main thread's clock can lag the worklet's: re-arm from the frame the worklet reported.
    env.reply({ type: 'late', id: 2, currentFrame: origin + 2 * LF + LAT + 128 })
    expect(env.posted.at(-1)).toEqual({ type: 'arm', id: 3, startFrame: origin + 3 * LF + LAT, frames: LF })
    expect(looper.snapshot().state).toBe('overdub-armed')

    env.at(origin + 3 * LF)
    expect(looper.snapshot().state).toBe('recording-overdub')
    const before = env.sources.length
    env.deliver(3, (t) => -(t + 1))
    const overFirst = env.sources.slice(before)
    expect(env.frameOf(overFirst[0])).toBe(origin + 4 * LF)
    env.at(origin + 4 * LF + LAT + 5)
    env.reply({ type: 'done', id: 3, startFrame: origin + 3 * LF + LAT, frames: LF, discontinuous: false })
    const overMain = env.sources.at(-1) as FakeSource
    expect(overMain.loop).toBe(true)
    expect(env.frameOf(overMain)).toBe(origin + 5 * LF) // a boundary, so it lines up with the base
    expect(looper.snapshot()).toMatchObject({ state: 'playing', hasBase: true, hasOverdub: true })

    const files = await looper.exportFiles({ toneMode: 'bypass', modelName: null, channelLayout: 'stereo' })
    expect(files.map((f) => f.name)).toEqual(['base.wav', 'overdub.wav', 'mix.wav', 'take.json'])
    const lengths = await Promise.all(files.slice(0, 3).map(async (f) => decodeWav(await f.blob.arrayBuffer()).channels[0].length))
    expect(lengths).toEqual([LF, LF, LF])

    looper.undo()
    expect(overMain.stopAt).not.toBeNull()
    expect(overFirst.every((s) => s.stopAt !== null)).toBe(true)
    expect(looper.snapshot()).toMatchObject({ state: 'playing', hasOverdub: false })
  })

  it('a chunk that arrives too late for the grid leaves a hole instead of playing off-grid', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    looper.record()
    const origin = env.origin() as number
    env.at(origin + LF + 4096) // the main thread stalled past the first-pass slot of chunk 0
    env.deliver(1)
    const firstPass = env.sources.filter((s) => !s.loop).map((s) => env.frameOf(s) - origin - LF)
    expect(firstPass).toEqual([8192, 12288, 16384])
  })

  it('discards a discontinuous base take and unlocks', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    looper.record()
    const origin = env.origin() as number
    env.deliver(1)
    env.reply({ type: 'done', id: 1, startFrame: origin + LAT, frames: LF, discontinuous: true })
    expect(looper.snapshot()).toMatchObject({ state: 'error', hasBase: false, locked: false })
    expect(looper.snapshot().error).toMatch(/dropped out/)
    expect(env.transport.running()).toBe(false)
    expect(env.sources.every((s) => s.stopAt !== null)).toBe(true)
    expect(env.posted.at(-1)).toEqual({ type: 'cancel', id: 1 })
  })

  it('stop during the count-in cancels the take and unlocks; stop with a loop keeps it locked; play restarts', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    looper.record()
    looper.stop()
    expect(env.posted.at(-1)).toEqual({ type: 'cancel', id: 1 })
    expect(looper.snapshot()).toMatchObject({ state: 'idle', locked: false })

    await recordBase(env, looper)
    looper.stop()
    expect(looper.snapshot()).toMatchObject({ state: 'idle', hasBase: true, locked: true })
    expect(env.sources.every((s) => s.stopAt !== null)).toBe(true)

    const before = env.sources.length
    looper.play()
    const origin = env.origin() as number
    const restarted = env.sources.slice(before)
    expect(restarted.length).toBe(1)
    expect(restarted[0].loop).toBe(true)
    expect(env.frameOf(restarted[0])).toBe(origin)

    looper.clear()
    expect(looper.snapshot()).toMatchObject({ state: 'idle', hasBase: false, locked: false })
    expect(env.transport.running()).toBe(false)
    await expect(looper.exportFiles({ toneMode: 'amp', modelName: null, channelLayout: '' })).rejects.toThrow()
  })

  it('stops itself when the transport is stopped underneath it', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    await recordBase(env, looper)
    env.transport.stop()
    env.at(100_000_000)
    expect(looper.snapshot().state).toBe('idle')
    expect(env.sources.every((s) => s.stopAt !== null)).toBe(true)
  })

  it('clamps latency and uses the new offset for the next take', async () => {
    const env = setup()
    const looper = await createLooper(env.graph, env.transport)
    looper.setLatencyMs(999)
    expect(looper.latencyMs()).toBe(300)
    looper.setLatencyMs(0)
    looper.record()
    expect(env.posted.at(-1)).toMatchObject({ startFrame: env.origin() })
  })
})
