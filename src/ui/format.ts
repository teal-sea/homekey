// ─── Readouts ───────────────────────────────────────────────────────
// The words and numbers the page shows, as pure functions so they can be
// tested without a browser. Plain words over jargon: the reader is holding a
// guitar, not a manual.

import type { AcceptedSettings } from '../audio/input'
import type { ModelSummary } from '../audio/tone'
import type { LooperMode } from '../audio/looper'

export const SILENT_DB = -90

/** Linear amplitude to dBFS, floored so silence reads as a number, not -Infinity. */
export function toDb(amplitude: number): number {
  if (!(amplitude > 0)) return SILENT_DB
  return Math.max(SILENT_DB, 20 * Math.log10(amplitude))
}

/** A meter's 0..1 fill for a dBFS value: -60 dB and below is empty, 0 dB is full. */
export function meterFill(db: number, floorDb = -60): number {
  if (!(db > floorDb)) return 0
  return Math.min(1, (db - floorDb) / -floorDb)
}

export function formatDb(db: number, digits = 1): string {
  if (db <= SILENT_DB) return '-∞ dB'
  const sign = db > 0 ? '+' : ''
  return `${sign}${db.toFixed(digits)} dB`
}

export function formatMs(seconds: number | undefined): string {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? `${Math.round(seconds * 1000)} ms` : 'not reported'
}

export function formatCents(cents: number): string {
  const c = Math.round(cents)
  return c === 0 ? '±0 cents' : `${c > 0 ? '+' : '−'}${Math.abs(c)} cents`
}

export interface ContextFacts {
  sampleRate: number
  renderQuantum: number
  outputLatency?: number
  baseLatency?: number
  state: string
}

/** The one-line audio status under the Start button. */
export function audioStatus(f: ContextFacts): string {
  const parts = [
    `${f.sampleRate} Hz`,
    `render quantum ${f.renderQuantum}`,
    `output latency ${formatMs(f.outputLatency)}`,
    `base latency ${formatMs(f.baseLatency)}`,
  ]
  if (f.state !== 'running') parts.push(`audio ${f.state}`)
  return parts.join(' · ')
}

const onOff = (v: boolean | undefined): string => v === undefined ? 'not reported' : v ? 'ON' : 'off'

/** What the browser accepted for the input, as a short list of facts. */
export function acceptedSummary(s: AcceptedSettings): string[] {
  return [
    `Channels: ${s.channelCount ?? 'not reported'}`,
    `Sample rate: ${s.sampleRate ? `${s.sampleRate} Hz` : 'not reported'}`,
    `Echo cancellation: ${onOff(s.echoCancellation)}`,
    `Noise suppression: ${onOff(s.noiseSuppression)}`,
    `Auto gain: ${onOff(s.autoGainControl)}`,
  ]
}

/** Browser voice processing still on despite the request: it changes the guitar, so say so. */
export function processingWarning(s: AcceptedSettings): string | null {
  const on = [
    s.echoCancellation && 'echo cancellation',
    s.noiseSuppression && 'noise suppression',
    s.autoGainControl && 'auto gain',
  ].filter((x): x is string => typeof x === 'string')
  if (on.length === 0) return null
  return `The browser kept ${on.join(', ')} on. It can thin out sustain and squash dynamics; ` +
    'a different browser or input may let it turn off.'
}

export function sampleRateWarning(input: AcceptedSettings, contextRate: number): string | null {
  if (!input.sampleRate || input.sampleRate === contextRate) return null
  return `The input runs at ${input.sampleRate} Hz and the audio engine at ${contextRate} Hz, so the browser resamples it.`
}

/** "Model: Plexi (trained at 48000 Hz)" plus a warning when the rates differ. */
export function modelLines(m: ModelSummary): { summary: string; warning: string | null } {
  const trained = m.expectedSampleRate > 0 ? `trained at ${m.expectedSampleRate} Hz` : 'training rate not stated'
  const summary = `${m.name} (${trained}${m.slimmable ? ', resizable' : ''})`
  const warning = m.sampleRateMismatch
    ? `This model was trained at ${m.expectedSampleRate} Hz but the audio runs at ${m.contextSampleRate} Hz. ` +
      'It plays without resampling, so it will not sound exactly as captured. ' +
      `Set your interface and system to ${m.expectedSampleRate} Hz and reload for the true sound.`
    : null
  return { summary, warning }
}

export const LOOPER_LABELS: Readonly<Record<LooperMode, string>> = {
  'idle': 'Stopped',
  'count-in': 'Count-in',
  'recording-base': 'Recording',
  'playing': 'Playing',
  'overdub-armed': 'Overdub armed',
  'recording-overdub': 'Overdubbing',
  'error': 'Error',
}

/** Explains the default latency offset in the numbers this machine reported. */
export function latencyExplanation(outputLatency: number | undefined, baseLatency: number | undefined, defaultMs: number): string {
  return `Default ${defaultMs} ms = output latency ${formatMs(outputLatency)} + base latency ${formatMs(baseLatency)} ` +
    '+ 10 ms for the input side the browser cannot measure. ' +
    'If your overdubs land late against the loop, raise it; early, lower it.'
}
