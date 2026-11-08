import { describe, expect, it } from 'vitest'
// ?raw: Vite's text import, so the test needs no Node types (tsconfig has none)
import IDENTITY from '../../tests/fixtures/identity.nam?raw'
import {
  LOAD_LOCKED_MESSAGE, MAX_IR_SECONDS, checkIr, checkModelText, createTone, gainForDb, summarizeModel,
  unsupportedMessage,
} from './tone'
import type { Graph } from './graph'

// ─── Pure helpers ───

describe('gainForDb', () => {
  it('converts dB to linear gain', () => {
    expect(gainForDb(0)).toBe(1)
    expect(gainForDb(-6)).toBeCloseTo(0.5012, 4)
    expect(gainForDb(6)).toBeCloseTo(1.9953, 4)
  })

  it('treats -60 dB and below, and NaN, as silence', () => {
    expect(gainForDb(-60)).toBe(0)
    expect(gainForDb(-Infinity)).toBe(0)
    expect(gainForDb(Number.NaN)).toBe(0)
  })

  it('caps boosts at +24 dB', () => {
    expect(gainForDb(40)).toBeCloseTo(10 ** (24 / 20), 6)
  })
})

describe('summarizeModel', () => {
  const a2 = { slimmable: true, slimmableBreakpoints: [0.5], hasLoudness: true, loudness: -8.84, expectedSampleRate: 48000 }

  it('flags a model trained at another rate than the context runs', () => {
    const s = summarizeModel('deluxe-a2.nam', a2, 44100)
    expect(s).toEqual({
      name: 'deluxe-a2.nam', expectedSampleRate: 48000, contextSampleRate: 44100, sampleRateMismatch: true,
      slimmable: true, slimmableBreakpoints: [0.5], loudnessDb: -8.84,
    })
    expect(summarizeModel('x', a2, 48000).sampleRateMismatch).toBe(false)
  })

  it('does not call an unknown rate (-1) a mismatch, and reports no loudness when the model has none', () => {
    const s = summarizeModel('identity.nam', { ...a2, slimmable: false, slimmableBreakpoints: [], hasLoudness: false, loudness: 0, expectedSampleRate: -1 }, 44100)
    expect(s.sampleRateMismatch).toBe(false)
    expect(s.loudnessDb).toBeNull()
  })

  it('copies the breakpoints instead of sharing the engine array', () => {
    const info = { ...a2, slimmableBreakpoints: [0.5] }
    const s = summarizeModel('x', info, 48000)
    info.slimmableBreakpoints.push(0.9)
    expect(s.slimmableBreakpoints).toEqual([0.5])
  })
})

describe('checkModelText', () => {
  it('accepts the identity fixture', () => {
    expect(checkModelText('identity.nam', IDENTITY)).toBeNull()
  })

  it('refuses files that are not NAM models, by name', () => {
    expect(checkModelText('take.wav', 'RIFF\u0000\u0000WAVEfmt ')).toBe('take.wav is not a NAM model file (it is not JSON).')
    expect(checkModelText('a.json', '[1,2]')).toMatch(/no architecture or version/)
    expect(checkModelText('a.json', 'null')).toMatch(/no architecture or version/)
    expect(checkModelText('a.json', '{"architecture":"Linear"}')).toMatch(/no architecture or version/)
  })
})

describe('checkIr', () => {
  it('accepts mono and stereo IRs', () => {
    expect(checkIr('cab.wav', 1, 0.5)).toBeNull()
    expect(checkIr('cab.wav', 2, 0.5)).toBeNull()
  })

  it('refuses other channel counts, empty files and anything longer than the ceiling', () => {
    expect(checkIr('room.wav', 4, 1)).toBe('room.wav has 4 channels; an IR must be mono or stereo.')
    expect(checkIr('cab.wav', 1, 0)).toBe('cab.wav is empty.')
    expect(checkIr('song.wav', 2, 185.2)).toBe(`song.wav is 185.2 s long; an IR must be ${MAX_IR_SECONDS} s or shorter.`)
  })
})

// ─── The fixture this repo owns ───

describe('tests/fixtures/identity.nam', () => {
  it('is a one-tap Linear model with unity weight and no bias, in a format NAM core accepts', () => {
    const model = JSON.parse(IDENTITY)
    expect(model.architecture).toBe('Linear')
    expect(model.config).toEqual({ receptive_field: 1, bias: false })
    expect(model.weights).toEqual([1])
    // NAM core at the engine's pinned commit accepts 0.5.0 through 0.7.x
    const [major, minor] = model.version.split('.').map(Number)
    expect(major).toBe(0)
    expect(minor).toBeGreaterThanOrEqual(5)
    expect(minor).toBeLessThanOrEqual(7)
    // No loudness: the engine would otherwise normalise it away from unity
    expect(model.metadata?.loudness).toBeUndefined()
  })
})

