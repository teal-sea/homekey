import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings, SETTINGS_KEY } from './settings'

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
  }
}

describe('parseSettings', () => {
  it('gives the defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS)
  })

  it('defaults to A natural minor, amp mode, monitoring nowhere in sight', () => {
    expect(DEFAULT_SETTINGS.rootPc).toBe(9)
    expect(DEFAULT_SETTINGS.scaleKey).toBe('aeolian')
    expect(DEFAULT_SETTINGS.toneMode).toBe('amp')
    expect('monitoring' in DEFAULT_SETTINGS).toBe(false)
  })

  it('keeps every valid field', () => {
    const s = {
      deviceId: 'abc', channel: 1, toneMode: 'bypass', inputGainDb: 6, outputGainDb: -12,
      rootPc: 0, scaleKey: 'lydian', showNames: true, droneLevel: 0.25, bpm: 120, bars: 4,
      clickOn: false, clickLevel: 0.3, latencyMs: 42,
    }
    expect(parseSettings(s)).toEqual(s)
  })

  it('drops fields it does not know, such as the deviceLabel an earlier build stored', () => {
    expect(parseSettings({ deviceId: 'abc', deviceLabel: 'Interface' })).not.toHaveProperty('deviceLabel')
  })

  it('drops one bad field without losing the rest', () => {
    const s = parseSettings({ rootPc: 12, scaleKey: 'klingon', bpm: 120, bars: 3, channel: 2, toneMode: 'loud' })
    expect(s.rootPc).toBe(DEFAULT_SETTINGS.rootPc)
    expect(s.scaleKey).toBe(DEFAULT_SETTINGS.scaleKey)
    expect(s.bars).toBe(DEFAULT_SETTINGS.bars)
    expect(s.channel).toBe(0)
    expect(s.toneMode).toBe('amp')
    expect(s.bpm).toBe(120)
  })

  it('clamps numbers into range and refuses non-finite ones', () => {
    const s = parseSettings({ bpm: 1000, inputGainDb: -99, droneLevel: 7, clickLevel: Number.NaN, latencyMs: 999 })
    expect(s.bpm).toBe(300)
    expect(s.inputGainDb).toBe(-24)
    expect(s.droneLevel).toBe(1)
    expect(s.clickLevel).toBe(DEFAULT_SETTINGS.clickLevel)
    expect(s.latencyMs).toBe(300)
  })

  it('treats a missing or blank device as the system default', () => {
    expect(parseSettings({ deviceId: '' }).deviceId).toBeNull()
    expect(parseSettings({}).deviceId).toBeNull()
    expect(parseSettings({ latencyMs: null }).latencyMs).toBeNull()
  })
})

describe('storage', () => {
  it('round-trips through one key', () => {
    const store = memory()
    const s = { ...DEFAULT_SETTINGS, bpm: 72, scaleKey: 'dorian' as const }
    expect(saveSettings(store, s)).toBe(true)
    expect([...store.data.keys()]).toEqual([SETTINGS_KEY])
    expect(loadSettings(store)).toEqual(s)
  })

  it('survives broken JSON, a throwing store and no store at all', () => {
    expect(loadSettings(memory({ [SETTINGS_KEY]: '{oops' }))).toEqual(DEFAULT_SETTINGS)
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS)
    expect(saveSettings(throwing, DEFAULT_SETTINGS)).toBe(false)
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(saveSettings(null, DEFAULT_SETTINGS)).toBe(false)
  })

  it('returns a fresh object, so the page can mutate it', () => {
    const a = loadSettings(null)
    a.bpm = 200
    expect(DEFAULT_SETTINGS.bpm).toBe(90)
  })
})
