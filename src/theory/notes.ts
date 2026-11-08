// Adapted from the author's Modal Runs app (modalruns.com): its music theory.
//
// ─── Notes ──────────────────────────────────────────────────────────
// Pitch classes are integers 0–11 (C = 0 … B = 11). MIDI numbers are absolute
// pitch (low E = 40). Names are computed last, from a pitch class plus one
// sharps-or-flats decision per board, so every readout on the page names a note
// the same way.

export type PitchClass = number

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

/** Wrap any integer into 0–11 (negative numbers included). */
export function toPc(n: number): PitchClass {
  return ((n % 12) + 12) % 12
}

export function noteName(pc: number, flats = false): string {
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[toPc(pc)]
}

/** Scientific pitch octave: MIDI 60 is C4, the low E string (40) is E2. */
export function midiOctave(midi: number): number {
  return Math.floor(midi / 12) - 1
}

/** 'A3', 'Bb2': the name a readout shows for one exact pitch. */
export function midiName(midi: number, flats = false): string {
  return noteName(midi, flats) + midiOctave(midi)
}

// ─── Interval names ─────────────────────────────────────────────────
// These are pitch-class KEYS: 6 semitones is always 'b5'. Colours and the
// character note key on them. What a note SHOWS inside a seven-note scale is
// spelled by degree instead (intervalSpeller below), so Lydian reads '#4'.

export type IntervalName = 'R' | 'b2' | '2' | 'b3' | '3' | '4' | 'b5' | '5' | 'b6' | '6' | 'b7' | '7'

export const INTERVAL_NAMES: readonly IntervalName[] = ['R', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7']

export function intervalName(semitones: number): IntervalName {
  return INTERVAL_NAMES[toPc(semitones)]
}

/** The inverse of intervalName: 'b3' → 3. Null for anything that is not a key ('#4' included). */
export function intervalSemitones(name: string): number | null {
  const i = INTERVAL_NAMES.indexOf(name as IntervalName)
  return i < 0 ? null : i
}

// ─── Interval spelling ──────────────────────────────────────────────
// Inside a seven-note scale a note is spelled by its degree, the way a guitarist
// reads a formula: Lydian's raised fourth is '#4' (its fifth is still there),
// Locrian's flat fifth stays 'b5'. Pentatonics and the blues scale keep the keys,
// and so does a note outside the scale.

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11]

function uniqueSortedPcs(values: Iterable<number>): PitchClass[] {
  return [...new Set([...values].map(toPc))].sort((a, b) => a - b)
}

export function intervalSpeller(scaleIntervals?: readonly number[] | null): (name: string) => string {
  const degrees = scaleIntervals ? uniqueSortedPcs(scaleIntervals) : []
  if (degrees.length !== 7 || degrees[0] !== 0) return name => name
  return name => {
    const semis = intervalSemitones(name)
    const at = semis === null ? -1 : degrees.indexOf(semis)
    if (semis === null || at <= 0) return name
    const shift = semis - MAJOR_DEGREES[at]
    if (Math.abs(shift) > 2) return name
    return (shift < 0 ? 'b'.repeat(-shift) : '#'.repeat(shift)) + String(at + 1)
  }
}

export function spellInterval(name: string, scaleIntervals?: readonly number[] | null): string {
  return intervalSpeller(scaleIntervals)(name)
}

/** 'R - 2 - 3 - #4 - 5 - 6 - 7' for Lydian. */
export function scaleFormula(intervals: readonly number[], separator = ' - '): string {
  const spell = intervalSpeller(intervals)
  return intervals.map(i => spell(intervalName(i))).join(separator)
}

// ─── Sharps or flats ────────────────────────────────────────────────
// Twelve names, one boolean per board: a key that needs E#, Cb or a mix of
// sharps and flats (D harmonic minor's Bb and C#) cannot be spelled exactly.
// The rules below get every major mode and pentatonic right and pick the
// least-wrong spelling for the rest.

// The fallback when nothing else decides: the root alone, as in the original.
// The app holds a root as a pitch class, not a name, so a black-key root takes
// the name a guitarist usually calls that key (Db, Eb, F#, Ab, Bb).
const DEFAULT_ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const FLAT_ROOTS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'D', 'G', 'C'])

export function rootPrefersFlats(rootPc: number): boolean {
  return FLAT_ROOTS.has(DEFAULT_ROOT_NAMES[toPc(rootPc)])
}

const LETTERS = 'CDEFGAB'
const NATURAL_MINOR = [0, 2, 3, 5, 7, 8, 10]

// How many of the scale's notes land on the letter its formula names, spelled
// one way (the original's vote for chords, applied to a scale). The root's
// own letter comes from the same spelling, so F# and Gb are each judged fairly.
function lettersOnDegree(rootPc: number, intervals: readonly number[], flats: boolean): number {
  const spell = intervalSpeller(intervals)
  const rootLetter = LETTERS.indexOf(noteName(rootPc, flats)[0])
  return intervals.filter(iv => {
    const label = spell(intervalName(iv))
    const degree = label === 'R' ? 1 : Number(label.replace(/[b#]/g, ''))
    return noteName(rootPc + iv, flats)[0] === LETTERS[(rootLetter + degree - 1) % 7]
  }).length
}

/**
 * Sharps or flats for a scale rooted on `rootPc`, `intervals` in semitones above it.
 *
 * 1. Seven notes: the spelling that gives one letter per degree, as the key
 *    signature does (C Lydian F#, D major F# and C#, F major Bb).
 * 2. Fewer notes inside the major or natural minor on the same root: spelled as
 *    that parent (D major pentatonic F#).
 * 3. Otherwise the formula votes: whichever spelling puts more notes on the letter
 *    its degree names. This is where it departs from the original, which let the
 *    root decide: A blues there reads D#, here it reads Eb, the flat fifth it is.
 * 4. A tie (all naturals, or D harmonic minor's Bb against C#): the root decides.
 */
export function scaleUsesFlats(rootPc: number, intervals: readonly number[]): boolean {
  const root = toPc(rootPc)
  const ivs = uniqueSortedPcs(intervals)
  if (ivs.length === 7) {
    const oneLetterEach = (flats: boolean) => new Set(ivs.map(iv => noteName(root + iv, flats)[0])).size === 7
    const sharpsWork = oneLetterEach(false), flatsWork = oneLetterEach(true)
    if (sharpsWork !== flatsWork) return flatsWork
  } else if (ivs.length > 0 && ivs.length < 7) {
    for (const parent of [MAJOR_DEGREES, NATURAL_MINOR]) {
      if (ivs.every(iv => parent.includes(iv))) return scaleUsesFlats(root, parent)
    }
  }
  const sharps = lettersOnDegree(root, ivs, false), flats = lettersOnDegree(root, ivs, true)
  return sharps === flats ? rootPrefersFlats(root) : flats > sharps
}
