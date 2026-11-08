import { describe, expect, it } from 'vitest'
import { NOTHING_SEEN, markExported, track, unsaved, type Layers, type TakeGuard } from './take-guard'

const none: Layers = { hasBase: false, hasOverdub: false }
const base: Layers = { hasBase: true, hasOverdub: false }
const both: Layers = { hasBase: true, hasOverdub: true }

/** Feed a run of looper states through the guard, as main.ts does on each change. */
const walk = (states: (Layers | null | 'export')[], from: TakeGuard = NOTHING_SEEN): TakeGuard =>
  states.reduce<TakeGuard>((g, s) => s === 'export' ? markExported(g) : track(g, s), from)

describe('take guard', () => {
  it('has nothing to lose before a base exists, or with no looper at all', () => {
    expect(unsaved(NOTHING_SEEN, null)).toBe(false)
    expect(unsaved(walk([none]), none)).toBe(false)
  })

  it('calls a new base unsaved until it is exported', () => {
    const recorded = walk([none, base])
    expect(unsaved(recorded, base)).toBe(true)
    expect(unsaved(markExported(recorded), base)).toBe(false)
  })

  it('calls an overdub added after the export unsaved again', () => {
    const g = walk([base, 'export', both])
    expect(g.exported).toBe(false)
    expect(unsaved(g, both)).toBe(true)
  })

  it('keeps an export valid through Undo: removing a layer loses nothing new', () => {
    const g = walk([base, both, 'export', base])
    expect(g.exported).toBe(true)
    expect(unsaved(g, base)).toBe(false)
  })

  it('does not let an old export cover a new take after Clear', () => {
    const g = walk([base, 'export', none, base])
    expect(unsaved(g, base)).toBe(true)
  })

  it('counts a re-recorded overdub as new even with the base unchanged', () => {
    const g = walk([base, both, 'export', base, both])
    expect(unsaved(g, both)).toBe(true)
  })
})
