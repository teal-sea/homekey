import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav } from './wav'

const tag = (v: DataView, at: number): string =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))

// A deterministic, full-range test signal with values off the quantisation grid.
function signal(frames: number, seed: number): Float32Array {
  const out = new Float32Array(frames)
  let x = seed
  for (let i = 0; i < frames; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    out[i] = (x / 2147483648) * 1.98 - 0.99
  }
  return out
}

describe('encodeWav header', () => {
  it('writes a canonical 44-byte PCM header', () => {
    const buf = encodeWav([new Float32Array(1000), new Float32Array(1000)], 48000, 24)
    const v = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 1000 * 6)
    expect(tag(v, 0)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8)
    expect(tag(v, 8)).toBe('WAVE')
    expect(tag(v, 12)).toBe('fmt ')
    expect(v.getUint32(16, true)).toBe(16)
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(28, true)).toBe(48000 * 6) // byte rate
    expect(v.getUint16(32, true)).toBe(6) // block align
    expect(v.getUint16(34, true)).toBe(24)
    expect(tag(v, 36)).toBe('data')
    expect(v.getUint32(40, true)).toBe(6000)
  })

  it('16-bit stereo header fields', () => {
    const v = new DataView(encodeWav([new Float32Array(10), new Float32Array(10)], 44100, 16))
    expect(v.getUint32(28, true)).toBe(44100 * 4)
    expect(v.getUint16(32, true)).toBe(4)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(40)
  })

  it('pads an odd-sized data chunk to a word boundary (24-bit mono)', () => {
    const buf = encodeWav([new Float32Array(3)], 44100, 24)
    const v = new DataView(buf)
    expect(v.getUint32(40, true)).toBe(9)
    expect(buf.byteLength).toBe(44 + 9 + 1)
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8)
    expect(decodeWav(buf).channels[0].length).toBe(3)
  })

  it('rejects mismatched channels and bad arguments', () => {
    expect(() => encodeWav([], 44100)).toThrow()
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 44100)).toThrow()
    expect(() => encodeWav([new Float32Array(2)], 44100.5)).toThrow()
    expect(() => encodeWav([new Float32Array(2)], 44100, 8 as 16)).toThrow()
  })
})

describe('round trip', () => {
  for (const bits of [16, 24] as const) {
    it(`${bits}-bit stays within half a step of the input`, () => {
      const frames = 20000
      const input = [signal(frames, 1), signal(frames, 2)]
      const out = decodeWav(encodeWav(input, 48000, bits))
      expect(out.sampleRate).toBe(48000)
      expect(out.channels.length).toBe(2)
      const step = 2 ** -(bits - 1)
      let worst = 0
      for (let c = 0; c < 2; c++) {
        expect(out.channels[c].length).toBe(frames)
        for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(out.channels[c][i] - input[c][i]))
      }
      // Rounding to nearest: at most half a step, plus float32 storage of the input.
      expect(worst).toBeLessThanOrEqual(step / 2 + 1e-7)
      expect(worst).toBeGreaterThan(0)
    })

    it(`${bits}-bit is exact for values already on the grid`, () => {
      const full = 2 ** (bits - 1)
      const codes = [-full, -full + 1, -12345, -1, 0, 1, 777, full - 1]
      const input = [Float32Array.from(codes, (q) => q / full)]
      const out = decodeWav(encodeWav(input, 44100, bits)).channels[0]
      expect(Array.from(out)).toEqual(Array.from(input[0]))
    })
  }

  it('clips out-of-range input instead of wrapping, and maps NaN to silence', () => {
    const input = [Float32Array.from([1, 1.5, -1, -3, Number.NaN, 0.5])]
    const out = decodeWav(encodeWav(input, 44100, 24)).channels[0]
    const top = (2 ** 23 - 1) / 2 ** 23
    expect(Array.from(out)).toEqual([top, top, -1, -1, 0, 0.5])
    const out16 = decodeWav(encodeWav(input, 44100, 16)).channels[0]
    expect(out16[1]).toBe((2 ** 15 - 1) / 2 ** 15)
    expect(out16[3]).toBe(-1)
  })

  it('keeps channel order (interleaving)', () => {
    const l = Float32Array.from([0.25, 0.5])
    const r = Float32Array.from([-0.25, -0.5])
    const out = decodeWav(encodeWav([l, r], 44100, 16)).channels
    expect(Array.from(out[0])).toEqual([0.25, 0.5])
    expect(Array.from(out[1])).toEqual([-0.25, -0.5])
  })
})

