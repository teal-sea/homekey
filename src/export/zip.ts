// ─── ZIP ────────────────────────────────────────────────────────────
// A store-only ZIP writer, so Export hands over one file instead of four
// separate downloads (a browser may stop to ask permission after the first).
//
// Every entry is stored as is: no compression, no data descriptors, no ZIP64,
// no extra fields. That is the oldest subset of the format (APPNOTE 4.3, 4.4),
// which every unzip tool reads. Deflate would
// save little on PCM audio and would need a compressor this repo does not
// have; the sizes and CRCs are known up front because the take is already in
// memory. Pure, so it is tested without a browser.

export interface ZipEntry {
  /** Path inside the archive, '/'-separated; stored as UTF-8. */
  name: string
  data: Uint8Array
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const LOCAL_SIZE = 30
const CENTRAL_SIZE = 46
const END_SIZE = 22
// Version 1.0 both "made by" (high byte 0: an MS-DOS-style host, so no Unix
// permissions to get wrong) and "needed": stored entries need nothing newer.
const VERSION = 10
const UTF8_NAMES = 0x0800 // general purpose flag bit 11
const STORED = 0
const MAX_U16 = 0xffff
const MAX_U32 = 0xffffffff

// ─── CRC-32 ───

// The IEEE 802.3 polynomial, reflected: the CRC that ZIP, PNG and gzip use.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 of `data` as an unsigned 32-bit number. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ─── Timestamps ───

/**
 * ZIP's mandatory timestamp: MS-DOS date and time fields, in local time, to
 * 2 seconds. It can hold 1980 to 2107 only, so a date outside that (or an
 * invalid one) is clamped rather than wrapped into nonsense.
 */
export function dosDateTime(when: Date): { date: number; time: number } {
  const year = when.getFullYear()
  if (!(year >= 1980)) return { date: (1 << 5) | 1, time: 0 }
  if (year > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 }
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  }
}

// ─── Writer ───

/**
 * The entries, in order, as one store-only archive. Names must be unique and
 * non-empty. Throws past ZIP's 32-bit limits (4 GiB, 65,535 entries) rather
 * than write a file nothing can open; a take is a few tens of MB at most.
 */
export function zipStore(entries: readonly ZipEntry[], modified: Date = new Date()): Uint8Array {
  if (entries.length > MAX_U16) throw new RangeError(`a zip without ZIP64 holds at most ${MAX_U16} entries`)
  const encoder = new TextEncoder()
  const names = entries.map((e) => encoder.encode(e.name))
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    if (names[i].length === 0 || names[i].length > MAX_U16) throw new RangeError(`bad zip entry name: "${e.name}"`)
    if (seen.has(e.name)) throw new RangeError(`duplicate zip entry name: "${e.name}"`)
    seen.add(e.name)
  })

  let total = END_SIZE
  entries.forEach((e, i) => { total += LOCAL_SIZE + CENTRAL_SIZE + 2 * names[i].length + e.data.length })
  if (total > MAX_U32) throw new RangeError('a zip without ZIP64 must stay under 4 GiB')

  const { date, time } = dosDateTime(modified)
  const crcs = entries.map((e) => crc32(e.data))
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  const u16 = (at: number, v: number): void => view.setUint16(at, v, true)
  const u32 = (at: number, v: number): void => view.setUint32(at, v, true)

  // The fields a local header and its central directory record share, in the
  // same order in both (local offset 4 = central offset 6).
  const shared = (at: number, i: number): void => {
    u16(at, VERSION) // needed to extract
    u16(at + 2, UTF8_NAMES)
    u16(at + 4, STORED)
    u16(at + 6, time)
    u16(at + 8, date)
    u32(at + 10, crcs[i])
    u32(at + 14, entries[i].data.length) // compressed size: stored, so the same
    u32(at + 18, entries[i].data.length)
    u16(at + 22, names[i].length)
    u16(at + 24, 0) // no extra field
  }

  const offsets: number[] = []
  let at = 0
  entries.forEach((e, i) => {
    offsets.push(at)
    u32(at, LOCAL_HEADER)
    shared(at + 4, i)
    out.set(names[i], at + LOCAL_SIZE)
    out.set(e.data, at + LOCAL_SIZE + names[i].length)
    at += LOCAL_SIZE + names[i].length + e.data.length
  })

  const central = at
  entries.forEach((_e, i) => {
    u32(at, CENTRAL_HEADER)
    u16(at + 4, VERSION) // made by
    shared(at + 6, i)
    // Comment length, disk number, internal and external attributes stay 0.
    u32(at + 42, offsets[i])
    out.set(names[i], at + CENTRAL_SIZE)
    at += CENTRAL_SIZE + names[i].length
  })

  u32(at, END_OF_CENTRAL_DIRECTORY)
  // This disk and the central directory's disk are both 0: one file, no spanning.
  u16(at + 8, entries.length)
  u16(at + 10, entries.length)
  u32(at + 12, at - central)
  u32(at + 16, central)
  // No archive comment, so the end record is the last 22 bytes.
  return out
}
