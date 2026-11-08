// Drives public/worklets/recorder.js in Node with a stand-in for the
// AudioWorkletGlobalScope, so the frame arithmetic is tested quantum by quantum.
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Posted { msg: Record<string, unknown> & { type: string }; transfer?: ArrayBuffer[] }
interface Processor {
  port: { posted: Posted[]; onmessage: ((e: { data: unknown }) => void) | null }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

const scope = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const registered: Record<string, new () => unknown> = {}
  g.AudioWorkletProcessor = class {
    port = {
      posted: [] as unknown[],
      onmessage: null as unknown,
      postMessage(msg: unknown, transfer?: unknown[]) { this.posted.push({ msg, transfer }) },
    }
  }
  g.registerProcessor = (name: string, cls: new () => unknown) => { registered[name] = cls }
  g.currentFrame = 0
  return { registered, g }
})

import '../../public/worklets/recorder.js'

const Q = 128

let rec: Processor

beforeEach(() => {
  rec = new (scope.registered['rig-recorder'] as unknown as new () => Processor)()
})

const send = (data: unknown): void => rec.port.onmessage?.({ data })

// Input whose sample values ARE their absolute frame numbers (exact in float32 below 2^24).
function quantum(start: number, channels = 2): Float32Array[] {
  return Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: Q }, (_, i) => (c === 0 ? 1 : -1) * (start + i)))
}

function render(start: number, input: Float32Array[] = quantum(start)): boolean {
  scope.g.currentFrame = start
  return rec.process([input], [[new Float32Array(Q)]])
}

function renderRange(from: number, to: number, skip: (start: number) => boolean = () => false): void {
  for (let f = from; f < to; f += Q) if (!skip(f)) render(f)
}

function assemble(id: number, frames: number): Float32Array[] {
  const out = [new Float32Array(frames), new Float32Array(frames)]
  for (const { msg } of rec.port.posted) {
    if (msg.type !== 'chunk' || msg.id !== id) continue
    const chs = msg.channels as Float32Array[]
    out[0].set(chs[0], msg.offset as number)
    out[1].set(chs[1], msg.offset as number)
  }
  return out
}

const types = (): string[] => rec.port.posted.map((p) => p.msg.type)

