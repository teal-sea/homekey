// The view's pure half: layout and the screen-reader summary. Drawing into a real
// DOM is checked in the browser (no jsdom here).
import { describe, expect, it } from 'vitest'
import { computeFretboard } from '../theory/fretboard'
import { describeFretboard, layoutFretboard, offscreenHeard } from './fretboard-view'

const A = 9
const aMinor = computeFretboard({ rootPc: A, scaleKey: 'aeolian' })
const aPenta = computeFretboard({ rootPc: A, scaleKey: 'minor_penta' })

describe('layoutFretboard', () => {
  it('draws one dot per scale note, and the root and character apart from the rest', () => {
    const layout = layoutFretboard(aMinor, { heardMidi: null, showNames: false })
    expect(layout.dots).toHaveLength(aMinor.flat().filter(c => c.inScale).length)
    const kinds = new Set(layout.dots.map(d => `${d.kind}:${d.label}`))
    expect(kinds).toContain('root:R')
    expect(kinds).toContain('character:b6')
    expect(kinds).toContain('scale:b3')
    expect([...kinds].some(k => k.startsWith('character:') && k !== 'character:b6')).toBe(false)
  })

  it('labels dots by note name when asked', () => {
    const layout = layoutFretboard(aMinor, { heardMidi: null, showNames: true })
    expect(new Set(layout.dots.map(d => d.label))).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']))
  })

  it('puts the high string at the top', () => {
    const layout = layoutFretboard(aMinor, { heardMidi: null, showNames: false })
    const y = (s: number) => layout.strings.find(row => row.string === s)!.y
    expect(y(5)).toBeLessThan(y(0))
    expect(layout.strings.map(s => s.label)).toEqual(['E', 'A', 'D', 'G', 'B', 'E'])
    expect(layout.strings[0].thickness).toBeGreaterThan(layout.strings[5].thickness)
  })

  it('places frets left to right, narrowing up the neck, and draws markers at 3 5 7 9 12 15', () => {
    const layout = layoutFretboard(aMinor, { heardMidi: null, showNames: false })
    expect(layout.wires).toHaveLength(15)
    const widths = layout.wires.slice(1).map((x, i) => x - layout.wires[i])
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1])
    // Even the narrowest fret holds a dot with room to spare.
    expect(Math.min(...widths)).toBeGreaterThan(layout.radius * 2.5)
    expect(layout.fretNumbers.map(n => n.fret)).toEqual([3, 5, 7, 9, 12, 15])
    expect(layout.markers).toHaveLength(7)   // 12 has two
    // Inlays sit between strings, never on one, for six or seven strings.
    const seven = layoutFretboard(computeFretboard({ rootPc: A, scaleKey: 'aeolian', tuningMidi: [35, 40, 45, 50, 55, 59, 64] }), { heardMidi: null, showNames: false })
    for (const l of [layout, seven]) {
      for (const m of l.markers) for (const s of l.strings) expect(Math.abs(m.y - s.y)).toBeGreaterThan(10)
    }
    // Every dot sits inside the drawing, and none overlaps the next fret's dot.
    for (const d of layout.dots) {
      expect(d.x - layout.radius).toBeGreaterThan(0)
      expect(d.x + layout.radius).toBeLessThan(layout.width)
    }
  })

  it('lights the heard note at every position of that exact pitch', () => {
    const layout = layoutFretboard(aMinor, { heardMidi: 57, showNames: false })   // A3
    expect(layout.heard.map(h => `${h.string}:${h.fret}`)).toEqual(['1:12', '2:7', '3:2'])
    expect(layout.heard.every(h => h.inScale && h.label === 'R')).toBe(true)
  })

  it('lights a heard note outside the scale too, with its own label', () => {
    const layout = layoutFretboard(aPenta, { heardMidi: 41, showNames: true })     // F2: not in A minor pentatonic
    expect(layout.heard).toEqual([expect.objectContaining({ string: 0, fret: 1, inScale: false, label: 'F' })])
  })

  it('lights nothing for silence or a pitch off the board', () => {
    expect(layoutFretboard(aMinor, { heardMidi: null, showNames: false }).heard).toEqual([])
    expect(layoutFretboard(aMinor, { heardMidi: 90, showNames: false }).heard).toEqual([])
  })
})

describe('describeFretboard', () => {
  it('names the key, the mode and the heard note', () => {
    expect(describeFretboard(aMinor, { heardMidi: 57, showNames: false, scaleKey: 'aeolian' }))
      .toBe('Fretboard, A Aeolian (Natural Minor), frets 0 to 15. Heard A3 (the root), 3 places on the neck.')
  })

  it('says when nothing is heard', () => {
    expect(describeFretboard(aPenta, { heardMidi: null, showNames: false, scaleKey: 'minor_penta' }))
      .toBe('Fretboard, A Minor Pentatonic, frets 0 to 15. No note heard.')
  })

  it('names the character note and notes outside the scale', () => {
    const dorian = computeFretboard({ rootPc: A, scaleKey: 'dorian' })
    expect(describeFretboard(dorian, { heardMidi: 54, showNames: false, scaleKey: 'dorian' }))   // F#3
      .toBe('Fretboard, A Dorian, frets 0 to 15. Heard F#3 (6, the character note), 3 places on the neck.')
    expect(describeFretboard(aMinor, { heardMidi: 56, showNames: false, scaleKey: 'aeolian' }))  // G#3
      .toBe('Fretboard, A Aeolian (Natural Minor), frets 0 to 15. Heard G#3 (7, outside the scale), 3 places on the neck.')
  })

  it('names a pitch beyond the frets in the board\'s spelling', () => {
    const f = computeFretboard({ rootPc: 5, scaleKey: 'ionian' })
    expect(describeFretboard(f, { heardMidi: 94, showNames: false, scaleKey: 'ionian' }))       // Bb6
      .toBe('Fretboard, F Ionian (Major), frets 0 to 15. Heard Bb6, beyond the frets shown.')
  })

  it('falls back to the root alone without a scale key', () => {
    expect(describeFretboard(aMinor, { heardMidi: null, showNames: false })).toBe('Fretboard, root A, frets 0 to 15. No note heard.')
  })
})

describe('offscreenHeard', () => {
  // A3 in A minor: frets 2, 7 and 12. A phone shows the neck at 720 px of a
  // 1016-unit drawing and scrolls; the tags count what is out of view.
  const xs = layoutFretboard(aMinor, { heardMidi: 57, showNames: false }).heard.map(h => h.x)
  const scale = 720 / layoutFretboard(aMinor, { heardMidi: null, showNames: false }).width

  it('counts the places right of the view at the start of the neck, left of it at the far end', () => {
    expect(offscreenHeard(xs, scale, 0, 324)).toEqual({ left: 0, right: 2 })
    expect(offscreenHeard(xs, scale, 720 - 324, 324)).toEqual({ left: 2, right: 0 })
  })

  it('counts nothing when the whole neck fits, or nothing is heard', () => {
    expect(offscreenHeard(xs, 1, 0, 1016)).toEqual({ left: 0, right: 0 })
    expect(offscreenHeard([], scale, 0, 324)).toEqual({ left: 0, right: 0 })
  })
})
