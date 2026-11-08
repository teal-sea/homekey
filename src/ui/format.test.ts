import { describe, expect, it } from 'vitest'
import {
  acceptedSummary, audioStatus, formatCents, formatDb, formatMs, latencyExplanation, meterFill, modelLines,
  processingWarning, sampleRateWarning, SILENT_DB, toDb,
} from './format'
import type { ModelSummary } from '../audio/tone'

describe('levels', () => {
  it('converts amplitude to dBFS with a floor for silence', () => {
    expect(toDb(1)).toBe(0)
    expect(toDb(0.5)).toBeCloseTo(-6.02, 2)
    expect(toDb(0)).toBe(SILENT_DB)
    expect(toDb(Number.NaN)).toBe(SILENT_DB)
    expect(toDb(1e-9)).toBe(SILENT_DB)
  })

  it('fills the meter from -60 dB to 0 dB', () => {
    expect(meterFill(-90)).toBe(0)
    expect(meterFill(-60)).toBe(0)
    expect(meterFill(-30)).toBeCloseTo(0.5)
    expect(meterFill(0)).toBe(1)
    expect(meterFill(6)).toBe(1)
  })

  it('formats dB, ms and cents', () => {
    expect(formatDb(-6.02)).toBe('-6.0 dB')
    expect(formatDb(3)).toBe('+3.0 dB')
    expect(formatDb(SILENT_DB)).toBe('-∞ dB')
    expect(formatMs(0.0213)).toBe('21 ms')
    expect(formatMs(undefined)).toBe('not reported')
    expect(formatCents(12.4)).toBe('+12 cents')
    expect(formatCents(-7.6)).toBe('−8 cents')
    expect(formatCents(0.3)).toBe('±0 cents')
  })
})

describe('audioStatus', () => {
  it('lists rate, quantum and latencies, and says when audio is not running', () => {
    const running = audioStatus({ sampleRate: 48000, renderQuantum: 128, outputLatency: 0.012, baseLatency: 0.0053, state: 'running' })
    expect(running).toBe('48000 Hz · render quantum 128 · output latency 12 ms · base latency 5 ms')
    const suspended = audioStatus({ sampleRate: 44100, renderQuantum: 256, state: 'suspended' })
    expect(suspended).toContain('render quantum 256')
    expect(suspended).toContain('output latency not reported')
    expect(suspended).toContain('audio suspended')
  })
})

describe('input readouts', () => {
  it('reads back what the browser accepted', () => {
    const lines = acceptedSummary({ channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false })
    expect(lines).toEqual([
      'Channels: 2', 'Sample rate: 48000 Hz', 'Echo cancellation: off', 'Noise suppression: off', 'Auto gain: not reported',
    ])
  })

  it('warns only about processing that stayed on', () => {
    expect(processingWarning({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })).toBeNull()
    expect(processingWarning({})).toBeNull()
    const w = processingWarning({ echoCancellation: true, autoGainControl: true })
    expect(w).toContain('echo cancellation, auto gain')
    expect(w).not.toContain('noise')
  })

  it('warns when the input and engine rates differ', () => {
    expect(sampleRateWarning({ sampleRate: 48000 }, 48000)).toBeNull()
    expect(sampleRateWarning({}, 48000)).toBeNull()
    expect(sampleRateWarning({ sampleRate: 48000 }, 44100)).toContain('48000 Hz')
  })
})

describe('modelLines', () => {
  const model = (over: Partial<ModelSummary>): ModelSummary => ({
    name: 'plexi.nam', expectedSampleRate: 48000, contextSampleRate: 48000, sampleRateMismatch: false,
    slimmable: false, slimmableBreakpoints: [], loudnessDb: null, ...over,
  })

  it('names the model and its training rate', () => {
    expect(modelLines(model({}))).toEqual({ summary: 'plexi.nam (trained at 48000 Hz)', warning: null })
    expect(modelLines(model({ expectedSampleRate: -1 })).summary).toBe('plexi.nam (training rate not stated)')
    expect(modelLines(model({ slimmable: true })).summary).toContain('resizable')
  })

  it('warns when the model was trained at another rate', () => {
    const { warning } = modelLines(model({ contextSampleRate: 44100, sampleRateMismatch: true }))
    expect(warning).toContain('48000 Hz')
    expect(warning).toContain('44100 Hz')
  })
})

describe('latencyExplanation', () => {
  it('shows the sum the default came from', () => {
    const text = latencyExplanation(0.02, 0.005, 35)
    expect(text).toContain('Default 35 ms')
    expect(text).toContain('output latency 20 ms')
    expect(text).toContain('base latency 5 ms')
    expect(text).toContain('+ 10 ms')
  })
})
