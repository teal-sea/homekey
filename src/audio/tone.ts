// ─── Tone ───────────────────────────────────────────────────────────
// The amp: a Neural Amp Modeler model and an optional cab IR on the selected
// input channel, or a stereo bypass for input that is already processed (a
// GT-1, a pedalboard). Exactly one of the two reaches guitarBus:
//
//   mono ─ inputGain ─ NamNode ─ [convolver] ─ ampGate ─ outputGain ─ ampSend ─┐
//                                                                               ├─ guitarBus
//   stereo ─ bypassSend ───────────────────────────────────────────────────────┘
//
// ampGate is closed whenever no model is ready. An empty NamNode passes its
// input through untouched, so without the gate 'amp' mode with no model would
// play the dry DI, which sounds like a broken amp rather than "load a model".
// The gate also ducks the path around loads and IR swaps, so a rewire or the
// load's audio-thread stall never lands on a live signal.
//
// Loudness: NAM's engine already normalises a loudness-aware model to -18 dB,
// the NAM plugin's convention: gain = 10^((-18 - loudness) / 20), clamped to
// ±12 dB (nam-engine.cpp, TargetOutputGain). Measured 2026-11-08: an identity
// model whose metadata says loudness -6 dB comes out 12.0 dB down. Applying
// the same gain here would double it, so there is no normalisation node in
// this file and ModelSummary.loudnessDb is for display only.
//
// Loads freeze the whole audio thread (SPEC rule 6). The UI keeps them away
// from a running transport; setLoadLock is the second fence, so a stray call
// is refused instead of glitching a take. The fence works the other way too:
// busy() is true while a load is under way, and the transport waits for it.

import { NamEngine, type NamModelInfo, type NamNode } from 'neural-amp-modeler-wasm/engine'
import { RAMP, rampTo, type Graph } from './graph'

export type ToneMode = 'amp' | 'bypass'

export interface ModelSummary {
  name: string
  /** What the model was trained at, in Hz; -1 when the file does not say. */
  expectedSampleRate: number
  contextSampleRate: number
  /** The engine runs the model at the context rate without resampling, so a mismatch changes the sound. */
  sampleRateMismatch: boolean
  slimmable: boolean
  slimmableBreakpoints: number[]
  /** The model's own loudness. The engine already normalises it to -18 dB; this is informational. */
  loudnessDb: number | null
}

export type ToneStatus = 'loading-engine' | 'no-model' | 'loading-model' | 'ready' | 'unsupported' | 'error'

export interface IrInfo { name: string; seconds: number }

export interface Tone {
  /** Resolves when the engine is attached (at once when unsupported); rejects if it cannot start. */
  ready: Promise<void>
  connectInput(mono: AudioNode, stereo: AudioNode): void
  disconnectInput(): void
  setMode(m: ToneMode): void
  mode(): ToneMode
  loadModel(src: { name: string; text: string }): Promise<ModelSummary>
  /** Raw NAM slimmable size in [0, 1]; a no-op for models that are not slimmable. */
  setSlim(v: number): Promise<void>
  loadIr(src: { name: string; data: ArrayBuffer }): Promise<IrInfo>
  clearIr(): void
  setInputGainDb(db: number): void
  setOutputGainDb(db: number): void
  /** While locked, loadModel, loadIr and setSlim reject: each one stalls the audio thread. */
  setLoadLock(locked: boolean): void
  /**
   * A model, slim, IR or Clear IR operation is queued or running. The lock
   * cannot stop one that is already past its check, so the looper must not
   * start the transport while this is true (SPEC rule 6). onChange fires
   * when it flips.
   */
  busy(): boolean
  model(): ModelSummary | null
  ir(): IrInfo | null
  status(): ToneStatus
  error(): string | null
  onChange(cb: () => void): () => void
  dispose(): Promise<void>
}

// ─── Pure helpers ───

export const LOAD_LOCKED_MESSAGE =
  'Stop the looper before loading a model or IR: a model load freezes all audio for a moment.'

