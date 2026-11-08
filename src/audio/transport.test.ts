import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Graph } from './graph'
import {
  beatFrame, boundaryFrame, countInFrames, createTransport, frameTime, loopFrames, nextBoundaryIndex, type Beat,
} from './transport'

// ─── Grid math ───

describe('loopFrames', () => {
  it('rounds the loop length once, to an integer', () => {
    // 44100 * 60 / 97 = 27278.35... frames per beat
    expect(loopFrames(44100, 97, 4, 1)).toBe(109113)
    expect(loopFrames(48000, 97, 4, 1)).toBe(118763)
    expect(loopFrames(44100, 120, 4, 2)).toBe(176400)
    expect(Number.isInteger(loopFrames(44100, 97, 3, 7))).toBe(true)
  })
})

describe('countInFrames', () => {
  it('is one bar at the loop tempo by default shape', () => {
    expect(countInFrames(44100, 97, 4, 1)).toBe(109113)
    expect(countInFrames(48000, 97, 3, 2)).toBe(Math.round(48000 * 60 / 97 * 6))
    expect(countInFrames(44100, 120, 4, 0)).toBe(0)
  })
})

// Exact reference for Math.round(i * lf / bpl) with integers only (i, lf, bpl >= 0).
const exactOffset = (i: number, lf: number, bpl: number): number =>
  Number((2n * BigInt(i) * BigInt(lf) + BigInt(bpl)) / (2n * BigInt(bpl)))

describe('grid over 10,000 loops', () => {
  for (const sampleRate of [44100, 48000]) {
    for (const [bpm, beatsPerBar, bars] of [[97, 4, 1], [97, 4, 8], [133.7, 7, 3], [61, 5, 16]]) {
      it(`has zero drift at ${sampleRate} Hz, ${bpm} bpm, ${beatsPerBar}/x, ${bars} bars`, () => {
        const lf = loopFrames(sampleRate, bpm, beatsPerBar, bars)
        const perLoop = beatsPerBar * bars
        const origin = 123_456_789
        const offsets = Array.from({ length: perLoop }, (_, i) => beatFrame(origin, lf, perLoop, 0, i) - origin)
        for (let k = 0; k <= 10_000; k++) {
          const b = boundaryFrame(origin, lf, k)
          expect(Number.isInteger(b)).toBe(true)
          if (k > 0) expect(b - boundaryFrame(origin, lf, k - 1)).toBe(lf)
          let prev = -Infinity
          for (let i = 0; i < perLoop; i++) {
            const f = beatFrame(origin, lf, perLoop, k, i)
            // Same distance from every boundary: click and a looping buffer of lf frames can't drift.
            if (f - b !== offsets[i] || f <= prev) throw new Error(`loop ${k} beat ${i}: ${f}`)
            prev = f
          }
          if (prev >= boundaryFrame(origin, lf, k + 1)) throw new Error(`loop ${k} overruns`)
        }
        // Offsets are the exactly rounded rational positions, and within a frame of even spacing.
        for (let i = 0; i < perLoop; i++) {
          expect(offsets[i]).toBe(exactOffset(i, lf, perLoop))
          expect(Math.abs(offsets[i] - i * lf / perLoop)).toBeLessThanOrEqual(0.5)
        }
        // Loop 10,000 starts exactly 10,000 integer loops after the origin.
        expect(boundaryFrame(origin, lf, 10_000)).toBe(origin + 10_000 * lf)
      })
    }
  }
})

describe('nextBoundaryIndex', () => {
  it('finds the first boundary at or after a frame', () => {
    const lf = loopFrames(44100, 97, 4, 1)
    const origin = 5000
    expect(nextBoundaryIndex(origin, lf, 0)).toBe(0)
    expect(nextBoundaryIndex(origin, lf, origin)).toBe(0)
    expect(nextBoundaryIndex(origin, lf, origin + 1)).toBe(1)
    expect(nextBoundaryIndex(origin, lf, origin + lf)).toBe(1)
    expect(nextBoundaryIndex(origin, lf, origin + lf + 1)).toBe(2)
    for (let n = 0; n < 2000; n++) {
      const frame = origin + Math.floor(n * 7919.37 * 13)
      const k = nextBoundaryIndex(origin, lf, frame)
      expect(boundaryFrame(origin, lf, k)).toBeGreaterThanOrEqual(frame)
      if (k > 0) expect(boundaryFrame(origin, lf, k - 1)).toBeLessThan(frame)
    }
  })
})

