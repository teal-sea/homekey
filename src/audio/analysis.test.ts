import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommitter, createNoteFollower, type Committer, type HeardNote } from './analysis'
import type { Graph } from './graph'
import type { PitchResult } from './pitch'

const reading = (midi: number, cents = 0): PitchResult => ({
  midi, cents, freq: 440 * 2 ** ((midi - 69 + cents / 100) / 12), clarity: 0.95,
})

const hold = (c: Committer, r: PitchResult): void => {
  c.push(r)
  c.push(r)
}

// ─── Commit rule ───

describe('createCommitter', () => {
  it('does not commit on a single read', () => {
    const c = createCommitter()
    expect(c.push(reading(57))).toBe(false)
    expect(c.current()).toBeNull()
  })

  it('commits when the same note is read twice in a row', () => {
    const c = createCommitter()
    c.push(reading(57))
    expect(c.push(reading(57))).toBe(true)
    expect(c.current()?.midi).toBe(57)
  })

  it('never commits notes that alternate every read', () => {
    const c = createCommitter()
    for (let i = 0; i < 20; i++) expect(c.push(reading(i % 2 ? 57 : 60))).toBe(false)
    expect(c.current()).toBeNull()
  })

  it('an empty read between two readings breaks the pair', () => {
    const c = createCommitter()
    c.push(reading(57))
    c.push(null)
    expect(c.push(reading(57))).toBe(false)
    expect(c.current()).toBeNull()
    expect(c.push(reading(57))).toBe(true)
  })

  it('reports a change only when the note changes, but refreshes cents while held', () => {
    const c = createCommitter()
    c.push(reading(57, -10))
    expect(c.push(reading(57, -10))).toBe(true)
    expect(c.push(reading(57, 4))).toBe(false)
    expect(c.current()?.cents).toBe(4)
  })

  it('moves to a new note only after it is read twice', () => {
    const c = createCommitter()
    hold(c, reading(57))
    expect(c.push(reading(60))).toBe(false)
    expect(c.current()?.midi).toBe(57)
    expect(c.push(reading(60))).toBe(true)
    expect(c.current()?.midi).toBe(60)
  })

  it('holds through 9 empty reads and clears on the 10th', () => {
    const c = createCommitter()
    hold(c, reading(57))
    for (let i = 0; i < 9; i++) expect(c.push(null)).toBe(false)
    expect(c.current()?.midi).toBe(57)
    expect(c.push(null)).toBe(true)
    expect(c.current()).toBeNull()
    expect(c.push(null)).toBe(false) // already clear: no second change
  })

  it('a reading in the middle of the gap restarts the empty count', () => {
    const c = createCommitter()
    hold(c, reading(57))
    for (let i = 0; i < 9; i++) c.push(null)
    c.push(reading(62)) // unconfirmed, but it is a reading
    for (let i = 0; i < 9; i++) expect(c.push(null)).toBe(false)
    expect(c.current()?.midi).toBe(57)
    expect(c.push(null)).toBe(true)
  })

  it('returns a copy, not the caller\'s reading object', () => {
    const c = createCommitter()
    const r = reading(57)
    hold(c, r)
    expect(c.current()).not.toBe(r)
    expect(c.current()).toEqual({ midi: r.midi, cents: r.cents, freq: r.freq, clarity: r.clarity })
  })
})

// ─── Follower wiring (fake context, fake timers) ───

const SR = 44100

function sine(freq: number, n: number): Float32Array {
  const buf = new Float32Array(n)
  for (let i = 0; i < n; i++) buf[i] = 0.3 * Math.sin(2 * Math.PI * freq * (i / SR))
  return buf
}

function fakeRig() {
  let signal: Float32Array | null = null
  const analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    connect: vi.fn(),
    getFloatTimeDomainData(out: Float32Array) {
      if (signal) out.set(signal.subarray(0, out.length))
      else out.fill(0)
    },
  }
  const ctx = { state: 'running', sampleRate: SR, createAnalyser: () => analyser }
  const input = { connect: vi.fn(), disconnect: vi.fn() }
  return {
    graph: { ctx } as unknown as Graph,
    input: input as unknown as AudioNode,
    ctx, analyser, inputSpy: input,
    play: (freq: number | null) => { signal = freq === null ? null : sine(freq, 4096) },
  }
}

describe('createNoteFollower', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('taps the given input with a 4096-point, unsmoothed analyser that feeds nothing', () => {
    const rig = fakeRig()
    const f = createNoteFollower(rig.graph, rig.input)
    expect(rig.inputSpy.connect).toHaveBeenCalledWith(rig.analyser)
    expect(rig.analyser.fftSize).toBe(4096)
    expect(rig.analyser.smoothingTimeConstant).toBe(0)
    expect(rig.analyser.connect).not.toHaveBeenCalled()
    f.stop()
  })

  it('commits a held A3 after two 50 ms polls, then clears ~500 ms after it stops', () => {
    const rig = fakeRig()
    const f = createNoteFollower(rig.graph, rig.input)
    const heard: (HeardNote | null)[] = []
    f.onNote(n => heard.push(n))

    rig.play(220)
    vi.advanceTimersByTime(50)
    expect(heard).toEqual([])
    vi.advanceTimersByTime(50)
    expect(heard.map(n => n?.midi)).toEqual([57])
    vi.advanceTimersByTime(500)
    expect(heard).toHaveLength(1) // held note: no repeat emits

    rig.play(null)
    vi.advanceTimersByTime(450)
    expect(f.current()?.midi).toBe(57)
    vi.advanceTimersByTime(50)
    expect(heard.map(n => n?.midi ?? null)).toEqual([57, null])
    f.stop()
  })

  it('a higher gateRms keeps a quiet tone out', () => {
    const rig = fakeRig()
    const f = createNoteFollower(rig.graph, rig.input, { gateRms: 0.5 })
    rig.play(220)
    vi.advanceTimersByTime(500)
    expect(f.current()).toBeNull()
    f.stop()
  })

  it('hears nothing while the context is not running (stale analyser data)', () => {
    const rig = fakeRig()
    const f = createNoteFollower(rig.graph, rig.input)
    rig.play(220)
    rig.ctx.state = 'suspended'
    vi.advanceTimersByTime(500)
    expect(f.current()).toBeNull()
    f.stop()
  })

  it('stop() disconnects, stops polling and clears a lit note once', () => {
    const rig = fakeRig()
    const f = createNoteFollower(rig.graph, rig.input)
    const heard: (HeardNote | null)[] = []
    f.onNote(n => heard.push(n))
    rig.play(220)
    vi.advanceTimersByTime(100)
    f.stop()
    f.stop()
    expect(rig.inputSpy.disconnect).toHaveBeenCalledWith(rig.analyser)
    expect(heard.map(n => n?.midi ?? null)).toEqual([57, null])
    rig.play(330)
    vi.advanceTimersByTime(500)
    expect(heard).toHaveLength(2)
    expect(f.current()).toBeNull()
  })

  it('unsubscribe stops one listener only', () => {
    const rig = fakeRig()
    const f = createNoteFollower(rig.graph, rig.input)
    const a: unknown[] = []
    const b: unknown[] = []
    const offA = f.onNote(n => a.push(n))
    f.onNote(n => b.push(n))
    offA()
    rig.play(220)
    vi.advanceTimersByTime(100)
    expect(a).toHaveLength(0)
    expect(b).toHaveLength(1)
    f.stop()
  })

  it('rejects a non-positive interval', () => {
    const rig = fakeRig()
    expect(() => createNoteFollower(rig.graph, rig.input, { intervalMs: 0 })).toThrow(RangeError)
  })
})