// ─── The chain, on a fake context ───
// Node has no Web Audio. This fake records connections and evaluates
// set/ramp/cancel automation, enough to test routing and the mode hand-over.
// The engine cannot attach here (no AudioWorklet), which doubles as the
// engine-failure test; the engine itself is verified in Chromium.

type Event = { kind: 'set' | 'ramp'; value: number; time: number }

class FakeParam {
  events: Event[] = []
  constructor(private readonly clock: { currentTime: number }, private readonly initial: number) {}

  at(t: number): number {
    let value = this.initial
    let since = 0
    for (const e of this.events) {
      if (e.time <= t) { value = e.value; since = e.time; continue }
      if (e.kind === 'ramp') return value + (e.value - value) * (t - since) / (e.time - since)
      break
    }
    return value
  }

  get value(): number { return this.at(this.clock.currentTime) }
  set value(v: number) { this.events = [{ kind: 'set', value: v, time: 0 }] }
  cancelScheduledValues(t: number) { this.events = this.events.filter(e => e.time < t) }
  setValueAtTime(value: number, time: number) { this.add({ kind: 'set', value, time }) }
  linearRampToValueAtTime(value: number, time: number) { this.add({ kind: 'ramp', value, time }) }
  private add(e: Event) { this.events.push(e); this.events.sort((a, b) => a.time - b.time) }
}

class FakeNode {
  outs = new Set<FakeNode>()
  ins = new Set<FakeNode>()
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'
  connect<T extends FakeNode>(to: T): T { this.outs.add(to); to.ins.add(this); return to }
  disconnect(to?: FakeNode) {
    if (!to) { for (const o of this.outs) o.ins.delete(this); this.outs.clear(); return }
    if (!this.outs.delete(to)) throw new Error('InvalidAccessError: not connected')
    to.ins.delete(this)
  }
}

class FakeGain extends FakeNode {
  gain: FakeParam
  constructor(clock: { currentTime: number }) { super(); this.gain = new FakeParam(clock, 1) }
}

function fakeGraph(ampSupported: boolean, renderQuantum = ampSupported ? 128 : 256) {
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'suspended',
    createGain: () => new FakeGain(ctx),
    createConvolver: () => new FakeNode(),
  }
  const guitarBus = new FakeGain(ctx)
  const graph = { ctx, guitarBus, ampSupported, renderQuantum } as unknown as Graph
  const mono = new FakeNode()
  const stereo = new FakeNode()
  return { ctx, graph, guitarBus, mono, stereo }
}

/** The two gains that feed guitarBus: the one the stereo input reaches is the bypass send. */
function sends(f: ReturnType<typeof fakeGraph>, tone: ReturnType<typeof createTone>) {
  tone.connectInput(f.mono as unknown as AudioNode, f.stereo as unknown as AudioNode)
  const bypass = [...f.stereo.outs][0] as FakeGain
  const amp = [...f.guitarBus.ins].find(n => n !== bypass) as FakeGain
  return { amp, bypass }
}

/** Whether any chain of connections leads from one node to another. */
function reaches(from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()): boolean {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  return [...from.outs].some(o => reaches(o, to, seen))
}

describe('createTone when the render quantum is not 128', () => {
  it('reports unsupported, forces bypass, and refuses every load', async () => {
    const f = fakeGraph(false)
    const tone = createTone(f.graph)
    await expect(tone.ready).resolves.toBeUndefined()
    expect(tone.status()).toBe('unsupported')
    expect(tone.error()).toBe(unsupportedMessage(256))
    expect(tone.mode()).toBe('bypass')
    tone.setMode('amp')
    expect(tone.mode()).toBe('bypass')

    const { amp, bypass } = sends(f, tone)
    expect(bypass.gain.value).toBe(1)
    expect(amp.gain.value).toBe(0)

    await expect(tone.loadModel({ name: 'identity.nam', text: IDENTITY })).rejects.toThrow(unsupportedMessage(256))
    await expect(tone.loadIr({ name: 'cab.wav', data: new ArrayBuffer(8) })).rejects.toThrow(unsupportedMessage(256))
    await expect(tone.setSlim(0.5)).rejects.toThrow(unsupportedMessage(256))
  })
})

describe('createTone when the engine cannot start', () => {
  it('reports the failure through ready, status and error, and keeps the amp path silent', async () => {
    const f = fakeGraph(true)
    const tone = createTone(f.graph)
    expect(tone.status()).toBe('loading-engine')
    await expect(tone.ready).rejects.toThrow(/The amp engine failed to start: AudioWorklet is not available/)
    expect(tone.status()).toBe('error')
    expect(tone.error()).toMatch(/AudioWorklet is not available/)
    expect(tone.mode()).toBe('amp')
    // 'amp' with no engine must be silence, not the dry DI: no path from the mono input reaches the bus
    const { amp, bypass } = sends(f, tone)
    expect(reaches(f.mono, f.guitarBus)).toBe(false)
    expect(amp.gain.value).toBe(1)
    expect(bypass.gain.value).toBe(0)
    await expect(tone.loadModel({ name: 'identity.nam', text: IDENTITY })).rejects.toThrow(/failed to start/)
  })
})

