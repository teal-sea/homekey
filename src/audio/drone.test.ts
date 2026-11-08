import { describe, expect, it } from 'vitest'
import { createDrone, droneNotes, equalPowerFade, midiToFreq } from './drone'
import type { Graph } from './graph'

// ─── Pure helpers ───

describe('droneNotes', () => {
  it('puts the pedal in octave 2 with the fifth above it', () => {
    expect(droneNotes(9)).toEqual({ root: 45, fifth: 52 }) // A2, E3
    expect(droneNotes(0)).toEqual({ root: 36, fifth: 43 }) // C2, G2
    expect(droneNotes(11)).toEqual({ root: 47, fifth: 54 }) // B2, F#3
  })

  it('wraps any integer to a pitch class', () => {
    expect(droneNotes(-3)).toEqual(droneNotes(9))
    expect(droneNotes(21)).toEqual(droneNotes(9))
  })
})

describe('midiToFreq', () => {
  it('is A440 equal temperament', () => {
    expect(midiToFreq(69)).toBe(440)
    expect(midiToFreq(45)).toBeCloseTo(110, 10)
    expect(midiToFreq(36)).toBeCloseTo(65.406, 3)
  })
})

describe('equalPowerFade', () => {
  it('runs from one value to the other', () => {
    const up = equalPowerFade(0, 0.85)
    expect(up[0]).toBe(0)
    expect(up[up.length - 1]).toBeCloseTo(0.85, 6)
    const down = equalPowerFade(0.6, 0)
    expect(down[0]).toBeCloseTo(0.6, 6)
    expect(down[down.length - 1]).toBeCloseTo(0, 6)
  })

  it('is monotonic', () => {
    const up = equalPowerFade(0.2, 0.85, 32)
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1])
    const down = equalPowerFade(0.85, 0, 32)
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThanOrEqual(down[i - 1])
  })

  it('keeps total power constant across a crossfade of equal peaks', () => {
    const out = equalPowerFade(0.85, 0)
    const into = equalPowerFade(0, 0.85)
    for (let i = 0; i < out.length; i++) expect(out[i] ** 2 + into[i] ** 2).toBeCloseTo(0.85 ** 2, 5)
  })
})

// ─── Lifecycle, on a fake context ───
// Records every node, its connections, and the oscillators' stop times, so
// the test can fire 'ended' and check that nothing is left connected.

class FakeParam {
  value: number
  curves: { curve: Float32Array; time: number; duration: number }[] = []
  constructor(value: number) { this.value = value }
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime(value: number) { this.value = value }
  setValueCurveAtTime(curve: Float32Array, time: number, duration: number) { this.curves.push({ curve, time, duration }) }
}

class FakeNode {
  outs = new Set<unknown>()
  connect<T>(to: T): T { this.outs.add(to); return to }
  disconnect() { this.outs.clear() }
}

class FakeOscillator extends FakeNode {
  type = 'sine'
  frequency = new FakeParam(440)
  startedAt: number | null = null
  stoppedAt: number | null = null
  onended: (() => void) | null = null
  start(t: number) { this.startedAt = t }
  stop(t: number) { this.stoppedAt = t }
}

function fakeGraph() {
  const nodes: FakeNode[] = []
  const track = <T extends FakeNode>(n: T): T => { nodes.push(n); return n }
  const ctx = {
    currentTime: 0,
    createGain: () => track(Object.assign(new FakeNode(), { gain: new FakeParam(1) })),
    createOscillator: () => track(new FakeOscillator()),
    createBiquadFilter: () => track(Object.assign(new FakeNode(), { type: 'lowpass', Q: new FakeParam(1), frequency: new FakeParam(350) })),
    createStereoPanner: () => track(Object.assign(new FakeNode(), { pan: new FakeParam(0) })),
  }
  const droneBus = new FakeNode()
  const graph = { ctx, droneBus } as unknown as Graph
  const oscillators = () => nodes.filter((n): n is FakeOscillator => n instanceof FakeOscillator)
  /** What the audio thread would do when every stopped oscillator reaches its stop time. */
  const endStopped = () => { for (const o of oscillators()) if (o.stoppedAt !== null) o.onended?.() }
  return { ctx, graph, droneBus, nodes, oscillators, endStopped }
}

