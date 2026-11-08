// ─── Note follower ──────────────────────────────────────────────────
// Adapted from ModalRuns (same author): the ~20×/s readPitch poll and its
// commit rule in src/App.tsx. Polls an analyser on the pre-amp mono input
// (SPEC rule 3: amp distortion and effects never reach it) and reports the
// note the player is holding, so the fretboard can light it.
//
// The analyser hangs off the input node only and connects nowhere, so loop
// playback, drone and click cannot reach it through the graph (SPEC rule 2).
// Browsers pull an analyser with no outputs on their own.

import type { Graph } from './graph'
import { BASE_RMS_GATE, detectPitch, type PitchResult } from './pitch'

export interface HeardNote { midi: number; cents: number; freq: number; clarity: number }

export interface NoteFollower {
  /** Fires when the committed NOTE changes (or clears to null), not on every poll. */
  onNote(cb: (n: HeardNote | null) => void): () => void
  /** The committed note with its latest confirmed reading (cents refresh while held). */
  current(): HeardNote | null
  stop(): void
}

// ~93 ms at 44.1 kHz: a long enough window for a bass low E's period to repeat.
const FFT_SIZE = 4096
const POLL_MS = 50
// ~500 ms of empty reads at the 50 ms poll. Kills strobing between notes and
// gives a fast-decaying high string the hang time a sustained bass note gets
// for free.
const CLEAR_AFTER_EMPTY = 10

// ─── Commit rule (pure) ───
// A note must be read twice in a row to commit (kills flicker from pick
// transients); it clears after CLEAR_AFTER_EMPTY empty reads in a row. An
// empty read in between breaks the pair, exactly as in ModalRuns.

export interface Committer {
  /** Feed one poll's reading. Returns true when the committed note changed. */
  push(reading: PitchResult | null): boolean
  current(): HeardNote | null
  reset(): void
}

export function createCommitter(): Committer {
  let lastRaw: number | null = null
  let emptyReads = 0
  let committed: HeardNote | null = null

  return {
    push(reading) {
      if (reading === null) {
        lastRaw = null
        emptyReads++
        if (emptyReads < CLEAR_AFTER_EMPTY || committed === null) return false
        committed = null
        return true
      }
      emptyReads = 0
      const confirmed = reading.midi === lastRaw
      lastRaw = reading.midi
      if (!confirmed) return false
      const changed = committed?.midi !== reading.midi
      const { midi, cents, freq, clarity } = reading
      committed = { midi, cents, freq, clarity }
      return changed
    },
    current: () => committed,
    reset() {
      lastRaw = null
      emptyReads = 0
      committed = null
    },
  }
}

// ─── Follower ───

export function createNoteFollower(
  graph: Graph,
  input: AudioNode,
  opts: { intervalMs?: number; gateRms?: number } = {},
): NoteFollower {
  const intervalMs = opts.intervalMs ?? POLL_MS
  const gateRms = opts.gateRms ?? BASE_RMS_GATE
  if (!(intervalMs > 0)) throw new RangeError(`intervalMs must be positive, got ${intervalMs}`)
  if (!(gateRms >= 0)) throw new RangeError(`gateRms must be non-negative, got ${gateRms}`)

  const { ctx } = graph
  const analyser = ctx.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = 0
  input.connect(analyser)

  const buf = new Float32Array(FFT_SIZE)
  const committer = createCommitter()
  const listeners = new Set<(n: HeardNote | null) => void>()
  let stopped = false

  const emit = (n: HeardNote | null): void => {
    for (const cb of [...listeners]) cb(n)
  }

  const read = (): PitchResult | null => {
    // A suspended or closed context keeps handing back its last buffer, which
    // would hold a note lit forever. Not running means nothing is heard.
    if (ctx.state !== 'running') return null
    analyser.getFloatTimeDomainData(buf)
    return detectPitch(buf, ctx.sampleRate, gateRms)
  }

  const timer = setInterval(() => {
    if (committer.push(read())) emit(committer.current())
  }, intervalMs)

  return {
    onNote(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    current: () => committer.current(),
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try { input.disconnect(analyser) } catch { /* input already torn down */ }
      // Last word is "nothing heard", so no display is left showing a stale note.
      const had = committer.current() !== null
      committer.reset()
      if (had) emit(null)
      listeners.clear()
    },
  }
}