describe('frameTime', () => {
  it('never lands above the frame, and stays within a hair of it', () => {
    for (const sr of [44100, 48000]) {
      let exact = 0
      for (let f = 0; f < 3_000_000; f += 7) {
        const t = frameTime(f, sr)
        const p = t * sr
        if (p > f || f - p > 1e-6) throw new Error(`frame ${f}: ${p}`)
        if (p === f) exact++
      }
      // Most frames round-trip exactly; the rest sit a few ulps below.
      expect(exact / (3_000_000 / 7)).toBeGreaterThan(0.8)
    }
  })
})

// ─── Scheduler (fake context) ───

interface FakeOsc {
  type: string
  frequency: { value: number }
  madeAt: number
  startAt: number
  stopAt: number | null
  stopCalls: number
  onended: (() => void) | null
  connect(n: unknown): unknown
  disconnect(): void
  start(t: number): void
  stop(t?: number): void
}

function fakeParam() {
  return {
    value: 1,
    setValueAtTime() { return this },
    linearRampToValueAtTime(v: number) { this.value = v; return this },
    exponentialRampToValueAtTime() { return this },
    cancelScheduledValues() { return this },
  }
}

function fakeGraph(sampleRate = 44100) {
  const oscs: FakeOsc[] = []
  const ctx = {
    sampleRate,
    currentTime: 0,
    createGain: () => ({ gain: fakeParam(), connect: (n: unknown) => n, disconnect() {} }),
    createOscillator: () => {
      const o: FakeOsc = {
        type: 'sine', frequency: { value: 0 }, madeAt: ctx.currentTime, startAt: -1, stopAt: null, stopCalls: 0, onended: null,
        connect: (n) => n, disconnect() {},
        start(t) { this.startAt = t },
        stop(t) { this.stopCalls++; this.stopAt = t ?? 0 },
      }
      oscs.push(o)
      return o
    },
  }
  const graph = { ctx, clickBus: { connect: (n: unknown) => n } } as unknown as Graph
  return { graph, ctx, oscs }
}