export function unsupportedMessage(renderQuantum: number): string {
  return `The amp needs a 128-frame audio render quantum and this browser is running ${renderQuantum}. ` +
    'Only bypass is available.'
}

const MIN_DB = -60
const MAX_DB = 24

/** dB to linear gain, capped at +24 dB. -60 dB and below (or NaN) is silence. */
export function gainForDb(db: number): number {
  if (!(db > MIN_DB)) return 0
  return 10 ** (Math.min(db, MAX_DB) / 20)
}

export function summarizeModel(name: string, info: NamModelInfo, contextSampleRate: number): ModelSummary {
  const expected = info.expectedSampleRate
  return {
    name,
    expectedSampleRate: expected,
    contextSampleRate,
    // An unknown rate (-1) is not a mismatch: there is nothing to compare.
    sampleRateMismatch: expected > 0 && Math.round(expected) !== Math.round(contextSampleRate),
    slimmable: info.slimmable,
    slimmableBreakpoints: [...info.slimmableBreakpoints],
    loudnessDb: info.hasLoudness ? info.loudness : null,
  }
}

/**
 * A main-thread sanity check before the text goes to the audio thread. A
 * wrong file (a .wav picked by mistake) then fails with a sentence instead of
 * a JSON parser error, and without stalling audio. Returns a message or null.
 */
export function checkModelText(name: string, text: string): string | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return `${name} is not a NAM model file (it is not JSON).`
  }
  const fields = typeof json === 'object' && json !== null && !Array.isArray(json) ? json as Record<string, unknown> : null
  if (!fields || typeof fields.architecture !== 'string' || typeof fields.version !== 'string') {
    return `${name} is not a NAM model file (it has no architecture or version).`
  }
  return null
}

/** A cab IR is milliseconds long; a 10 s ceiling still admits a long room and refuses a song picked by mistake. */
export const MAX_IR_SECONDS = 10

export function checkIr(name: string, channels: number, seconds: number): string | null {
  if (channels < 1 || channels > 2) return `${name} has ${channels} channels; an IR must be mono or stereo.`
  if (!(seconds > 0)) return `${name} is empty.`
  if (seconds > MAX_IR_SECONDS) return `${name} is ${seconds.toFixed(1)} s long; an IR must be ${MAX_IR_SECONDS} s or shorter.`
  return null
}

const messageOf = (err: unknown): string => err instanceof Error ? err.message : String(err)

// ─── Gain automation ───

/**
 * Hand the bus from one path to the other. The incoming path waits until the
 * outgoing one is silent: a 30 ms dip rather than a doubled guitar. Scheduled
 * on the audio clock, so it holds however late the main thread is.
 */