describe('rig-recorder', () => {
  it('captures exactly the window, with edges inside render quanta', () => {
    const startFrame = 1024 + 37
    const frames = 5000 // spans the 4096-frame chunk boundary
    send({ type: 'arm', id: 1, startFrame, frames })
    renderRange(896, 8192)
    const chunks = rec.port.posted.filter((p) => p.msg.type === 'chunk')
    expect(chunks.map((p) => [p.msg.offset, (p.msg.channels as Float32Array[])[0].length])).toEqual([[0, 4096], [4096, 904]])
    // Transferred, not copied.
    for (const p of chunks) {
      const chs = p.msg.channels as Float32Array[]
      expect(p.transfer).toEqual([chs[0].buffer, chs[1].buffer])
    }
    const [l, r] = assemble(1, frames)
    for (let t = 0; t < frames; t++) {
      if (l[t] !== startFrame + t || r[t] !== -(startFrame + t)) throw new Error(`frame ${t}: ${l[t]}, ${r[t]}`)
    }
    expect(types()).toEqual(['chunk', 'chunk', 'done'])
    expect(rec.port.posted[2].msg).toEqual({ type: 'done', id: 1, startFrame, frames, discontinuous: false })
  })

  it('copies a mono input to both channels', () => {
    send({ type: 'arm', id: 2, startFrame: 256, frames: 300 })
    for (let f = 256; f < 768; f += Q) render(f, quantum(f, 1))
    const [l, r] = assemble(2, 300)
    expect(l[0]).toBe(256)
    expect(r[299]).toBe(555)
    expect(Array.from(l)).toEqual(Array.from(r))
  })

  it('records silence when the input has no channels (nothing playing upstream)', () => {
    send({ type: 'arm', id: 3, startFrame: 0, frames: 256 })
    render(0, [])
    render(128, [])
    const [l, r] = assemble(3, 256)
    expect(l.every((v) => v === 0) && r.every((v) => v === 0)).toBe(true)
    expect(types()).toEqual(['chunk', 'done'])
  })

  it('reports late when armed after the start frame passed, and records nothing', () => {
    render(0)
    send({ type: 'arm', id: 4, startFrame: 100, frames: 1000 })
    render(128)
    expect(rec.port.posted).toEqual([{ msg: { type: 'late', id: 4, currentFrame: 128 }, transfer: undefined }])
    renderRange(256, 2048)
    expect(types()).toEqual(['late'])
  })

  it('is not late when the start frame is the current quantum', () => {
    send({ type: 'arm', id: 5, startFrame: 128 + 5, frames: 10 })
    render(128)
    expect(types()).toEqual(['chunk', 'done'])
    expect(Array.from(assemble(5, 10)[0])).toEqual(Array.from({ length: 10 }, (_, i) => 133 + i))
  })

  it('marks a take discontinuous when a render quantum inside it goes missing', () => {
    const startFrame = 1000
    send({ type: 'arm', id: 6, startFrame, frames: 2000 })
    renderRange(896, 3200, (f) => f === 1664) // drop one quantum
    const done = rec.port.posted.find((p) => p.msg.type === 'done')
    expect(done?.msg.discontinuous).toBe(true)
    const [l] = assemble(6, 2000)
    // Audio stays at its true position: zeros in the hole, no shift after it.
    expect(l[1664 - startFrame - 1]).toBe(1663)
    expect(l[1664 - startFrame]).toBe(0)
    expect(l[1792 - startFrame]).toBe(1792)
  })

  it('trusts its own frame count when currentFrame repeats a stale value', () => {
    // Measured in Chromium 153: currentFrame reads X twice, then X + 256.
    const startFrame = 1000
    send({ type: 'arm', id: 14, startFrame, frames: 2000 })
    for (let f = 896; f < 3200; f += Q) {
      scope.g.currentFrame = f === 1664 ? 1536 : f // stale for one quantum mid-take
      rec.process([quantum(f)], [[new Float32Array(Q)]])
    }
    const done = rec.port.posted.find((p) => p.msg.type === 'done')
    expect(done?.msg.discontinuous).toBe(false)
    const [l] = assemble(14, 2000)
    for (let t = 0; t < 2000; t++) if (l[t] !== startFrame + t) throw new Error(`frame ${t}: ${l[t]}`)
  })

  it('a stale currentFrame at the first quantum after arm is not mistaken for late', () => {
    render(0)
    render(128)
    send({ type: 'arm', id: 15, startFrame: 256, frames: 128 })
    scope.g.currentFrame = 128 // stale; this quantum is really 256
    rec.process([quantum(256)], [[new Float32Array(Q)]])
    expect(types()).toEqual(['chunk', 'done'])
    expect(assemble(15, 128)[0][0]).toBe(256)
  })

  it('ignores a missing quantum before the window', () => {
    send({ type: 'arm', id: 7, startFrame: 1024, frames: 256 })
    renderRange(0, 2048, (f) => f === 512)
    expect(rec.port.posted.find((p) => p.msg.type === 'done')?.msg.discontinuous).toBe(false)
  })

  it('flushes zero chunks when a gap jumps over whole chunks, then finishes', () => {
    send({ type: 'arm', id: 8, startFrame: 0, frames: 10000 })
    renderRange(0, 1024)
    render(9984) // 8960 frames never rendered
    expect(types()).toEqual(['chunk', 'chunk', 'chunk', 'done'])
    expect(rec.port.posted[3].msg.discontinuous).toBe(true)
  })

  it('cancel stops a take; a stale cancel is ignored', () => {
    send({ type: 'arm', id: 9, startFrame: 0, frames: 10000 })
    renderRange(0, 1024)
    send({ type: 'cancel', id: 8 })
    renderRange(1024, 3968)
    expect(types()).toEqual([])
    render(3968) // completes chunk 0
    expect(types()).toEqual(['chunk'])
    send({ type: 'cancel', id: 9 })
    renderRange(4096, 12000)
    expect(types()).toEqual(['chunk'])
  })

  it('a new arm replaces the take in progress', () => {
    send({ type: 'arm', id: 10, startFrame: 0, frames: 10000 })
    renderRange(0, 512)
    send({ type: 'arm', id: 11, startFrame: 640, frames: 128 })
    renderRange(512, 1024)
    expect(rec.port.posted.map((p) => [p.msg.type, p.msg.id])).toEqual([['chunk', 11], ['done', 11]])
  })

  it('ignores malformed arms and always keeps the node alive', () => {
    send({ type: 'arm', id: 12, startFrame: 1.5, frames: 10 })
    send({ type: 'arm', id: 13, startFrame: 0, frames: 0 })
    expect(render(0)).toBe(true)
    expect(types()).toEqual([])
  })
})
