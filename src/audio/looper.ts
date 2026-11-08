// ─── Looper ─────────────────────────────────────────────────────────
// One base loop plus one overdub, locked to the transport grid (SPEC
// "Transport and looper contract").
//
// The recorder worklet taps graph.guitarBus and nothing else (SPEC rule 2), so
// a take can never contain the click, the drone or the loop it was played
// over. Capture windows are absolute context frames; the main thread only
// arms them ahead of time and collects the chunks afterwards.
//
// Playback is AudioBufferSourceNodes on graph.loopBus started at grid frames.
// A take finishes `latency` frames AFTER the boundary it should loop from, so
// waiting for the whole take would lose a cycle. Instead each chunk is
// scheduled the moment it arrives, a full loop after the boundary it was
// played against (nearly a loop of lead time), and one looping source takes
// over from the boundary after that.

import { encodeWav } from '../export/wav'
import { zipStore } from '../export/zip'
import { APP_SLUG } from '../app-name'
import { rampTo, type Graph } from './graph'
import { boundaryFrame, frameTime, nextBoundaryIndex, type Transport } from './transport'

// ─── State machine (pure) ───

export type LooperMode =
  | 'idle'
  | 'count-in'
  | 'recording-base'
  | 'playing'
  | 'overdub-armed'
  | 'recording-overdub'
  | 'error'

export interface LooperState {
  mode: LooperMode
  hasBase: boolean
  hasOverdub: boolean
  error: string | null
}

export type LooperEvent =
  | { type: 'record' }
  | { type: 'take-started' }
  | { type: 'take-done' }
  | { type: 'overdub' }
  | { type: 'stop' }
  | { type: 'play' }
  | { type: 'undo' }
  | { type: 'clear' }
  | { type: 'fail'; message: string }

export const LOOPER_IDLE: LooperState = { mode: 'idle', hasBase: false, hasOverdub: false, error: null }

/**
 * Pure transitions. An event that is not valid in the current state returns
 * the SAME object, so callers can tell "ignored" from "applied" by identity.
 */
export function looperReducer(s: LooperState, e: LooperEvent): LooperState {
  switch (e.type) {
    case 'record':
      return s.mode === 'idle' && !s.hasBase ? { ...s, mode: 'count-in', error: null } : s
    case 'take-started':
      if (s.mode === 'count-in') return { ...s, mode: 'recording-base' }
      if (s.mode === 'overdub-armed') return { ...s, mode: 'recording-overdub' }
      return s
    case 'take-done':
      if (s.mode === 'recording-base') return { ...s, mode: 'playing', hasBase: true }
      if (s.mode === 'recording-overdub') return { ...s, mode: 'playing', hasOverdub: true }
      return s
    case 'overdub':
      // One overdub in M1: undo it before recording another.
      return s.mode === 'playing' && !s.hasOverdub ? { ...s, mode: 'overdub-armed' } : s
    case 'stop':
      if (s.mode === 'idle') return s
      // A base that never finished is no loop at all.
      if (s.mode === 'count-in' || s.mode === 'recording-base') return LOOPER_IDLE
      // A half-recorded overdub is discarded; the base survives.
      return { ...s, mode: 'idle', error: null }
    case 'play':
      return (s.mode === 'idle' || s.mode === 'error') && s.hasBase ? { ...s, mode: 'playing', error: null } : s
    case 'undo':
      if (s.mode === 'overdub-armed' || s.mode === 'recording-overdub') return { ...s, mode: 'playing' }
      if (s.hasOverdub && (s.mode === 'playing' || s.mode === 'idle')) return { ...s, hasOverdub: false }
      return s
    case 'clear':
      return s.mode === 'idle' && !s.hasBase && !s.hasOverdub && s.error === null ? s : LOOPER_IDLE
    case 'fail':
      return { ...s, mode: 'error', error: e.message }
  }
}

const BUSY: ReadonlySet<LooperMode> = new Set(['count-in', 'recording-base', 'overdub-armed', 'recording-overdub'])

// ─── Export (pure) ───

export interface TakeMeta {
  toneMode: 'amp' | 'bypass'
  modelName: string | null
  /** How the input reached the stereo files, e.g. "input channel 1 through the amp, mono on L and R". */
  channelLayout: string
}

export interface TakeInfo {
  bpm: number
  beatsPerBar: number
  bars: number
  sampleRate: number
  loopFrames: number
  latencyMs: number
  /** Only when the overdub was captured with a different offset than the base. */
  overdubLatencyMs: number | null
}

export interface ExportFile {
  name: string
  blob: Blob
}