// ─── Files from other writers ───

interface Chunk { id: string; body: Uint8Array }

function riff(chunks: Chunk[]): ArrayBuffer {
  const size = chunks.reduce((n, c) => n + 8 + c.body.length + (c.body.length & 1), 4)
  const buf = new ArrayBuffer(8 + size)
  const v = new DataView(buf)
  const bytes = new Uint8Array(buf)
  const put = (at: number, s: string): void => { for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i) }
  put(0, 'RIFF')
  v.setUint32(4, size, true)
  put(8, 'WAVE')
  let at = 12
  for (const c of chunks) {
    put(at, c.id)
    v.setUint32(at + 4, c.body.length, true)
    bytes.set(c.body, at + 8)
    at += 8 + c.body.length + (c.body.length & 1)
  }
  return buf
}

function fmt(format: number, channels: number, rate: number, bits: number, extensibleCode?: number): Uint8Array {
  const body = new Uint8Array(extensibleCode === undefined ? 16 : 40)
  const v = new DataView(body.buffer)
  v.setUint16(0, format, true)
  v.setUint16(2, channels, true)
  v.setUint32(4, rate, true)
  v.setUint32(8, rate * channels * bits / 8, true)
  v.setUint16(12, channels * bits / 8, true)
  v.setUint16(14, bits, true)
  if (extensibleCode !== undefined) {
    v.setUint16(16, 22, true)
    v.setUint16(18, bits, true)
    v.setUint16(24, extensibleCode, true)
  }
  return body
}

describe('decodeWav', () => {
  it('reads 32-bit float, skipping unknown and odd-sized chunks', () => {
    const data = new Float32Array([0.125, -0.75, 1.5, -2])
    const buf = riff([
      { id: 'JUNK', body: new Uint8Array(3) },
      { id: 'fmt ', body: fmt(3, 2, 96000, 32) },
      { id: 'LIST', body: new Uint8Array(10) },
      { id: 'data', body: new Uint8Array(data.buffer) },
    ])
    const out = decodeWav(buf)
    expect(out.sampleRate).toBe(96000)
    expect(Array.from(out.channels[0])).toEqual([0.125, 1.5])
    expect(Array.from(out.channels[1])).toEqual([-0.75, -2]) // float is passed through, not clipped
  })

  it('reads WAVE_FORMAT_EXTENSIBLE PCM', () => {
    const pcm = new Int16Array([16384, -16384])
    const out = decodeWav(riff([
      { id: 'fmt ', body: fmt(0xfffe, 1, 44100, 16, 1) },
      { id: 'data', body: new Uint8Array(pcm.buffer) },
    ]))
    expect(Array.from(out.channels[0])).toEqual([0.5, -0.5])
  })

  it('trusts the file length when a streaming writer left the data size open', () => {
    const buf = encodeWav([Float32Array.from([0.5, -0.5, 0.25])], 44100, 16)
    new DataView(buf).setUint32(40, 0xffffffff, true)
    expect(Array.from(decodeWav(buf).channels[0])).toEqual([0.5, -0.5, 0.25])
  })

  it('rejects what it cannot read', () => {
    expect(() => decodeWav(new ArrayBuffer(4))).toThrow(/RIFF/)
    expect(() => decodeWav(riff([{ id: 'data', body: new Uint8Array(4) }]))).toThrow(/fmt/)
    expect(() => decodeWav(riff([{ id: 'fmt ', body: fmt(1, 1, 44100, 16) }]))).toThrow(/data/)
    expect(() => decodeWav(riff([
      { id: 'fmt ', body: fmt(1, 1, 44100, 8) },
      { id: 'data', body: new Uint8Array(4) },
    ]))).toThrow(/unsupported/)
    expect(() => decodeWav(riff([
      { id: 'fmt ', body: fmt(6, 1, 8000, 8) }, // A-law
      { id: 'data', body: new Uint8Array(4) },
    ]))).toThrow(/unsupported/)
  })
})
