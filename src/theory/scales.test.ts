import { describe, expect, it } from 'vitest'
import {
  SCALE_KEYS, SCALES, characterLabel, characterSemitones, formulaOf, getScale, isScaleKey,
  keyLabel, keyRootName, scalePitchClasses, type ScaleKey,
} from './scales'
import { intervalName } from './notes'

describe('the scale catalogue', () => {
  it('has the seven modes, both pentatonics, blues and harmonic minor, in picker order', () => {
    expect(SCALE_KEYS).toEqual([
      'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
      'major_penta', 'minor_penta', 'blues', 'harmonic_minor',
    ])
    expect(Object.keys(SCALES).sort()).toEqual([...SCALE_KEYS].sort())
    for (const key of SCALE_KEYS) expect(SCALES[key].key).toBe(key)
  })

  it('gives each scale the right number of notes', () => {
    const lengths = Object.fromEntries(SCALE_KEYS.map(k => [k, SCALES[k].intervals.length]))
    expect(lengths).toEqual({
      ionian: 7, dorian: 7, phrygian: 7, lydian: 7, mixolydian: 7, aeolian: 7, locrian: 7,
      major_penta: 5, minor_penta: 5, blues: 6, harmonic_minor: 7,
    })
  })

  it('writes every scale as unique ascending semitones from the root', () => {
    for (const key of SCALE_KEYS) {
      const ivs = SCALES[key].intervals
      expect(ivs[0]).toBe(0)
      for (let i = 1; i < ivs.length; i++) expect(ivs[i]).toBeGreaterThan(ivs[i - 1])
      expect(ivs[ivs.length - 1]).toBeLessThan(12)
    }
  })

  it('makes the seven modes rotations of one another (one parent major scale)', () => {
    const modes: ScaleKey[] = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian']
    const major = SCALES.ionian.intervals
    modes.forEach((key, degree) => {
      const rotated = major.map(iv => (iv - major[degree] + 12) % 12).sort((a, b) => a - b)
      expect(SCALES[key].intervals).toEqual(rotated)
    })
  })

  it('names major and natural minor plainly for players who do not think in modes', () => {
    expect(SCALES.ionian.name).toBe('Ionian (Major)')
    expect(SCALES.aeolian.name).toBe('Aeolian (Natural Minor)')
  })
})

describe('the character note', () => {
  it('is pinned for every scale', () => {
    expect(Object.fromEntries(SCALE_KEYS.map(k => [k, SCALES[k].character]))).toEqual({
      ionian: '7', dorian: '6', phrygian: 'b2', lydian: 'b5', mixolydian: 'b7', aeolian: 'b6', locrian: 'b5',
      major_penta: '6', minor_penta: 'R', blues: 'b5', harmonic_minor: '7',
    })
  })

  it('is always a note of its own scale', () => {
    for (const key of SCALE_KEYS) {
      const names = SCALES[key].intervals.map(intervalName)
      expect(names).toContain(SCALES[key].character)
    }
  })

  it('is spelled as the scale reads it: Lydian #4, Dorian 6, blues b5', () => {
    expect(characterLabel('lydian')).toBe('#4')
    expect(characterLabel('dorian')).toBe('6')
    expect(characterLabel('blues')).toBe('b5')
    expect(characterSemitones('dorian')).toBe(9)
    expect(characterSemitones('lydian')).toBe(6)
  })

  it('promotes nothing extra for minor pentatonic: the root is its own character', () => {
    expect(characterSemitones('minor_penta')).toBeNull()
  })
})

describe('keys', () => {
  it('lists pitch classes on a root', () => {
    expect([...scalePitchClasses(9, 'minor_penta')].sort((a, b) => a - b)).toEqual([0, 2, 4, 7, 9])   // A C D E G
  })

  it('labels a key with its root spelled for that key', () => {
    expect(keyLabel(9, 'aeolian')).toBe('A Aeolian (Natural Minor)')
    expect(keyLabel(0, 'ionian')).toBe('C Ionian (Major)')
    expect(keyRootName(1, 'ionian')).toBe('Db')
    expect(keyRootName(1, 'aeolian')).toBe('C#')
    expect(keyRootName(6, 'minor_penta')).toBe('F#')
  })

  it('reads formulas', () => {
    expect(formulaOf('lydian')).toBe('R - 2 - 3 - #4 - 5 - 6 - 7')
  })

  it('validates keys read back from storage', () => {
    expect(isScaleKey('dorian')).toBe(true)
    expect(isScaleKey('toString')).toBe(false)
    expect(isScaleKey('whole_tone')).toBe(false)
    expect(isScaleKey(3)).toBe(false)
    expect(() => getScale('nope' as ScaleKey)).toThrow(RangeError)
  })
})