/** Straight sum, no normalising: the WAV encoder clips anything past full scale. */
export function mixLayers(base: Float32Array[], overdub: Float32Array[] | null): Float32Array[] {
  return base.map((channel, c) => {
    const out = new Float32Array(channel)
    const add = overdub?.[c]
    if (add) for (let i = 0; i < out.length; i++) out[i] += add[i]
    return out
  })
}

const sameMeta = (a: TakeMeta, b: TakeMeta): boolean =>
  a.toneMode === b.toneMode && a.modelName === b.modelName && a.channelLayout === b.channelLayout

/**
 * `meta` describes the base. The tone can change between the base and the
 * overdub (Bypass while the loop plays, another model after Stop), so the
 * overdub carries its own block whenever it was recorded differently.
 */
export function buildTakeFiles(
  base: Float32Array[],
  overdub: Float32Array[] | null,
  info: TakeInfo,
  meta: TakeMeta,
  overdubMeta: TakeMeta | null = null,
): ExportFile[] {
  const wav = (channels: Float32Array[]): Blob =>
    new Blob([encodeWav(channels, info.sampleRate, 24)], { type: 'audio/wav' })
  const files: ExportFile[] = [{ name: 'base.wav', blob: wav(base) }]
  if (overdub) files.push({ name: 'overdub.wav', blob: wav(overdub) })
  files.push({ name: 'mix.wav', blob: wav(mixLayers(base, overdub)) })
  const take = {
    format: `${APP_SLUG} take`,
    version: 1,
    bpm: info.bpm,
    beatsPerBar: info.beatsPerBar,
    bars: info.bars,
    sampleRate: info.sampleRate,
    loopFrames: info.loopFrames,
    latencyMs: info.latencyMs,
    ...(info.overdubLatencyMs !== null && info.overdubLatencyMs !== info.latencyMs
      ? { overdubLatencyMs: info.overdubLatencyMs } : {}),
    bitDepth: 24,
    channels: base.length,
    channelLayout: meta.channelLayout,
    toneMode: meta.toneMode,
    modelName: meta.modelName,
    ...(overdub && overdubMeta && !sameMeta(meta, overdubMeta)
      ? { overdub: { toneMode: overdubMeta.toneMode, modelName: overdubMeta.modelName, channelLayout: overdubMeta.channelLayout } }
      : {}),
    files: files.map((f) => f.name), // the audio; this file describes them
  }
  files.push({ name: 'take.json', blob: new Blob([JSON.stringify(take, null, 2) + '\n'], { type: 'application/json' }) })
  return files
}

/**
 * `homekey-take-2026-11-08-1930-120bpm.zip`, APP_SLUG first: the local date
 * and time of the export and the loop's tempo. The time keeps two takes
 * exported the same day at the same tempo from becoming "(1)" copies of one name.
 */
