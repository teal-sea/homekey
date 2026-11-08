// ─── WAV ────────────────────────────────────────────────────────────
// Pure RIFF/WAVE encode and decode, so an exported loop opens in any DAW.
//
// Encoding is straight quantisation: clip to [-1, 1], scale by 2^(bits-1),
// round to nearest, clamp the top code. No dither (no TPDF): at 24 bits the
// error is 2^-24 at most, far below any guitar noise floor, and a
// deterministic encoder lets a round trip be tested exactly. Decoding uses the
// same 2^(bits-1) scale, so every value on the 16- or 24-bit grid survives.

export type BitDepth = 16 | 24

export interface DecodedWav {
  sampleRate: number
  channels: Float32Array[]
}

const PCM = 1
const FLOAT = 3
const EXTENSIBLE = 0xfffe

function writeTag(bytes: Uint8Array, at: number, tag: string): void {
  for (let i = 0; i < 4; i++) bytes[at + i] = tag.charCodeAt(i)
}

function readTag(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
}

/** Nearest code on a signed `full`-scaled grid, clipped to its range. NaN is silence. */
function quantise(x: number, full: number): number {
  if (Number.isNaN(x)) return 0
  const q = Math.round(x * full)
  return q > full - 1 ? full - 1 : q < -full ? -full : q
}

// ─── Encode ───

export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: BitDepth = 24): ArrayBuffer {
  if (channels.length === 0) throw new RangeError('encodeWav needs at least one channel')
  if (bitDepth !== 16 && bitDepth !== 24) throw new RangeError('bitDepth must be 16 or 24')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be a positive integer')
  const frames = channels[0].length
  if (channels.some((c) => c.length !== frames)) throw new RangeError('all channels must have the same length')

  const numChannels = channels.length
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = frames * blockAlign
  const pad = dataSize & 1 // RIFF chunks are word-aligned; 24-bit mono can be odd
  const buffer = new ArrayBuffer(44 + dataSize + pad)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  writeTag(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize + pad, true)
  writeTag(bytes, 8, 'WAVE')
  writeTag(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, PCM, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeTag(bytes, 36, 'data')
  view.setUint32(40, dataSize, true)

  const full = 2 ** (bitDepth - 1)
  let p = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const q = quantise(channels[c][i], full)
      bytes[p] = q & 0xff
      bytes[p + 1] = (q >> 8) & 0xff
      if (bitDepth === 24) bytes[p + 2] = (q >> 16) & 0xff
      p += bytesPerSample
    }
  }
  return buffer
}

// ─── Decode ───

/** Decodes PCM 16/24-bit integer and 32-bit float WAV, including WAVE_FORMAT_EXTENSIBLE. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer)
  if (buffer.byteLength < 12 || readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }

  let format = -1
  let numChannels = 0
  let sampleRate = 0
  let bits = 0
  let blockAlign = 0
  let dataAt = -1
  let dataSize = 0

  // Walk the chunks; LIST, fact, bext and friends are skipped.
  let at = 12
  while (at + 8 <= buffer.byteLength) {
    const id = readTag(view, at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.byteLength) throw new Error('truncated fmt chunk')
      format = view.getUint16(body, true)
      numChannels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      blockAlign = view.getUint16(body + 12, true)
      bits = view.getUint16(body + 14, true)
      // Extensible: the real format code is the first two bytes of the sub-format GUID.
      if (format === EXTENSIBLE && size >= 40 && body + 26 <= buffer.byteLength) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataAt = body
      // Streaming writers leave the size at 0 or 0xFFFFFFFF; trust the file length.
      dataSize = Math.min(size === 0 ? Infinity : size, buffer.byteLength - body)
    }
    at = body + size + (size & 1)
  }

  if (format < 0) throw new Error('no fmt chunk')
  if (dataAt < 0) throw new Error('no data chunk')
  const intPcm = format === PCM && (bits === 16 || bits === 24)
  const float32 = format === FLOAT && bits === 32
  if (!intPcm && !float32) throw new Error(`unsupported WAV: format ${format}, ${bits}-bit`)
  if (numChannels < 1 || blockAlign !== numChannels * (bits / 8)) throw new Error('inconsistent WAV block alignment')

  const frames = Math.floor(dataSize / blockAlign)
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames))
  const bytesPerSample = bits / 8
  const full = 2 ** (bits - 1)
  let p = dataAt
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let v: number
      if (float32) v = view.getFloat32(p, true)
      else if (bits === 16) v = view.getInt16(p, true) / full
      else v = (((view.getUint8(p + 2) << 24) | (view.getUint8(p + 1) << 16) | (view.getUint8(p) << 8)) >> 8) / full
      channels[c][i] = v
      p += bytesPerSample
    }
  }
  return { sampleRate, channels }
}
