// Adapted from the author's Modal Runs app (modalruns.com): its scale and
// character-note tables.
//
// ─── Scales ─────────────────────────────────────────────────────────
// The scales a blues and space-rock player reaches for: the seven modes, the two
// pentatonics, the blues scale and harmonic minor. The keys are the original's,
// so code ports across. Adding a scale is one entry here plus a test.

import {
  intervalSemitones, noteName, scaleFormula, scaleUsesFlats, spellInterval, toPc,
  type IntervalName, type PitchClass,
} from './notes'

export type ScaleKey =
  | 'ionian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'aeolian' | 'locrian'
  | 'major_penta' | 'minor_penta' | 'blues' | 'harmonic_minor'

export interface ScaleDef {
  key: ScaleKey
  name: string
  /** Semitones above the root, ascending, starting at 0. */
  intervals: readonly number[]
  /**
   * The note that makes the scale itself, as an interval KEY ('6' for Dorian, 'b5'
   * for Lydian, shown '#4'). Never a fret or a pitch: the board computes those.
   * 'R' means the root is its own character (minor pentatonic): no extra note is
   * promoted.
   */
  character: IntervalName
}

// Picker order: the modes in their usual order, then the pentatonics, blues and
// harmonic minor.
export const SCALE_KEYS: readonly ScaleKey[] = [
  'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
  'major_penta', 'minor_penta', 'blues', 'harmonic_minor',
]

export const SCALES: Readonly<Record<ScaleKey, ScaleDef>> = {
  ionian:         { key: 'ionian',         name: 'Ionian (Major)',          intervals: [0, 2, 4, 5, 7, 9, 11], character: '7' },
  dorian:         { key: 'dorian',         name: 'Dorian',                  intervals: [0, 2, 3, 5, 7, 9, 10], character: '6' },
  phrygian:       { key: 'phrygian',       name: 'Phrygian',                intervals: [0, 1, 3, 5, 7, 8, 10], character: 'b2' },
  lydian:         { key: 'lydian',         name: 'Lydian',                  intervals: [0, 2, 4, 6, 7, 9, 11], character: 'b5' },
  mixolydian:     { key: 'mixolydian',     name: 'Mixolydian',              intervals: [0, 2, 4, 5, 7, 9, 10], character: 'b7' },
  aeolian:        { key: 'aeolian',        name: 'Aeolian (Natural Minor)', intervals: [0, 2, 3, 5, 7, 8, 10], character: 'b6' },
  locrian:        { key: 'locrian',        name: 'Locrian',                 intervals: [0, 1, 3, 5, 6, 8, 10], character: 'b5' },
  major_penta:    { key: 'major_penta',    name: 'Major Pentatonic',        intervals: [0, 2, 4, 7, 9],        character: '6' },
  minor_penta:    { key: 'minor_penta',    name: 'Minor Pentatonic',        intervals: [0, 3, 5, 7, 10],       character: 'R' },
  blues:          { key: 'blues',          name: 'Blues',                   intervals: [0, 3, 5, 6, 7, 10],    character: 'b5' },
  harmonic_minor: { key: 'harmonic_minor', name: 'Harmonic Minor',          intervals: [0, 2, 3, 5, 7, 8, 11], character: '7' },
}

/** For values read back from localStorage or a URL. */
export function isScaleKey(value: unknown): value is ScaleKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCALES, value)
}

export function getScale(key: ScaleKey): ScaleDef {
  const scale = SCALES[key]
  if (!scale) throw new RangeError(`Unknown scale: ${String(key)}`)
  return scale
}

/** The scale's pitch classes on this root. */
export function scalePitchClasses(rootPc: number, key: ScaleKey): Set<PitchClass> {
  return new Set(getScale(key).intervals.map(iv => toPc(rootPc + iv)))
}

/** Semitones of the character note above the root, or null when the root is its own character. */
export function characterSemitones(key: ScaleKey): number | null {
  const { character } = getScale(key)
  return character === 'R' ? null : intervalSemitones(character)
}

/** The character interval as this scale spells it on screen: Lydian '#4', Dorian '6'. */
export function characterLabel(key: ScaleKey): string {
  const scale = getScale(key)
  return spellInterval(scale.character, scale.intervals)
}

/** 'R - 2 - 3 - #4 - 5 - 6 - 7' */
export function formulaOf(key: ScaleKey): string {
  return scaleFormula(getScale(key).intervals)
}

/** Sharps or flats for every name shown while this key is selected. */
export function keyUsesFlats(rootPc: number, key: ScaleKey): boolean {
  return scaleUsesFlats(rootPc, getScale(key).intervals)
}

/** The root's name in this key: pitch class 1 is 'Db' in Db major, 'C#' in C# minor. */
export function keyRootName(rootPc: number, key: ScaleKey): string {
  return noteName(rootPc, keyUsesFlats(rootPc, key))
}

/** 'A Aeolian (Natural Minor)' */
export function keyLabel(rootPc: number, key: ScaleKey): string {
  return `${keyRootName(rootPc, key)} ${getScale(key).name}`
}
