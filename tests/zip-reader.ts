// ─── ZIP reader, for tests only ─────────────────────────────────────
// Opens the store-only archives src/export/zip.ts writes, for the unit tests
// and the browser tests, without a dependency. It does not trust the writer:
// it starts from the end record, walks the central directory, checks every
// local header against its central record, and recomputes each CRC with its
// own bit-by-bit CRC-32 instead of the writer's table. Anything the writer
// never produces (compression, data descriptors, ZIP64, comments, extra
// fields, gaps or overlaps between entries) is refused rather than skipped.

export interface ZipFile {
  name: string
  data: Uint8Array
  crc32: number
  flags: number
  /** Raw MS-DOS time and date fields, as stored. */
  dosTime: number
  dosDate: number
  /** Where this entry's local header starts. */
  offset: number
}

/** CRC-32 one bit at a time: slow, but shares no code or table with the writer. */
export function crc32Bitwise(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

export function readZip(bytes: Uint8Array): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number): number => view.getUint16(at, true)
  const u32 = (at: number): number => view.getUint32(at, true)
  const fail = (why: string): never => { throw new Error(`zip: ${why}`) }

  if (bytes.length < 22) fail('too short for an end record')
  const end = bytes.length - 22
  if (u32(end) !== 0x06054b50) fail('no end record in the last 22 bytes')
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0) fail('spans several disks')
  const count = u16(end + 8)
  if (u16(end + 10) !== count) fail('entry counts disagree')
  const centralSize = u32(end + 12)
  const central = u32(end + 16)
  if (u16(end + 20) !== 0) fail('has an archive comment')
  if (central + centralSize !== end) fail('central directory does not end at the end record')

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const files: ZipFile[] = []
  let at = central
  let next = 0 // where the next local header must start: entries are back to back from byte 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) fail(`central record ${i}: bad signature`)
    const flags = u16(at + 8)
    const crc = u32(at + 16)
    const size = u32(at + 24)
    const nameLength = u16(at + 28)
    const offset = u32(at + 42)
    if (u16(at + 10) !== 0) fail(`entry ${i}: compressed (method ${u16(at + 10)})`)
    if (flags & 0x0008) fail(`entry ${i}: uses a data descriptor`)
    if (u32(at + 20) !== size) fail(`entry ${i}: stored, but its two sizes differ`)
    if (u16(at + 30) !== 0 || u16(at + 32) !== 0) fail(`entry ${i}: extra field or comment`)
    if (offset !== next) fail(`entry ${i}: local header at ${offset}, expected ${next}`)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))

    if (u32(offset) !== 0x04034b50) fail(`${name}: bad local header signature`)
    // Local bytes 4-29 and central bytes 6-31 are the same fields in the same
    // order (version needed, flags, method, time, date, CRC, both sizes, name
    // and extra lengths), so they must match byte for byte.
    for (let k = 0; k < 26; k++) {
      if (bytes[offset + 4 + k] !== bytes[at + 6 + k]) fail(`${name}: local header byte ${4 + k} disagrees with the central directory`)
    }
    for (let k = 0; k < nameLength; k++) {
      if (bytes[offset + 30 + k] !== bytes[at + 46 + k]) fail(`${name}: local header name disagrees`)
    }
    const start = offset + 30 + nameLength
    if (start + size > central) fail(`${name}: data runs into the central directory`)
    const data = bytes.subarray(start, start + size)
    if (crc32Bitwise(data) !== crc) fail(`${name}: CRC mismatch`)
    if (files.some((f) => f.name === name)) fail(`${name}: duplicate name`)
    files.push({ name, data, crc32: crc, flags, dosTime: u16(at + 12), dosDate: u16(at + 14), offset })
    next = start + size
    at += 46 + nameLength
  }
  if (next !== central) fail('bytes between the last entry and the central directory')
  if (at !== end) fail('central directory size does not match its records')
  return files
}