describe('createDrone', () => {
  it('starts with a fade-in on droneBus and reports its root', () => {
    const f = fakeGraph()
    const drone = createDrone(f.graph)
    expect(drone.isOn()).toBe(false)
    expect(drone.root()).toBeNull()
    drone.start(9)
    expect(drone.isOn()).toBe(true)
    expect(drone.root()).toBe(9)
    expect(f.droneBus.outs.size).toBe(0)
    expect(f.nodes.some(n => n.outs.has(f.droneBus))).toBe(true)
    const fadeIn = f.nodes.flatMap(n => (n as { gain?: FakeParam }).gain?.curves ?? [])
    expect(fadeIn).toHaveLength(1)
    expect(fadeIn[0].curve[0]).toBe(0)
    expect(fadeIn[0].duration).toBeGreaterThanOrEqual(3)
    // Root A2 and fifth E3 are among the oscillator frequencies
    const freqs = f.oscillators().map(o => o.frequency.value)
    expect(freqs.some(hz => Math.abs(hz - 110) < 1e-9)).toBe(true)
    expect(freqs.some(hz => Math.abs(hz - midiToFreq(52)) < 1e-9)).toBe(true)
    expect(f.oscillators().every(o => o.startedAt === 0 && o.stoppedAt === null)).toBe(true)
  })

  it('stops with a fade, then disconnects every node it made', () => {
    const f = fakeGraph()
    const drone = createDrone(f.graph)
    drone.start(9)
    f.ctx.currentTime = 10
    drone.stop()
    expect(drone.isOn()).toBe(false)
    expect(drone.root()).toBeNull()
    // Every oscillator is told to stop after the fade, not at once
    expect(f.oscillators().every(o => o.stoppedAt !== null && o.stoppedAt > 10)).toBe(true)
    expect(f.nodes.some(n => n.outs.size > 0)).toBe(true) // still fading
    f.endStopped()
    expect(f.nodes.filter(n => n.outs.size > 0)).toEqual([])
    drone.stop() // idempotent
  })

  it('crossfades to a new root and tears the old set down only once it has ended', () => {
    const f = fakeGraph()
    const drone = createDrone(f.graph)
    drone.start(9)
    const firstSet = [...f.nodes]
    f.ctx.currentTime = 6
    drone.start(9) // same root: nothing new
    expect(f.nodes.length).toBe(firstSet.length)
    drone.start(0)
    expect(drone.root()).toBe(0)
    const secondSet = f.nodes.slice(firstSet.length)
    expect(secondSet.length).toBeGreaterThan(0)
    // The old set fades out (curve from where it was to 0) while the new one fades in from 0
    const curves = f.nodes.flatMap(n => (n as { gain?: FakeParam }).gain?.curves ?? [])
    expect(curves.filter(c => c.time === 6)).toHaveLength(2)
    expect(firstSet.some(n => n.outs.size > 0)).toBe(true)
    f.endStopped()
    // Old voices gone; the new set and the shared level gain still feed the bus
    const level = firstSet.find(n => n.outs.has(f.droneBus))
    expect(firstSet.filter(n => n !== level && n.outs.size > 0)).toEqual([])
    expect(level?.outs.has(f.droneBus)).toBe(true)
    expect(secondSet.every(n => n instanceof FakeOscillator ? n.stoppedAt === null : true)).toBe(true)
    drone.stop()
    f.endStopped()
    expect(f.nodes.filter(n => n.outs.size > 0)).toEqual([])
  })

  it('keeps the level gain while a stopped set is still fading under a new start', () => {
    const f = fakeGraph()
    const drone = createDrone(f.graph)
    drone.start(9)
    drone.stop()
    drone.start(4)
    // The first set ends; the second is still playing through the same level gain
    for (const o of f.oscillators()) if (o.stoppedAt !== null) o.onended?.()
    expect(f.nodes.some(n => n.outs.has(f.droneBus))).toBe(true)
    expect(drone.root()).toBe(4)
  })

  it('clamps the level to 0–1 and applies it live', () => {
    const f = fakeGraph()
    const drone = createDrone(f.graph)
    drone.start(9)
    const level = f.nodes.find(n => n.outs.has(f.droneBus)) as FakeNode & { gain: FakeParam }
    drone.setLevel(2)
    expect(level.gain.value).toBe(1)
    drone.setLevel(-1)
    expect(level.gain.value).toBe(0)
    drone.setLevel(0.3)
    expect(level.gain.value).toBe(0.3)
  })

  it('refuses a root that is not a number', () => {
    const drone = createDrone(fakeGraph().graph)
    expect(() => drone.start(Number.NaN)).toThrow(RangeError)
  })
})