describe('createTransport', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // Advance the audio clock and the timers together, 5 ms at a time.
  const run = (ctx: { currentTime: number }, seconds: number): void => {
    for (let t = 0; t < seconds; t += 0.005) {
      ctx.currentTime += 0.005
      vi.advanceTimersByTime(5)
    }
  }
  const frameOf = (o: FakeOsc, sr: number): number => Math.ceil(o.startAt * sr - 1e-9)

  it('starts at least 100 ms ahead with the count-in before the origin', () => {
    const { graph, ctx } = fakeGraph()
    ctx.currentTime = 1
    const t = createTransport(graph, { bpm: 97, beatsPerBar: 4, bars: 2 })
    const origin = t.start()
    const first = 44100 + Math.ceil(0.1 * 44100)
    expect(origin).toBe(first + countInFrames(44100, 97, 4, 1))
    expect(t.running()).toBe(true)
    expect(t.origin()).toBe(origin)
    expect(t.start()).toBe(origin) // idempotent while running
  })

  it('schedules every click on the grid and accents downbeats', () => {
    const { graph, ctx, oscs } = fakeGraph()
    const t = createTransport(graph, { bpm: 97, beatsPerBar: 4, bars: 2 })
    const origin = t.start()
    run(ctx, 13)
    const lf = loopFrames(44100, 97, 4, 2)
    const cif = countInFrames(44100, 97, 4, 1)
    const expected: number[] = []
    for (let j = 0; j < 4; j++) expected.push(origin - cif + Math.round(j * cif / 4))
    for (let k = 0; k < 2; k++) for (let i = 0; i < 8; i++) expected.push(beatFrame(origin, lf, 8, k, i))
    const got = oscs.map((o) => frameOf(o, 44100))
    expect(got.slice(0, expected.length)).toEqual(expected)
    // Count-in voice differs; downbeats are higher than the other beats.
    expect(oscs.slice(0, 4).every((o) => o.type === 'triangle')).toBe(true)
    expect(oscs.slice(4, 12).every((o) => o.type === 'sine')).toBe(true)
    expect(oscs[4].frequency.value).toBeGreaterThan(oscs[5].frequency.value)
    expect(oscs[8].frequency.value).toBe(oscs[4].frequency.value) // bar 2 downbeat
    // Never late: every click starts ahead of the audio clock at the moment it was scheduled.
    expect(oscs.every((o) => o.startAt - o.madeAt >= 0.005)).toBe(true)
    expect(oscs[0].startAt - oscs[0].madeAt).toBeGreaterThanOrEqual(0.1 - 1e-9)
  })

  it('emits onBeat in order once each beat has been rendered', () => {
    const { graph, ctx } = fakeGraph()
    const t = createTransport(graph, { bpm: 120, beatsPerBar: 4, bars: 1 })
    const beats: Beat[] = []
    const off = t.onBeat((b) => beats.push(b))
    const origin = t.start()
    run(ctx, 1.2)
    expect(beats.length).toBeGreaterThan(0)
    expect(beats[0]).toMatchObject({ countIn: true, beat: 0, bar: 0 })
    expect(beats.every((b) => b.frame <= Math.round(ctx.currentTime * 44100))).toBe(true)
    run(ctx, 1)
    const firstLoopBeat = beats.find((b) => !b.countIn)
    expect(firstLoopBeat).toMatchObject({ frame: origin, beat: 0, bar: 0 })
    off()
    const n = beats.length
    run(ctx, 1)
    expect(beats.length).toBe(n)
  })

  it('rejects bpm and bars changes while locked or out of range', () => {
    const { graph } = fakeGraph()
    const t = createTransport(graph, { bpm: 97, beatsPerBar: 4, bars: 2 })
    t.lock(true)
    expect(t.locked()).toBe(true)
    expect(t.setBpm(100)).toBe(false)
    expect(t.setBars(4)).toBe(false)
    expect(t.params()).toMatchObject({ bpm: 97, bars: 2, loopFrames: loopFrames(44100, 97, 4, 2) })
    t.lock(false)
    expect(t.setBpm(100)).toBe(true)
    expect(t.setBars(4)).toBe(true)
    expect(t.setBpm(10)).toBe(false)
    expect(t.setBpm(Number.NaN)).toBe(false)
    expect(t.setBars(2.5)).toBe(false)
    expect(t.setBars(0)).toBe(false)
    expect(t.params()).toMatchObject({ bpm: 100, bars: 4, loopFrames: loopFrames(44100, 100, 4, 4) })
  })

  it('throws on invalid construction options', () => {
    const { graph } = fakeGraph()
    expect(() => createTransport(graph, { bpm: 0, beatsPerBar: 4, bars: 1 })).toThrow(RangeError)
    expect(() => createTransport(graph, { bpm: 97, beatsPerBar: 0, bars: 1 })).toThrow(RangeError)
    expect(() => createTransport(graph, { bpm: 97, beatsPerBar: 4, bars: 1.5 })).toThrow(RangeError)
  })

  it('applies a tempo change at the next bar line not yet scheduled', () => {
    const { graph, ctx, oscs } = fakeGraph()
    const t = createTransport(graph, { bpm: 120, beatsPerBar: 4, bars: 1, countInBars: 0 })
    const origin = t.start()
    run(ctx, 0.9) // into the first bar
    expect(t.setBpm(90)).toBe(true)
    run(ctx, 6)
    const frames = oscs.map((o) => frameOf(o, 44100))
    const oldLf = loopFrames(44100, 120, 4, 1)
    // The rest of bar 1 stays on the old grid; bar 2 starts the new one.
    for (let i = 0; i < 4; i++) expect(frames[i]).toBe(beatFrame(origin, oldLf, 4, 0, i))
    const newOrigin = origin + oldLf
    expect(t.origin()).toBe(newOrigin)
    const newLf = loopFrames(44100, 90, 4, 1)
    for (let i = 0; i < 4; i++) expect(frames[4 + i]).toBe(beatFrame(newOrigin, newLf, 4, 0, i))
  })

  it('keeps the count-in audible when the click is off, and silences the rest', () => {
    const { graph, ctx, oscs } = fakeGraph()
    const t = createTransport(graph, { bpm: 120, beatsPerBar: 4, bars: 1 })
    t.setClick(false)
    expect(t.clickOn()).toBe(false)
    t.start()
    run(ctx, 4)
    expect(oscs.length).toBe(4)
    expect(oscs.every((o) => o.type === 'triangle')).toBe(true)
  })

  it('stop() cancels clicks already scheduled ahead', () => {
    const { graph, ctx, oscs } = fakeGraph()
    const t = createTransport(graph, { bpm: 120, beatsPerBar: 4, bars: 1 })
    t.start()
    run(ctx, 0.05)
    expect(oscs.length).toBeGreaterThan(0)
    t.stop()
    expect(t.running()).toBe(false)
    expect(t.origin()).toBeNull()
    expect(oscs.every((o) => o.stopCalls === 2)).toBe(true) // its own stop(t) plus the cancel
    const n = oscs.length
    run(ctx, 2)
    expect(oscs.length).toBe(n)
  })
})
