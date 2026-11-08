import { describe, expect, it } from 'vitest'
import { computeFretboard, positionsOfMidi, STANDARD_TUNING, type FretCell } from './fretboard'
import { SCALE_KEYS } from './scales'

const A = 9, C = 0, D = 2, E = 4

const where = (cells: FretCell[]) => cells.map(c => `${c.string}:${c.fret}`)

describe('computeFretboard: shape of the board', () => {
  it('has one row per string and frets 0..15 by default, low E first', () => {
    const board = computeFretboard({ rootPc: A, scaleKey: 'minor_penta' })
    expect(board).toHaveLength(6)
    for (const row of board) expect(row).toHaveLength(16)
    board.forEach((row, s) => row.forEach((cell, f) => {
      expect(cell.string).toBe(s)
      expect(cell.fret).toBe(f)
      expect(cell.midi).toBe(STANDARD_TUNING[s] + f)
    }))
  })

  it('puts the open strings at fret 0: E2 A2 D3 G3 B3 E4', () => {
    const board = computeFretboard({ rootPc: A, scaleKey: 'aeolian' })
    expect(board.map(row => `${row[0].name}${row[0].octave}`)).toEqual(['E2', 'A2', 'D3', 'G3', 'B3', 'E4'])
    expect(board.map(row => row[0].midi)).toEqual([40, 45, 50, 55, 59, 64])
  })

  it('follows another tuning and fret count', () => {
    const dropD = [38, 45, 50, 55, 59, 64]
    const board = computeFretboard({ rootPc: D, scaleKey: 'dorian', tuningMidi: dropD, frets: 24 })
    expect(board[0]).toHaveLength(25)
    expect(board[0][0]).toMatchObject({ name: 'D', octave: 2, isRoot: true })
    expect(board[0][24].midi).toBe(62)
    const sevenString = [35, 40, 45, 50, 55, 59, 64]
    const seven = computeFretboard({ rootPc: D, scaleKey: 'dorian', tuningMidi: sevenString })
    expect(seven).toHaveLength(7)
    expect(seven[0][3]).toMatchObject({ name: 'D', isRoot: true })
  })

  it('is deterministic', () => {
    const a = computeFretboard({ rootPc: E, scaleKey: 'blues' })
    const b = computeFretboard({ rootPc: E, scaleKey: 'blues' })
    expect(a).toEqual(b)
  })

  it('rejects input it cannot draw', () => {
    expect(() => computeFretboard({ rootPc: 1.5, scaleKey: 'ionian' })).toThrow(RangeError)
    expect(() => computeFretboard({ rootPc: 0, scaleKey: 'ionian', frets: -1 })).toThrow(RangeError)
    expect(() => computeFretboard({ rootPc: 0, scaleKey: 'ionian', tuningMidi: [] })).toThrow(RangeError)
    expect(() => computeFretboard({ rootPc: 0, scaleKey: 'nope' as never })).toThrow(RangeError)
  })

  it('wraps any integer root into a pitch class', () => {
    expect(computeFretboard({ rootPc: 21, scaleKey: 'aeolian' })).toEqual(computeFretboard({ rootPc: A, scaleKey: 'aeolian' }))
  })
})

describe('computeFretboard: A minor pentatonic', () => {
  const board = computeFretboard({ rootPc: A, scaleKey: 'minor_penta' })

  it('roots on the low E string at fret 5; fret 17 is beyond a 15-fret board', () => {
    const lowERoots = board[0].filter(c => c.isRoot).map(c => c.fret)
    expect(lowERoots).toEqual([5])
    const longer = computeFretboard({ rootPc: A, scaleKey: 'minor_penta', frets: 17 })
    expect(longer[0].filter(c => c.isRoot).map(c => c.fret)).toEqual([5, 17])
  })

  it('finds the root on every string where the engine says it is', () => {
    // Computed independently: fret = (A - open string) mod 12, then +12 while it fits.
    board.forEach((row, s) => {
      const first = ((A - STANDARD_TUNING[s]) % 12 + 12) % 12
      const expected = [first, first + 12].filter(f => f <= 15)
      expect(row.filter(c => c.isRoot).map(c => c.fret)).toEqual(expected)
    })
  })

  it('lights exactly A C D E G, labelled R b3 4 5 b7', () => {
    const lit = board.flat().filter(c => c.inScale)
    expect(new Set(lit.map(c => c.name))).toEqual(new Set(['A', 'C', 'D', 'E', 'G']))
    expect(new Set(lit.map(c => c.interval))).toEqual(new Set(['R', 'b3', '4', '5', 'b7']))
    // The open low E is the 5, in the scale; F at fret 1 is not.
    expect(board[0][0]).toMatchObject({ name: 'E', interval: '5', inScale: true, isRoot: false })
    expect(board[0][1]).toMatchObject({ name: 'F', inScale: false })
  })

  it('has no character note: the root is its own', () => {
    expect(board.flat().some(c => c.isCharacter)).toBe(false)
  })
})