export function takeArchiveName(when: Date, bpm: number): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}`
  return `${APP_SLUG}-take-${stamp}-${Number(bpm.toFixed(2))}bpm.zip`
}

/** The take's files as one download: a store-only zip, so every byte goes in unchanged. */
export async function packTake(files: readonly ExportFile[], bpm: number, when: Date): Promise<ExportFile> {
  const entries = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })))
  return { name: takeArchiveName(when, bpm), blob: new Blob([zipStore(entries, when)], { type: 'application/zip' }) }
}

// ─── Latency ───

export const LATENCY_MAX_MS = 300

export function clampLatencyMs(ms: number): number {
  return Number.isFinite(ms) ? Math.min(LATENCY_MAX_MS, Math.max(0, Math.round(ms))) : 0
}

/** SPEC default: what the context reports for output, plus 10 ms for the input side it can't see. */
export function defaultLatencyMs(ctx: { outputLatency?: number; baseLatency?: number }): number {
  const out = Number.isFinite(ctx.outputLatency) ? (ctx.outputLatency as number) : 0
  const base = Number.isFinite(ctx.baseLatency) ? (ctx.baseLatency as number) : 0
  return clampLatencyMs(Math.round((out + base) * 1000) + 10)
}

// ─── Looper ───

export interface LooperOptions {
  recorderUrl?: string
}

export interface LooperSnapshot {
  state: LooperMode
  hasBase: boolean
  hasOverdub: boolean
  loopFrames: number
  /** 0..1 through the current loop cycle, for the UI; 0 when stopped or counting in. */
  position: number
  latencyMs: number
  /** bpm and bars can't change (a loop exists or is being recorded). */
  locked: boolean
  error: string | null
}

export interface Looper {
  /** (Re)starts the transport: count-in, then the base take. */
  record(): void
  /** Arms the overdub for the next full cycle. */
  overdub(): void
  stop(): void
  /** Restarts the transport with a count-in and plays the loop from its origin. */
  play(): void
  /** Removes the overdub, or cancels one that is armed or recording. */
  undo(): void
  /** Stops and deletes everything; unlocks bpm and bars. */
  clear(): void
  setLatencyMs(ms: number): void
  latencyMs(): number
  /** Counting in or recording: the UI must not load a model or IR now (SPEC rule 6). */
  isBusy(): boolean
  snapshot(): LooperSnapshot
  /** Called on every state, latency or error change (poll snapshot() for position). */
  subscribe(cb: (s: LooperSnapshot) => void): () => void
  /** `meta` describes the base; `overdubMeta` the overdub, when there is one. */
  exportFiles(meta: TakeMeta, overdubMeta?: TakeMeta | null): Promise<ExportFile[]>
  /** The same files in one zip, named for `when` and the loop's tempo: what Export downloads. */
  exportArchive(meta: TakeMeta, overdubMeta?: TakeMeta | null, when?: Date): Promise<ExportFile>
  dispose(): void
}

const TICK_MS = 20
// The least lead a source start or an arm is given; anything closer is
// treated as missed rather than risked landing off the grid.
const LEAD_S = 0.03
const FADE_S = 0.015

interface Layer {
  buffer: AudioBuffer // loopFrames x 2, filled chunk by chunk
  received: number
  latencyMs: number
  out: GainNode // per-layer fade, so undo and stop never click
  sources: Set<AudioBufferSourceNode>
}

interface Take {
  id: number
  role: 'base' | 'overdub'
  /** The downbeat this take belongs to; capture starts latencyFrames later. */
  boundary: number
  layer: Layer
  started: boolean
}

interface LoopParams { bpm: number; beatsPerBar: number; bars: number }

type RecorderMessage =
  | { type: 'chunk'; id: number; offset: number; channels: [Float32Array, Float32Array] }
  | { type: 'done'; id: number; startFrame: number; frames: number; discontinuous: boolean }
  | { type: 'late'; id: number; currentFrame: number }

export async function createLooper(graph: Graph, transport: Transport, options: LooperOptions = {}): Promise<Looper> {
  const { ctx } = graph
  const sr = ctx.sampleRate
  await ctx.audioWorklet.addModule(options.recorderUrl ?? '/worklets/recorder.js')
  const recorder = new AudioWorkletNode(ctx, 'rig-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  })
  graph.guitarBus.connect(recorder)
  // A zero gain into the destination keeps the recorder pulled every quantum
  // without it ever being heard.
  const sink = ctx.createGain()
  sink.gain.value = 0
  recorder.connect(sink).connect(ctx.destination)

  let state = LOOPER_IDLE
  let latency = defaultLatencyMs(ctx)
  let lf = 0 // loop length, fixed from record() until clear()
  let loopParams: LoopParams | null = null
  let base: Layer | null = null
  let over: Layer | null = null
  let take: Take | null = null
  let nextId = 1
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false
  const listeners = new Set<(s: LooperSnapshot) => void>()
  const lead = Math.round(LEAD_S * sr)
  const latencyFrames = (): number => Math.round(latency * sr / 1000)

  // ─── Notifications ───

  function snapshot(): LooperSnapshot {
    const origin = transport.origin()
    const hasLoop = base !== null || take !== null
    const len = hasLoop ? lf : transport.params().loopFrames
    const now = transport.framesNow()
    const position = origin !== null && now >= origin ? ((now - origin) % len) / len : 0
    return {
      state: state.mode, hasBase: state.hasBase, hasOverdub: state.hasOverdub,
      loopFrames: len, position, latencyMs: latency, locked: transport.locked(), error: state.error,
    }
  }

  function notify(): void {
    const snap = snapshot()
    for (const cb of listeners) cb(snap)
  }

  function dispatch(e: LooperEvent): void {
    const next = looperReducer(state, e)
    if (next === state) return
    state = next
    if (BUSY.has(state.mode) || state.mode === 'playing') startTick()
    else stopTick()
    notify()
  }

  // ─── Sources ───

  function newLayer(): Layer {
    const out = ctx.createGain()
    out.connect(graph.loopBus)
    return { buffer: ctx.createBuffer(2, lf, sr), received: 0, latencyMs: latency, out, sources: new Set() }
  }

  // The buffer is exactly loopFrames long, so loop = true with loopStart and
  // loopEnd left at 0 loops the whole buffer. Setting loopEnd = loopFrames / sr
  // would make the browser turn seconds back into a (possibly fractional) frame.
  function startSource(layer: Layer, buffer: AudioBuffer, frame: number, loop: boolean): void {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = loop
    src.connect(layer.out)
    src.onended = () => {
      layer.sources.delete(src)
      src.disconnect()
    }
    layer.sources.add(src)
    src.start(frameTime(frame, sr))
  }

  /** Fade the layer out and stop its sources; `keep` gives it a fresh output for a later play(). */
  function fade(layer: Layer, keep: boolean): void {
    const now = ctx.currentTime
    const old = layer.out
    rampTo(old.gain, ctx, 0, FADE_S)
    for (const src of layer.sources) {
      try { src.stop(now + FADE_S) } catch { /* never started */ }
    }
    layer.sources = new Set()
    setTimeout(() => old.disconnect(), FADE_S * 1000 + 100)
    if (keep) {
      layer.out = ctx.createGain()
      layer.out.connect(graph.loopBus)
    }
  }

  const layers = (): Layer[] => [base, over].filter((l): l is Layer => l !== null)

  // ─── Takes ───

  function arm(role: Take['role'], boundary: number): void {
    const id = nextId++
    take = { id, role, boundary, layer: newLayer(), started: false }
    recorder.port.postMessage({ type: 'arm', id, startFrame: boundary + latencyFrames(), frames: lf })
  }

  function cancelTake(): void {
    if (take === null) return
    recorder.port.postMessage({ type: 'cancel', id: take.id })
    fade(take.layer, false)
    take = null
  }

  /**
   * The overdub's cycle is the first downbeat not yet rendered whose window can
   * still be armed. `seen` is a frame the worklet already reported, because the
   * main thread's clock can lag the audio thread's.
   */
  function armOverdub(seen = 0): boolean {
    const origin = transport.origin()
    if (origin === null) {
      fail('The transport stopped.')
      return false
    }
    const now = Math.max(transport.framesNow(), seen)
    const k = nextBoundaryIndex(origin, lf, Math.max(now, now + lead - latencyFrames()))
    arm('overdub', boundaryFrame(origin, lf, k))
    return true
  }

  function onChunk(t: Take, offset: number, channels: [Float32Array, Float32Array]): void {
    const n = channels[0].length
    t.layer.buffer.copyToChannel(channels[0], 0, offset)
    t.layer.buffer.copyToChannel(channels[1], 1, offset)
    t.layer.received = offset + n
    // First pass: this chunk plays one loop after the boundary it was played
    // against. Too late to land on the grid means a hole, never an off-grid start.
    const frame = boundaryFrame(t.boundary, lf, 1) + offset
    if (frame < transport.framesNow() + lead) return
    const segment = ctx.createBuffer(2, n, sr)
    segment.copyToChannel(channels[0], 0)
    segment.copyToChannel(channels[1], 1)
    startSource(t.layer, segment, frame, false)
  }

  function onDone(t: Take, discontinuous: boolean): void {
    if (discontinuous || t.layer.received !== lf) {
      fail('Audio dropped out during the take, so it was discarded. Try again.')
      return
    }
    const origin = transport.origin()
    if (origin === null) {
      fail('The transport stopped.')
      return
    }
    take = null
    if (t.role === 'base') base = t.layer
    else over = t.layer
    // From the second pass on, one looping source, aligned with the base.
    const from = Math.max(boundaryFrame(t.boundary, lf, 2), transport.framesNow() + lead)
    startSource(t.layer, t.layer.buffer, boundaryFrame(origin, lf, nextBoundaryIndex(origin, lf, from)), true)
    dispatch({ type: 'take-done' })
  }

  function onLate(t: Take, currentFrame: number): void {
    if (t.role === 'base') {
      fail('Recording could not start in time. Try again.')
      return
    }
    // The main thread was too slow to arm this cycle: take the next one.
    fade(t.layer, false)
    take = null
    armOverdub(currentFrame)
  }

  recorder.port.onmessage = (e: MessageEvent<RecorderMessage>) => {
    const msg = e.data
    const t = take
    if (t === null || msg.id !== t.id) return // leftovers of a cancelled take
    if (msg.type === 'chunk') onChunk(t, msg.offset, msg.channels)
    else if (msg.type === 'done') onDone(t, msg.discontinuous)
    else if (msg.type === 'late') onLate(t, msg.currentFrame)
  }

  recorder.onprocessorerror = () => fail('The recorder stopped working. Reload the page to record again.')

  // A suspended or interrupted context freezes its clock, so the worklet's
  // frame count stays contiguous while the input it should have captured is
  // lost: the take comes out spliced and `discontinuous` never fires (measured
  // 2026-11-08, Chromium 153: 1 s suspended mid-take, 0.95 s of input missing
  // at one splice, take accepted). Nothing on the grid can be trusted across
  // it, so a take in flight is dropped; a loop that is only playing resumes in
  // step, because everything it scheduled is on the same frozen clock.
  const onContextState = (): void => {
    if (ctx.state !== 'running' && BUSY.has(state.mode)) {
      fail('Audio was interrupted during the take, so it was discarded. Try again.')
    }
  }
  ctx.addEventListener('statechange', onContextState)

  function fail(message: string): void {
    cancelTake()
    for (const layer of layers()) fade(layer, true)
    transport.stop()
    if (base === null) transport.lock(false)
    dispatch({ type: 'fail', message })
  }

  // ─── Tick: UI transitions on the grid, and the clock under our feet ───

  function tick(): void {
    if (!transport.running()) {
      // Someone stopped the transport directly; the loop must not play on without its clock.
      api.stop()
      return
    }
    if (take !== null && !take.started && transport.framesNow() >= take.boundary) {
      take.started = true
      dispatch({ type: 'take-started' })
    }
  }

  function startTick(): void {
    if (timer === null) timer = setInterval(tick, TICK_MS)
  }

  function stopTick(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  // ─── API ───

  const api: Looper = {
    record() {
      if (looperReducer(state, { type: 'record' }) === state) return
      if (transport.running()) transport.stop()
      const p = transport.params()
      lf = p.loopFrames
      loopParams = { bpm: p.bpm, beatsPerBar: p.beatsPerBar, bars: p.bars }
      transport.lock(true)
      arm('base', transport.start())
      dispatch({ type: 'record' })
    },
    overdub() {
      if (looperReducer(state, { type: 'overdub' }) === state) return
      if (armOverdub()) dispatch({ type: 'overdub' })
    },
    stop() {
      if (looperReducer(state, { type: 'stop' }) === state) return
      cancelTake()
      for (const layer of layers()) fade(layer, true)
      transport.stop()
      if (base === null) transport.lock(false)
      dispatch({ type: 'stop' })
    },
    play() {
      if (looperReducer(state, { type: 'play' }) === state || base === null) return
      if (transport.running()) transport.stop()
      const origin = transport.start()
      for (const layer of layers()) startSource(layer, layer.buffer, origin, true)
      dispatch({ type: 'play' })
    },
    undo() {
      if (looperReducer(state, { type: 'undo' }) === state) return
      if (take?.role === 'overdub') cancelTake()
      if (over !== null) fade(over, false)
      over = null
      dispatch({ type: 'undo' })
    },
    clear() {
      cancelTake()
      for (const layer of layers()) fade(layer, false)
      base = null
      over = null
      loopParams = null
      transport.stop()
      transport.lock(false)
      dispatch({ type: 'clear' })
    },
    setLatencyMs(ms) {
      latency = clampLatencyMs(ms)
      notify()
    },
    latencyMs: () => latency,
    isBusy: () => BUSY.has(state.mode),
    snapshot,
    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    async exportFiles(meta, overdubMeta = null) {
      if (base === null || loopParams === null) throw new Error('Nothing to export yet: record a loop first.')
      const channels = (l: Layer): Float32Array[] => [l.buffer.getChannelData(0), l.buffer.getChannelData(1)]
      return buildTakeFiles(channels(base), over ? channels(over) : null, {
        ...loopParams, sampleRate: sr, loopFrames: lf,
        latencyMs: base.latencyMs, overdubLatencyMs: over ? over.latencyMs : null,
      }, meta, over ? overdubMeta : null)
    },
    async exportArchive(meta, overdubMeta = null, when = new Date()) {
      const bpm = loopParams?.bpm ?? 0 // read before the await; exportFiles throws first when there is no loop
      return packTake(await api.exportFiles(meta, overdubMeta), bpm, when)
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopTick()
      const active = state.mode !== 'idle' && state.mode !== 'error'
      cancelTake()
      for (const layer of layers()) fade(layer, false)
      base = null
      over = null
      if (active) transport.stop()
      transport.lock(false)
      ctx.removeEventListener('statechange', onContextState)
      recorder.port.onmessage = null
      recorder.onprocessorerror = null
      recorder.disconnect()
      sink.disconnect()
      graph.guitarBus.disconnect(recorder)
      listeners.clear()
    },
  }
  return api
}
