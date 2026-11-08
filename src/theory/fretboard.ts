// Adapted from ModalRuns (same author): computeFretboard in src/utils/musicTheory.ts.
//
// ─── Fretboard ──────────────────────────────────────────────────────
// Every position on the neck is computed from the tuning and the fret number,
// never written down (ModalRuns golden rule 2: an engine that computes frets
// cannot hallucinate one). Pure and deterministic: same input, same board.

import { intervalName, intervalSpeller, midiOctave, noteName, toPc, type PitchClass } from './notes'
import { characterSemitones, getScale, keyUsesFlats, type ScaleKey } from './scales'

/** Standard tuning, low E to high E, as MIDI. */
export const STANDARD_TUNING: readonly number[] = [40, 45, 50, 55, 59, 64]
export const DEFAULT_FRETS = 15

export interface FretCell {
  /** 0 = the lowest-pitched string (tuningMidi[0], low E in standard). */
  string: number
  /** 0 = open string. */
  fret: number
  midi: number
  pc: PitchClass
  /** 'A', 'Bb', 'F#': spelled one way for the whole board (see scaleUsesFlats). */
  name: string
  /** Scientific pitch octave: the open low E is E2. */
  octave: number
  inScale: boolean
  /** What the note shows: spelled by degree inside a seven-note scale (Lydian '#4'), the plain key otherwise. */
  interval: string
  /** Semitones above the root, 0–11: the pitch-class key behind `interval`. */
  semitones: number
  isRoot: boolean
  /** The scale's character note ('6' in Dorian). Never the root: minor pentatonic has none. */
  isCharacter: boolean
}

export type FretboardCells = FretCell[][]

export interface FretboardInput {
  rootPc: number
  scaleKey: ScaleKey
  /** One MIDI note per open string, lowest-pitched first. */
  tuningMidi?: readonly number[]
  /** Highest fret shown; cells run 0..frets on every string. */
  frets?: number
}

export function computeFretboard({
  rootPc, scaleKey, tuningMidi = STANDARD_TUNING, frets = DEFAULT_FRETS,
}: FretboardInput): FretboardCells {
  if (!Number.isInteger(rootPc)) throw new RangeError(`rootPc must be an integer, got ${rootPc}`)
  if (!Number.isInteger(frets) || frets < 0) throw new RangeError(`frets must be a whole number ≥ 0, got ${frets}`)
  if (tuningMidi.length === 0 || !tuningMidi.every(Number.isInteger)) {
    throw new RangeError('tuningMidi must be a non-empty list of whole MIDI numbers')
  }

  const root = toPc(rootPc)
  const scale = getScale(scaleKey)
  const inScale = new Set(scale.intervals.map(toPc))
  const flats = keyUsesFlats(root, scaleKey)
  const spell = intervalSpeller(scale.intervals)
  const character = characterSemitones(scaleKey)

  return tuningMidi.map((open, string) => {
    const row: FretCell[] = []
    for (let fret = 0; fret <= frets; fret++) {
      const midi = open + fret
      const semitones = toPc(midi - root)
      const isIn = inScale.has(semitones)
      const key = intervalName(semitones)
      row.push({
        string, fret, midi,
        pc: toPc(midi),
        name: noteName(midi, flats),
        octave: midiOctave(midi),
        inScale: isIn,
        // A note outside the scale keeps its plain name: F in C Lydian is the 4.
        interval: isIn ? spell(key) : key,
        semitones,
        isRoot: semitones === 0,
        isCharacter: isIn && semitones === character,
      })
    }
    return row
  })
}

/** Every place on this board where exactly this MIDI note sits: a guitarist may play it on any of them. */
export function positionsOfMidi(cells: FretboardCells, midi: number): FretCell[] {
  return cells.flat().filter(cell => cell.midi === midi)
}
