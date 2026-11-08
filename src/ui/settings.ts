// ─── Settings ───────────────────────────────────────────────────────
// What the page remembers between visits: choices, never audio (SPEC rule 10).
// One localStorage key, read and written inside try/catch, because storage can
// be missing (private windows, blocked site data) and the rig must still start.
//
// Monitoring and panic are deliberately NOT here: monitoring starts off on
// every load (SPEC rule 4), and a page that reopened muted would look broken.

import { isScaleKey, type ScaleKey } from '../theory/scales'
import type { ToneMode } from '../audio/tone'
import { BPM_MAX, BPM_MIN } from '../audio/transport'
import { clampLatencyMs } from '../audio/looper'
import { APP_SLUG } from '../app-name'

export const SETTINGS_KEY = `${APP_SLUG}.settings.v1`

export const BAR_CHOICES = [1, 2, 4] as const
export type Bars = typeof BAR_CHOICES[number]

export const GAIN_MIN_DB = -24
export const GAIN_MAX_DB = 24
export const LEVEL_MIN_DB = -40
export const LEVEL_MAX_DB = 12

export interface Settings {
  /** The input last chosen; null is "System default", an explicit choice of its own. */
  deviceId: string | null
  /** 0-based input channel the guitar is on. */
  channel: number
  toneMode: ToneMode
  inputGainDb: number
  outputGainDb: number
  rootPc: number
  scaleKey: ScaleKey
  showNames: boolean
  droneLevel: number
  bpm: number
  bars: Bars
  clickOn: boolean
  clickLevel: number
  /** null = the automatic default from the context's reported latency. */
  latencyMs: number | null
}

// A minor and its relative C major are home for this player; 90 bpm sits
// where a slow blues and a space-rock groove both live.
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  deviceId: null,
  channel: 0,
  toneMode: 'amp',
  inputGainDb: 0,
  outputGainDb: 0,
  rootPc: 9,
  scaleKey: 'aeolian',
  showNames: false,
  droneLevel: 0.5,
  bpm: 90,
  bars: 2,
  clickOn: true,
  clickLevel: 0.7,
  latencyMs: null,
}

// ─── Parsing (pure) ───
// Every field is checked on its own, so one bad value (an older version, a
// hand edit) costs that field, not the whole set.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

const int = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback

const bool = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback

const str = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null

export function parseSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS
  if (!isRecord(raw)) return { ...d }
  const bars = BAR_CHOICES.find(b => b === raw.bars) ?? d.bars
  return {
    deviceId: str(raw.deviceId),
    channel: int(raw.channel, 0, 1, d.channel),
    toneMode: raw.toneMode === 'amp' || raw.toneMode === 'bypass' ? raw.toneMode : d.toneMode,
    inputGainDb: num(raw.inputGainDb, GAIN_MIN_DB, GAIN_MAX_DB, d.inputGainDb),
    outputGainDb: num(raw.outputGainDb, LEVEL_MIN_DB, LEVEL_MAX_DB, d.outputGainDb),
    rootPc: int(raw.rootPc, 0, 11, d.rootPc),
    scaleKey: isScaleKey(raw.scaleKey) ? raw.scaleKey : d.scaleKey,
    showNames: bool(raw.showNames, d.showNames),
    droneLevel: num(raw.droneLevel, 0, 1, d.droneLevel),
    bpm: num(raw.bpm, BPM_MIN, BPM_MAX, d.bpm),
    bars,
    clickOn: bool(raw.clickOn, d.clickOn),
    clickLevel: num(raw.clickLevel, 0, 1, d.clickLevel),
    latencyMs: typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs) ? clampLatencyMs(raw.latencyMs) : null,
  }
}

// ─── Storage ───

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** The browser's localStorage, or null where touching it throws. */
export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function loadSettings(storage: StorageLike | null): Settings {
  try {
    const text = storage?.getItem(SETTINGS_KEY)
    return parseSettings(text ? JSON.parse(text) : null)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** False when the browser refused (quota, blocked storage); the page carries on either way. */
export function saveSettings(storage: StorageLike | null, settings: Settings): boolean {
  try {
    if (!storage) return false
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}
