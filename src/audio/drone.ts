// Adapted from ModalRuns (same author): src/utils/audioEngine.ts, the generative drone.
//
// ─── Drone ──────────────────────────────────────────────────────────
// A root + fifth bed to improvise against, on graph.droneBus. Simplified from
// ModalRuns: no sub octave, no saturation, no reverb (the app adds none in
// M1). What stays is what makes it breathe: three slightly detuned sines on
// the root that beat slowly against each other, a lowpass that opens and
// closes over twenty seconds, and a slow tremolo.
//
//   voices ─ lowpass (± LFO) ─ tremolo ─ envelope ─┐
//                                                  ├─ level ─ droneBus
//   (a retune builds a second set and crossfades) ─┘
//
// Every set fades in and fades out on the audio clock, and its oscillators are
// stopped at the end of the fade; their 'ended' event tears the set down and
// disconnects every node (ModalRuns golden rule 5). Using 'ended' rather than
// a timer ties cleanup to when the audio actually finished.

import type { Graph } from './graph'
import { toPc } from '../theory/notes'

export interface Drone {
  start(rootPc: number): void
  stop(): void
  /** 0–1, linear. Applies live, without retriggering the swell. */
  setLevel(v: number): void
  isOn(): boolean
  root(): number | null
}

// ─── Pure helpers ───

/** The pedal sits in octave 2 (C2–B2, 65–123 Hz): under the guitar, not on top of it. */
export function droneNotes(rootPc: number): { root: number; fifth: number } {
  const root = 36 + toPc(Math.round(rootPc))
  return { root, fifth: root + 7 }
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

/**
 * A quarter-sine gain curve from `from` to `to`. A fade-out (cos) and a
 * fade-in (sin) of the same peak sum to constant power, so a retune between
 * two unrelated chords does not dip in the middle as a linear crossfade does.
 */
export function equalPowerFade(from: number, to: number, points = 64): Float32Array {
  const curve = new Float32Array(points)
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * (Math.PI / 2)
    curve[i] = to >= from ? from + (to - from) * Math.sin(t) : to + (from - to) * Math.cos(t)
  }
  return curve
}

// ─── Sound ───

const PEAK = 0.85 // envelope peak; the level control scales after it
const FADE_IN = 5 // seconds, the slow bloom from silence
const RETUNE = 2.5 // seconds, crossfade to a new root
const FADE_OUT = 2.5 // seconds
const DEFAULT_LEVEL = 0.5
const TONE_HZ = 2700 // lowpass centre (ModalRuns' default Tone setting)

type Layer = readonly [ratio: number, type: OscillatorType, gain: number]

interface Voice { interval: number; level: number; pan: number; layers: readonly Layer[] }

const VOICES: readonly Voice[] = [
  {
    interval: 0, level: 0.28, pan: 0, layers: [
      [1, 'sine', 0.5],
      // ±6 cents: the slow beating between these three is the "movement"
      [1.0035, 'sine', 0.35],
      [0.9965, 'sine', 0.35],
      // A triangle an octave up, so a laptop speaker that cannot move 65–123 Hz still hears the root
      [2, 'triangle', 0.3],
      [3, 'sine', 0.09],
    ],
  },
  {
    interval: 7, level: 0.14, pan: -0.15, layers: [
      [1, 'sine', 0.5],
      [1.004, 'sine', 0.3],
      [2, 'triangle', 0.22],
    ],
  },
]

interface VoiceSet {
  root: number
  envelope: GainNode
  oscillators: OscillatorNode[]
  nodes: AudioNode[]
}

export function createDrone(graph: Graph): Drone {
  const { ctx } = graph
  let levelValue = DEFAULT_LEVEL
  let level: GainNode | null = null
  let current: VoiceSet | null = null
  const fading = new Set<VoiceSet>()

  function build(pc: number, fadeSeconds: number, fromSilence: boolean, out: GainNode): VoiceSet {
    const now = ctx.currentTime
    const nodes: AudioNode[] = []
    const oscillators: OscillatorNode[] = []
    const gain = (value: number): GainNode => {
      const g = ctx.createGain()
      g.gain.value = value
      nodes.push(g)
      return g
    }
    const osc = (type: OscillatorType, freq: number): OscillatorNode => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = freq
      oscillators.push(o)
      return o
    }

    const envelope = gain(0)
    envelope.gain.setValueCurveAtTime(equalPowerFade(0, PEAK), now, fadeSeconds)

    // Tremolo on its own gain, not on the envelope (ModalRuns added it to the
    // envelope's gain, so a "silent" envelope still wobbled at ±0.06).
    const tremolo = gain(1)
    osc('sine', 0.08).connect(gain(0.06)).connect(tremolo.gain)

    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.Q.value = 0.6
    // From silence it opens from dark as it blooms. A retune starts open, so
    // the crossfade does not sound like the drone dimming.
    lowpass.frequency.setValueAtTime(fromSilence ? TONE_HZ * 0.3 : TONE_HZ, now)
    if (fromSilence) lowpass.frequency.linearRampToValueAtTime(TONE_HZ, now + fadeSeconds + 3)
    nodes.push(lowpass)
    osc('sine', 0.05).connect(gain(500)).connect(lowpass.frequency)

    lowpass.connect(tremolo).connect(envelope).connect(out)

    const { root } = droneNotes(pc)
    for (const voice of VOICES) {
      const base = midiToFreq(root + voice.interval)
      const panner = ctx.createStereoPanner()
      panner.pan.value = voice.pan
      nodes.push(panner)
      const voiceGain = gain(voice.level)
      voiceGain.connect(panner).connect(lowpass)
      for (const [ratio, type, g] of voice.layers) osc(type, base * ratio).connect(gain(g)).connect(voiceGain)
    }

    for (const o of oscillators) o.start(now)
    return { root: pc, envelope, oscillators, nodes }
  }

  function release(set: VoiceSet, seconds: number): void {
    const now = ctx.currentTime
    const from = set.envelope.gain.value // read before cancelling
    set.envelope.gain.cancelScheduledValues(now)
    set.envelope.gain.setValueCurveAtTime(equalPowerFade(from, 0), now, seconds)
    fading.add(set)
    // All oscillators stop together, so one 'ended' covers the set.
    set.oscillators[0].onended = () => teardown(set)
    for (const o of set.oscillators) o.stop(now + seconds + 0.05)
  }

  function teardown(set: VoiceSet): void {
    for (const o of set.oscillators) o.disconnect()
    for (const n of set.nodes) n.disconnect()
    fading.delete(set)
    if (!current && fading.size === 0 && level) {
      level.disconnect()
      level = null
    }
  }

  return {
    start(rootPc) {
      if (!Number.isFinite(rootPc)) throw new RangeError(`Drone root must be a pitch class, got ${rootPc}.`)
      const pc = toPc(Math.round(rootPc))
      if (current?.root === pc) return
      if (!level) {
        level = ctx.createGain()
        level.gain.value = levelValue
        level.connect(graph.droneBus)
      }
      const previous = current
      if (previous) release(previous, RETUNE)
      current = previous ? build(pc, RETUNE, false, level) : build(pc, FADE_IN, true, level)
    },

    stop() {
      if (!current) return
      release(current, FADE_OUT)
      current = null
    },

    setLevel(v) {
      levelValue = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
      level?.gain.setTargetAtTime(levelValue, ctx.currentTime, 0.05)
    },

    isOn: () => current !== null,
    root: () => current?.root ?? null,
  }
}