describe('computeFretboard: spelling and the character note', () => {
  it('marks Dorian\'s 6 as the character note (F# in A Dorian)', () => {
    const board = computeFretboard({ rootPc: A, scaleKey: 'dorian' })
    const character = board.flat().filter(c => c.isCharacter)
    expect(character.length).toBeGreaterThan(0)
    for (const c of character) expect(c).toMatchObject({ name: 'F#', interval: '6', semitones: 9, inScale: true, isRoot: false })
    // Every F# on the board, and nothing else.
    expect(character.length).toBe(board.flat().filter(c => c.pc === 6).length)
    expect(board[0][2]).toMatchObject({ name: 'F#', isCharacter: true })   // low E, fret 2
  })

  it('reads C Lydian\'s raised fourth as F# #4, while F outside the scale stays the 4', () => {
    const board = computeFretboard({ rootPc: C, scaleKey: 'lydian' })
    const raised = board.flat().filter(c => c.pc === 6)
    for (const c of raised) expect(c).toMatchObject({ name: 'F#', interval: '#4', isCharacter: true, inScale: true })
    for (const c of board.flat().filter(c => c.pc === 5)) expect(c).toMatchObject({ name: 'F', interval: '4', inScale: false })
  })

  it('spells F major with Bb and A minor with no accidentals', () => {
    const f = computeFretboard({ rootPc: 5, scaleKey: 'ionian' })
    expect(new Set(f.flat().filter(c => c.inScale).map(c => c.name))).toEqual(new Set(['F', 'G', 'A', 'Bb', 'C', 'D', 'E']))
    const a = computeFretboard({ rootPc: A, scaleKey: 'aeolian' })
    expect(a.flat().filter(c => c.inScale).every(c => c.name.length === 1)).toBe(true)
    // Outside the scale the board keeps one spelling: A minor's raised 7th reads G#.
    expect(a[0][4]).toMatchObject({ name: 'G#', interval: '7', inScale: false })
  })

  it('every scale has a root on every string of a 15-fret board, and the character note is never the root', () => {
    for (const scaleKey of SCALE_KEYS) {
      const board = computeFretboard({ rootPc: E, scaleKey })
      for (const row of board) expect(row.some(c => c.isRoot)).toBe(true)
      expect(board.flat().some(c => c.isRoot && c.isCharacter)).toBe(false)
      expect(board.flat().every(c => !c.isCharacter || c.inScale)).toBe(true)
    }
  })
})

describe('positionsOfMidi: the same pitch, everywhere it sits', () => {
  const board = computeFretboard({ rootPc: A, scaleKey: 'aeolian' })

  it('finds A3 (MIDI 57) on A12, D7 and G2; low E 17 is off this board', () => {
    expect(where(positionsOfMidi(board, 57))).toEqual(['1:12', '2:7', '3:2'])
    const longer = computeFretboard({ rootPc: A, scaleKey: 'aeolian', frets: 17 })
    expect(where(positionsOfMidi(longer, 57))).toEqual(['0:17', '1:12', '2:7', '3:2'])
  })

  it('finds the open low E only once and nothing below it', () => {
    expect(where(positionsOfMidi(board, 40))).toEqual(['0:0'])
    expect(positionsOfMidi(board, 39)).toEqual([])
  })

  it('treats octaves as different notes (A2 is not A3)', () => {
    expect(where(positionsOfMidi(board, 45))).toEqual(['0:5', '1:0'])
  })

  it('finds the high E string\'s 15th fret, the top of the board', () => {
    expect(where(positionsOfMidi(board, 79))).toEqual(['5:15'])
    expect(positionsOfMidi(board, 80)).toEqual([])
  })
})
