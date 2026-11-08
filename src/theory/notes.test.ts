import { describe, expect, it } from 'vitest'
import {
  intervalName, intervalSemitones, midiName, midiOctave, noteName, rootPrefersFlats,
  scaleFormula, scaleUsesFlats, spellInterval, toPc, INTERVAL_NAMES,
} from './notes'
import { SCALES, type ScaleKey } from './scales'

// ─── Helpers ────────────────────────────────────────────────────────
const C = 0, Db = 1, D = 2, Eb = 3, E = 4, F = 5, Gb = 6, G = 7, Ab = 8, A = 9, Bb = 10, B = 11

function spelled(rootPc: number, key: ScaleKey): string {
  const { intervals } = SCALES[key]
  const flats = scaleUsesFlats(rootPc, intervals)
  return intervals.map(iv => noteName(rootPc + iv, flats)).join(' ')
}

// ─── Pitch classes and names ────────────────────────────────────────
describe('pitch classes', () => {
  it('wraps any integer into 0–11', () => {
    expect(toPc(0)).toBe(0)
    expect(toPc(12)).toBe(0)
    expect(toPc(-1)).toBe(11)
    expect(toPc(40)).toBe(4)   // low E
    expect(toPc(-13)).toBe(11)
  })

  it('names a pitch class with sharps or flats', () => {
    expect(noteName(1)).toBe('C#')
    expect(noteName(1, true)).toBe('Db')
    expect(noteName(10, true)).toBe('Bb')
    expect(noteName(9)).toBe('A')
    expect(noteName(9, true)).toBe('A')
    expect(noteName(-3)).toBe('A')
  })

  it('uses scientific pitch octaves: the low E string is E2, middle C is C4', () => {
    expect(midiOctave(40)).toBe(2)
    expect(midiName(40)).toBe('E2')
    expect(midiName(60)).toBe('C4')
    expect(midiName(57)).toBe('A3')
    expect(midiName(70, true)).toBe('Bb4')
    expect(midiName(59)).toBe('B3')   // B just under middle C stays in octave 3
  })
})