function handOver(ctx: BaseAudioContext, off: AudioParam, on: AudioParam): void {
  const now = ctx.currentTime
  const offFrom = off.value
  const onFrom = on.value
  // Toggled back before the other path ever opened: nothing to wait for.
  const opensAt = offFrom > 0 ? now + RAMP : now
  off.cancelScheduledValues(now)
  off.setValueAtTime(offFrom, now)
  off.linearRampToValueAtTime(0, now + RAMP)
  on.cancelScheduledValues(now)
  on.setValueAtTime(onFrom, now)
  on.setValueAtTime(onFrom, opensAt)
  on.linearRampToValueAtTime(1, opensAt + RAMP)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ─── Tone chain ───

export function createTone(graph: Graph, opts: { assetBaseUrl?: string } = {}): Tone {
  const { ctx } = graph
  const assetBaseUrl = opts.assetBaseUrl ?? '/nam/'

  const inputGain = ctx.createGain()
  const ampGate = ctx.createGain()
  const outputGain = ctx.createGain()
  const ampSend = ctx.createGain()
  const bypassSend = ctx.createGain()
  bypassSend.channelCount = 2
  bypassSend.channelCountMode = 'explicit'
  bypassSend.channelInterpretation = 'speakers'

  let mode: ToneMode = graph.ampSupported ? 'amp' : 'bypass'
  ampGate.gain.value = 0
  ampSend.gain.value = mode === 'amp' ? 1 : 0
  bypassSend.gain.value = mode === 'bypass' ? 1 : 0
  ampGate.connect(outputGain).connect(ampSend).connect(graph.guitarBus)
  bypassSend.connect(graph.guitarBus)

  let nam: NamNode | null = null
  let convolver: ConvolverNode | null = null
  let current: ModelSummary | null = null
  let irInfo: IrInfo | null = null
  let status: ToneStatus = graph.ampSupported ? 'loading-engine' : 'unsupported'
  let lastError: string | null = graph.ampSupported ? null : unsupportedMessage(graph.renderQuantum)
  let locked = false
  let disposed = false
  let gateOpen = false
  let inputs: { mono: AudioNode; stereo: AudioNode } | null = null
  const listeners = new Set<() => void>()

  const emit = () => { for (const cb of [...listeners]) cb() }
  const settle = () => { status = current ? 'ready' : 'no-model' }

  // NamNode → [convolver] → ampGate, rebuilt whenever either end changes.
  const wire = () => {
    if (!nam) return
    nam.disconnect()
    convolver?.disconnect()
    if (convolver) nam.connect(convolver).connect(ampGate)
    else nam.connect(ampGate)
  }

  async function duck(): Promise<void> {
    if (!gateOpen) return
    gateOpen = false
    rampTo(ampGate.gain, ctx, 0)
    // Let the ramp land before the path is cut or the audio thread stalls. A
    // suspended context is silent and its clock does not move: no wait.
    if (ctx.state === 'running') await sleep(RAMP * 1000 + 10)
  }

  function openGate(): void {
    const open = current !== null && !disposed
    if (open === gateOpen) return
    gateOpen = open
    rampTo(ampGate.gain, ctx, open ? 1 : 0)
  }

  const ready: Promise<void> = graph.ampSupported ? (async () => {
    try {
      const engine = await NamEngine.attach(ctx, { assetBaseUrl })
      const node = await engine.createNode()
      if (disposed) { await node.dispose().catch(() => {}); return }
      nam = node
      inputGain.connect(nam)
      wire()
      status = 'no-model'
      emit()
    } catch (err) {
      lastError = `The amp engine failed to start: ${messageOf(err)}`
      status = 'error'
      emit()
      throw new Error(lastError, { cause: err })
    }
  })() : Promise.resolve()
  // status() and error() carry an engine failure; this only keeps it from
  // also surfacing as an unhandled rejection when nobody awaits `ready`.
  ready.catch(() => {})

  // Model and IR operations run one at a time, in call order. Overlapping
  // loads would interleave their ducks and leave the gate in the wrong state.
  // `pending` counts them from the call until they settle: a load that has
  // passed the lock check keeps going whatever the lock says next, so the
  // looper has to wait for it instead.
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  function serial<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op)
    queue = run.catch(() => {})
    if (++pending === 1) emit()
    const settled = () => { if (--pending === 0) emit() }
    run.then(settled, settled)
    return run
  }

  function refusal(): string | null {
    if (disposed) return 'The tone chain has been disposed.'
    if (!graph.ampSupported) return unsupportedMessage(graph.renderQuantum)
    if (locked) return LOAD_LOCKED_MESSAGE
    return null
  }

  // Checked when called and again when the queued operation starts: a lock set
  // in between (the transport started) still wins.
  function guarded<T>(op: () => Promise<T>): Promise<T> {
    const early = refusal()
    if (early) return Promise.reject(new Error(early))
    return serial(async () => {
      const late = refusal()
      if (late) throw new Error(late)
      return op()
    })
  }

  function fail(message: string, cause?: unknown): Error {
    lastError = message
    emit()
    return new Error(message, cause === undefined ? undefined : { cause })
  }

  function disconnectInput(): void {
    if (!inputs) return
    // Targeted disconnects: the mono source also feeds the pitch analyser.
    try { inputs.mono.disconnect(inputGain) } catch { /* already gone */ }
    try { inputs.stereo.disconnect(bypassSend) } catch { /* already gone */ }
    inputs = null
  }

  return {
    ready,

    connectInput(mono, stereo) {
      if (disposed) throw new Error('The tone chain has been disposed.')
      disconnectInput()
      mono.connect(inputGain)
      stereo.connect(bypassSend)
      inputs = { mono, stereo }
    },

    disconnectInput,

    setMode(m) {
      const next: ToneMode = graph.ampSupported ? m : 'bypass'
      if (disposed || next === mode) return
      mode = next
      if (next === 'amp') handOver(ctx, bypassSend.gain, ampSend.gain)
      else handOver(ctx, ampSend.gain, bypassSend.gain)
      emit()
    },

    mode: () => mode,

    loadModel(src) {
      return guarded(async () => {
        const problem = checkModelText(src.name, src.text)
        if (problem) throw fail(problem)
        await ready
        const node = nam
        if (!node) throw fail('The amp engine is not running.')
        status = 'loading-model'
        emit()
        await duck()
        try {
          const info = await node.loadModel(src.text)
          current = summarizeModel(src.name, info, ctx.sampleRate)
          lastError = null
          return current
        } catch (err) {
          // The engine keeps the previous model when a load fails (it swaps
          // only after a successful parse), so the amp carries on as it was.
          throw fail(`Could not load ${src.name}: ${messageOf(err)}`, err)
        } finally {
          settle()
          openGate()
          emit()
        }
      })
    },

    setSlim(v) {
      if (!Number.isFinite(v)) return Promise.reject(new RangeError(`Slim size must be a number in [0, 1], got ${v}.`))
      return guarded(async () => {
        const node = nam
        if (!node || !current) throw new Error('Load a model first.')
        if (!current.slimmable) return
        status = 'loading-model'
        emit()
        await duck()
        try {
          await node.setSlimSize(Math.min(1, Math.max(0, v)))
        } catch (err) {
          throw fail(`Could not resize ${current.name}: ${messageOf(err)}`, err)
        } finally {
          settle()
          openGate()
          emit()
        }
      })
    },

    loadIr(src) {
      return guarded(async () => {
        let buffer: AudioBuffer
        try {
          // decodeAudioData detaches what it is given; the caller keeps its copy.
          buffer = await ctx.decodeAudioData(src.data.slice(0))
        } catch (err) {
          throw fail(`Could not read ${src.name} as audio: ${messageOf(err)}`, err)
        }
        const problem = checkIr(src.name, buffer.numberOfChannels, buffer.duration)
        if (problem) throw fail(problem)
        const next = ctx.createConvolver()
        next.normalize = true // set before the buffer: the scale is computed when the buffer is assigned
        next.buffer = buffer
        await duck()
        convolver?.disconnect()
        convolver = next
        wire()
        openGate()
        irInfo = { name: src.name, seconds: buffer.duration }
        lastError = null
        emit()
        return irInfo
      })
    },

    clearIr() {
      // Not behind the load lock: dropping a convolver does not stall audio.
      if (disposed) return
      void serial(async () => {
        if (disposed || !convolver) return
        await duck()
        convolver.disconnect()
        convolver = null
        wire()
        openGate()
        irInfo = null
        emit()
      })
    },

    setInputGainDb(db) { if (!disposed) rampTo(inputGain.gain, ctx, gainForDb(db)) },
    setOutputGainDb(db) { if (!disposed) rampTo(outputGain.gain, ctx, gainForDb(db)) },

    setLoadLock(on) { locked = on },
    busy: () => pending > 0,

    model: () => current,
    ir: () => irInfo,
    status: () => status,
    error: () => lastError,

    onChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      disconnectInput()
      rampTo(ampSend.gain, ctx, 0)
      rampTo(bypassSend.gain, ctx, 0)
      if (ctx.state === 'running') await sleep(RAMP * 1000 + 10)
      for (const node of [inputGain, ampGate, outputGain, ampSend, bypassSend, convolver]) node?.disconnect()
      // A node still being created is disposed by the attach code above.
      await ready.catch(() => {})
      const node = nam
      nam = null
      await node?.dispose().catch(() => {}) // nothing left to act on if the worklet is already gone
    },
  }
}
