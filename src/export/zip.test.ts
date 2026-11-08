import { describe, expect, it } from 'vitest'
import { crc32, dosDateTime, zipStore } from './zip'
import { crc32Bitwise, readZip } from '../../tests/zip-reader'

const text = (s: string): Uint8Array => new TextEncoder().encode(s)

// Deterministic bytes covering every value, at a length that is not a round number.
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    out[i] = x >>> 23
  }
  return out
}

const WHEN = new Date(2026, 10, 8, 19, 30, 43) // local time, as ZIP stores it

describe('crc32', () => {
  it('matches the published CRC-32 check values', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
    expect(crc32(text('123456789'))).toBe(0xcbf43926)
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
    expect(crc32(new Uint8Array(32))).toBe(0x190a55ad)
  })

  it('agrees with an independent bit-by-bit CRC on arbitrary data', () => {
    for (const length of [1, 7, 256, 4099]) {
      const data = noise(length, length)
      expect(crc32(data)).toBe(crc32Bitwise(data))
    }
  })

  it('reads a view at its own offset, not the whole buffer', () => {
    const whole = text('xx123456789yy')
    expect(crc32(whole.subarray(2, 11))).toBe(0xcbf43926)
  })
})

describe('dosDateTime', () => {
  it('packs local date and time, seconds halved', () => {
    const { date, time } = dosDateTime(WHEN)
    expect(date >> 9).toBe(2026 - 1980)
    expect((date >> 5) & 0xf).toBe(11)
    expect(date & 0x1f).toBe(8)
    expect(time >> 11).toBe(19)
    expect((time >> 5) & 0x3f).toBe(30)
    expect((time & 0x1f) * 2).toBe(42)
  })

  it('clamps to the 1980-2107 range ZIP can hold, and an invalid date to the start', () => {
    expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ date: (1 << 5) | 1, time: 0 })
    expect(dosDateTime(new Date(Number.NaN))).toEqual({ date: (1 << 5) | 1, time: 0 })
    expect(dosDateTime(new Date(2200, 0, 1)).date >> 9).toBe(127)
  })
})

describe('zipStore', () => {
  const entries = [
    { name: 'base.wav', data: noise(4099, 1) },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'take.json', data: text('{"bpm": 120}\n') },
    { name: 'notes/señal.txt', data: text('ünïcödé') },
  ]

  it('round-trips through an independent reader: names, bytes, CRCs, order', () => {
    const zip = zipStore(entries, WHEN)
    const files = readZip(zip)
    expect(files.map((f) => f.name)).toEqual(entries.map((e) => e.name))
    files.forEach((f, i) => {
      expect(Array.from(f.data)).toEqual(Array.from(entries[i].data))
      expect(f.crc32).toBe(crc32Bitwise(entries[i].data))
      expect(f.flags).toBe(0x0800) // UTF-8 names, nothing else
      expect(f.dosTime).toBe(dosDateTime(WHEN).time)
      expect(f.dosDate).toBe(dosDateTime(WHEN).date)
    })
  })

  it('lays out local headers, data, central directory and end record exactly', () => {
    const zip = zipStore(entries, WHEN)
    const v = new DataView(zip.buffer)
    const names = entries.map((e) => text(e.name).length)
    const local = entries.reduce((n, e, i) => n + 30 + names[i] + e.data.length, 0)
    const central = names.reduce((n, len) => n + 46 + len, 0)
    expect(zip.length).toBe(local + central + 22)

    // First local header.
    expect(v.getUint32(0, true)).toBe(0x04034b50)
    expect(v.getUint16(4, true)).toBe(10) // version needed: 1.0
    expect(v.getUint16(6, true)).toBe(0x0800)
    expect(v.getUint16(8, true)).toBe(0) // stored
    expect(v.getUint32(14, true)).toBe(crc32(entries[0].data))
    expect(v.getUint32(18, true)).toBe(4099)
    expect(v.getUint32(22, true)).toBe(4099)
    expect(v.getUint16(26, true)).toBe(8)
    expect(v.getUint16(28, true)).toBe(0)
    expect(new TextDecoder().decode(zip.subarray(30, 38))).toBe('base.wav')
    expect(Array.from(zip.subarray(38, 38 + 4099))).toEqual(Array.from(entries[0].data))

    // The second entry's local header follows the first entry's data directly.
    expect(v.getUint32(30 + 8 + 4099, true)).toBe(0x04034b50)

    // First central record, pointing back at offset 0.
    expect(v.getUint32(local, true)).toBe(0x02014b50)
    expect(v.getUint16(local + 4, true)).toBe(10)
    expect(v.getUint16(local + 10, true)).toBe(0)
    expect(v.getUint32(local + 16, true)).toBe(crc32(entries[0].data))
    expect(v.getUint32(local + 20, true)).toBe(4099)
    expect(v.getUint32(local + 24, true)).toBe(4099)
    expect(v.getUint32(local + 42, true)).toBe(0)

    // End record: counts, central directory size and offset, no comment.
    const end = zip.length - 22
    expect(v.getUint32(end, true)).toBe(0x06054b50)
    expect(v.getUint16(end + 8, true)).toBe(4)
    expect(v.getUint16(end + 10, true)).toBe(4)
    expect(v.getUint32(end + 12, true)).toBe(central)
    expect(v.getUint32(end + 16, true)).toBe(local)
    expect(v.getUint16(end + 20, true)).toBe(0)
  })

  it('writes an empty archive as a lone end record', () => {
    const zip = zipStore([], WHEN)
    expect(zip.length).toBe(22)
    expect(readZip(zip)).toEqual([])
  })

  it('stores entries given as views at their own offsets', () => {
    const whole = text('--payload--')
    const [file] = readZip(zipStore([{ name: 'p', data: whole.subarray(2, 9) }], WHEN))
    expect(new TextDecoder().decode(file.data)).toBe('payload')
  })

  it('refuses empty and duplicate names', () => {
    expect(() => zipStore([{ name: '', data: new Uint8Array(1) }])).toThrow(RangeError)
    expect(() => zipStore([{ name: 'a', data: new Uint8Array(1) }, { name: 'a', data: new Uint8Array(2) }])).toThrow(/duplicate/)
  })

  it('the reader catches a flipped data byte, a wrong size and a moved header', () => {
    const good = zipStore(entries, WHEN)
    const corrupt = (edit: (z: Uint8Array, v: DataView) => void): Uint8Array => {
      const z = good.slice()
      edit(z, new DataView(z.buffer))
      return z
    }
    expect(() => readZip(corrupt((z) => { z[40] ^= 1 }))).toThrow(/CRC/)
    expect(() => readZip(corrupt((_z, v) => { v.setUint32(22, 4098, true) }))).toThrow(/disagrees/)
    expect(() => readZip(corrupt((z, v) => { v.setUint32(z.length - 22 + 16, 4, true) }))).toThrow()
  })
})