// ─── Interval names ─────────────────────────────────────────────────
describe('interval names', () => {
  it('keys every semitone count 0–11', () => {
    expect([...Array(12)].map((_, i) => intervalName(i))).toEqual(
      ['R', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'])
    expect(INTERVAL_NAMES).toHaveLength(12)
  })

  it('wraps octaves and negatives', () => {
    expect(intervalName(12)).toBe('R')
    expect(intervalName(14)).toBe('2')
    expect(intervalName(-1)).toBe('7')
  })

  it('inverts the keys and nothing else', () => {
    for (let i = 0; i < 12; i++) expect(intervalSemitones(intervalName(i))).toBe(i)
    expect(intervalSemitones('#4')).toBeNull()
    expect(intervalSemitones('9')).toBeNull()
  })

  it('spells Lydian\'s raised fourth #4 and keeps Locrian\'s b5', () => {
    expect(spellInterval('b5', SCALES.lydian.intervals)).toBe('#4')
    expect(spellInterval('b5', SCALES.locrian.intervals)).toBe('b5')
    expect(spellInterval('b5', SCALES.blues.intervals)).toBe('b5')   // not seven notes: the key stays
    expect(spellInterval('R', SCALES.lydian.intervals)).toBe('R')
    expect(spellInterval('4', SCALES.lydian.intervals)).toBe('4')    // outside the scale: unchanged
  })

  it('reads each scale\'s formula as a guitarist would', () => {
    expect(scaleFormula(SCALES.ionian.intervals)).toBe('R - 2 - 3 - 4 - 5 - 6 - 7')
    expect(scaleFormula(SCALES.dorian.intervals)).toBe('R - 2 - b3 - 4 - 5 - 6 - b7')
    expect(scaleFormula(SCALES.phrygian.intervals)).toBe('R - b2 - b3 - 4 - 5 - b6 - b7')
    expect(scaleFormula(SCALES.lydian.intervals)).toBe('R - 2 - 3 - #4 - 5 - 6 - 7')
    expect(scaleFormula(SCALES.mixolydian.intervals)).toBe('R - 2 - 3 - 4 - 5 - 6 - b7')
    expect(scaleFormula(SCALES.aeolian.intervals)).toBe('R - 2 - b3 - 4 - 5 - b6 - b7')
    expect(scaleFormula(SCALES.locrian.intervals)).toBe('R - b2 - b3 - 4 - b5 - b6 - b7')
    expect(scaleFormula(SCALES.harmonic_minor.intervals)).toBe('R - 2 - b3 - 4 - 5 - b6 - 7')
    expect(scaleFormula(SCALES.major_penta.intervals)).toBe('R - 2 - 3 - 5 - 6')
    expect(scaleFormula(SCALES.minor_penta.intervals)).toBe('R - b3 - 4 - 5 - b7')
    expect(scaleFormula(SCALES.blues.intervals)).toBe('R - b3 - 4 - b5 - 5 - b7')
  })
})

// ─── Sharps or flats, by the scale ──────────────────────────────────
describe('scaleUsesFlats: one letter per degree, as the key signature has it', () => {
  it('A minor and C major have no accidentals', () => {
    expect(spelled(A, 'aeolian')).toBe('A B C D E F G')
    expect(spelled(C, 'ionian')).toBe('C D E F G A B')
    expect(spelled(A, 'minor_penta')).toBe('A C D E G')
    expect(spelled(C, 'major_penta')).toBe('C D E G A')
  })

  it('C Lydian has F#, not Gb', () => {
    expect(spelled(C, 'lydian')).toBe('C D E F# G A B')
  })

  it('F major has Bb, D and G major take sharps', () => {
    expect(spelled(F, 'ionian')).toBe('F G A Bb C D E')
    expect(spelled(D, 'ionian')).toBe('D E F# G A B C#')
    expect(spelled(G, 'ionian')).toBe('G A B C D E F#')
    expect(spelled(Bb, 'ionian')).toBe('Bb C D Eb F G A')
  })

  it('names a black-key root the way its key does: Db major, C# minor', () => {
    expect(spelled(Db, 'ionian')).toBe('Db Eb F Gb Ab Bb C')
    expect(spelled(Db, 'aeolian')).toBe('C# D# E F# G# A B')
    expect(spelled(Ab, 'ionian')).toBe('Ab Bb C Db Eb F G')
    expect(spelled(Eb, 'mixolydian')).toBe('Eb F G Ab Bb C Db')
  })

  it('keeps the modes on their own key signatures', () => {
    expect(spelled(E, 'phrygian')).toBe('E F G A B C D')
    expect(spelled(G, 'lydian')).toBe('G A B C# D E F#')
    expect(spelled(D, 'mixolydian')).toBe('D E F# G A B C')
    expect(spelled(D, 'dorian')).toBe('D E F G A B C')
    expect(spelled(B, 'locrian')).toBe('B C D E F G A')
  })

  it('spells a pentatonic as the major or minor that holds it', () => {
    expect(spelled(D, 'major_penta')).toBe('D E F# A B')
    expect(spelled(Bb, 'major_penta')).toBe('Bb C D F G')
    expect(spelled(Gb, 'minor_penta')).toBe('F# A B C# E')
    expect(spelled(E, 'minor_penta')).toBe('E G A B D')
  })

  it('gives harmonic minor its raised seventh as a sharp where the key allows', () => {
    expect(spelled(A, 'harmonic_minor')).toBe('A B C D E F G#')
    expect(spelled(E, 'harmonic_minor')).toBe('E F# G A B C D#')
  })

  it('spells the blues scale\'s flat fifth as a flat (A blues has Eb, not D#)', () => {
    expect(spelled(A, 'blues')).toBe('A C D Eb E G')
    expect(spelled(E, 'blues')).toBe('E G A Bb B D')
    expect(spelled(G, 'blues')).toBe('G Bb C Db D F')
    expect(spelled(Db, 'blues')).toBe('C# E F# G G# B')
  })

  it('lets the root decide a tie, as ModalRuns does (D harmonic minor cannot have both Bb and C#)', () => {
    expect(scaleUsesFlats(D, SCALES.harmonic_minor.intervals)).toBe(rootPrefersFlats(D))
    expect(spelled(D, 'harmonic_minor')).toBe('D E F G A Bb Db')
  })

  it('takes the root fallback from ModalRuns\' table on the default key names', () => {
    expect([...Array(12)].map((_, pc) => rootPrefersFlats(pc))).toEqual(
      [true, true, true, true, false, true, false, true, true, false, true, false])
  })

  it('is deterministic and ignores order and duplicates in the intervals', () => {
    expect(scaleUsesFlats(F, [0, 2, 4, 5, 7, 9, 11])).toBe(scaleUsesFlats(F, [11, 9, 7, 5, 4, 2, 0, 12]))
  })
})