describe('setLoadLock', () => {
  it('refuses model, IR and slim loads while locked, with a sentence the UI can show', async () => {
    const tone = createTone(fakeGraph(true).graph)
    await tone.ready.catch(() => {})
    tone.setLoadLock(true)
    await expect(tone.loadModel({ name: 'identity.nam', text: IDENTITY })).rejects.toThrow(LOAD_LOCKED_MESSAGE)
    await expect(tone.loadIr({ name: 'cab.wav', data: new ArrayBuffer(8) })).rejects.toThrow(LOAD_LOCKED_MESSAGE)
    await expect(tone.setSlim(0.5)).rejects.toThrow(LOAD_LOCKED_MESSAGE)
    // Unlocked, the same call gets past the lock (and fails on the missing engine instead)
    tone.setLoadLock(false)
    await expect(tone.loadModel({ name: 'identity.nam', text: IDENTITY })).rejects.toThrow(/failed to start/)
  })

  it('also refuses a load that was queued before the lock was set', async () => {
    const tone = createTone(fakeGraph(true).graph)
    await tone.ready.catch(() => {})
    const queued = tone.loadModel({ name: 'identity.nam', text: IDENTITY })
    tone.setLoadLock(true)
    await expect(queued).rejects.toThrow(LOAD_LOCKED_MESSAGE)
  })

  it('rejects a slim size that is not a number before anything else', async () => {
    const tone = createTone(fakeGraph(true).graph)
    await tone.ready.catch(() => {})
    await expect(tone.setSlim(Number.NaN)).rejects.toThrow(RangeError)
  })
})

describe('mode hand-over', () => {
  /** Largest value both sends hold at the same moment, sampled every 0.1 ms. */
  function worstOverlap(amp: FakeGain, bypass: FakeGain, until: number): number {
    let worst = 0
    for (let t = 0; t <= until; t += 0.0001) worst = Math.max(worst, Math.min(amp.gain.at(t), bypass.gain.at(t)))
    return worst
  }

  it('fades the outgoing path out before the incoming one opens', async () => {
    const f = fakeGraph(true)
    const tone = createTone(f.graph)
    await tone.ready.catch(() => {})
    const { amp, bypass } = sends(f, tone)
    let changes = 0
    tone.onChange(() => changes++)

    f.ctx.currentTime = 1
    tone.setMode('bypass')
    expect(tone.mode()).toBe('bypass')
    expect(changes).toBe(1)
    expect(amp.gain.at(1)).toBe(1)
    expect(amp.gain.at(1.015)).toBe(0)
    expect(bypass.gain.at(1.015)).toBe(0)
    expect(bypass.gain.at(1.03)).toBe(1)
    expect(worstOverlap(amp, bypass, 2)).toBe(0)

    tone.setMode('bypass')
    expect(changes).toBe(1) // no-op
  })

  it('never overlaps, however fast the player toggles', async () => {
    const f = fakeGraph(true)
    const tone = createTone(f.graph)
    await tone.ready.catch(() => {})
    const { amp, bypass } = sends(f, tone)
    const toggles = [1, 1.004, 1.012, 1.02, 1.021, 1.05, 1.0505, 1.06]
    for (const t of toggles) {
      f.ctx.currentTime = t
      tone.setMode(tone.mode() === 'amp' ? 'bypass' : 'amp')
    }
    expect(tone.mode()).toBe('amp')
    expect(worstOverlap(amp, bypass, 1.2)).toBeLessThan(1e-9)
    expect(amp.gain.at(1.2)).toBe(1)
    expect(bypass.gain.at(1.2)).toBe(0)
  })
})

describe('connectInput', () => {
  it('feeds the mono source to the amp and the stereo source to the bypass, and disconnects only those links', async () => {
    const f = fakeGraph(true)
    const tone = createTone(f.graph)
    await tone.ready.catch(() => {})
    const analyser = new FakeNode()
    f.mono.connect(analyser)
    tone.connectInput(f.mono as unknown as AudioNode, f.stereo as unknown as AudioNode)
    expect(f.mono.outs.size).toBe(2)
    expect(f.stereo.outs.size).toBe(1)
    tone.disconnectInput()
    expect([...f.mono.outs]).toEqual([analyser]) // the pitch tap survives
    expect(f.stereo.outs.size).toBe(0)
    tone.disconnectInput() // idempotent
  })
})
