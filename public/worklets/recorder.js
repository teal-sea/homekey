// ─── rig-recorder ───────────────────────────────────────────────────
// Frame-exact capture of the guitar bus (SPEC "Recorder worklet protocol").
// Plain JS: worklets load as same-origin files, never Blob URLs (SPEC rule 8).
//
// Main → worklet: { type: 'arm', id, startFrame, frames }, { type: 'cancel', id }
// Worklet → main: { type: 'chunk', id, offset, channels: [L, R] } (transferred)
//                 { type: 'done', id, startFrame, frames, discontinuous }
//                 { type: 'late', id, currentFrame }
//
// The window is absolute context frames [startFrame, startFrame + frames), so
// it is compared against the audio thread's own frame, never against a
// main-thread clock: a stalled main thread can delay the chunks, not move the
// window.

const CHUNK = 4096 // ~93 ms at 44.1 kHz per message

class RigRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.take = null
    this.expected = -1 // the frame the next process() call renders, by our own count
    this.port.onmessage = (e) => this.message(e.data)
  }

  message(msg) {
    if (msg.type === 'arm') {
      const { id, startFrame, frames } = msg
      if (!Number.isInteger(startFrame) || !Number.isInteger(frames) || frames <= 0) return
      // A new arm replaces any take in progress; the looper only runs one at a time.
      this.take = {
        id, startFrame, frames,
        chunks: new Array(Math.ceil(frames / CHUNK)).fill(null),
        sent: 0, checked: false, discontinuous: false,
      }
      // Storage for the first chunk exists before its audio does.
      this.chunk(0)
    } else if (msg.type === 'cancel' && this.take && this.take.id === msg.id) {
      this.take = null
    }
  }

  // Chunk storage is allocated one chunk (32 render quanta) at a time, not
  // for the whole take at arm: a 940,000-frame take is 230 chunk pairs and
  // allocating them all at once took 3.7 ms in V8 (measured in Node on the dev
  // container), more than one render quantum's budget on the audio thread.
  chunk(c) {
    const take = this.take
    let pair = take.chunks[c]
    if (pair === null) {
      const n = Math.min(CHUNK, take.frames - c * CHUNK)
      pair = [new Float32Array(n), new Float32Array(n)]
      take.chunks[c] = pair
    }
    return pair
  }

  process(inputs, outputs) {
    const n = outputs[0][0].length
    // Chromium 153 sometimes leaves `currentFrame` at the previous quantum's
    // value for one call and catches up on the next (measured 2026-11-08:
    // frame X twice, then X + 256, 10 times in 18 s; cause not confirmed).
    // Audio is rendered in order, so a reading behind our own count is stale,
    // not time travel: trust the count. A reading AHEAD of it is a real gap.
    const reported = currentFrame
    const skippedFrom = this.expected
    const start = skippedFrom < 0 ? reported : Math.max(reported, skippedFrom)
    this.expected = start + n

    const take = this.take
    if (take === null) return true
    const end = take.startFrame + take.frames

    if (!take.checked) {
      take.checked = true
      if (start > take.startFrame) {
        this.port.postMessage({ type: 'late', id: take.id, currentFrame: start })
        this.take = null
        return true
      }
    } else if (skippedFrom >= 0 && start !== skippedFrom) {
      // Render quanta went missing: [skippedFrom, start) never reached us. The
      // take keeps zeros there and says so instead of shifting audio in time.
      if (skippedFrom < end && start > take.startFrame) take.discontinuous = true
    }

    const from = Math.max(start, take.startFrame)
    const to = Math.min(start + n, end)
    if (to > from) this.copy(inputs[0], start, from, to)

    const covered = Math.min(start + n, end) - take.startFrame
    this.flush(covered)
    if (covered >= take.frames) {
      this.port.postMessage({
        type: 'done', id: take.id, startFrame: take.startFrame, frames: take.frames,
        discontinuous: take.discontinuous,
      })
      this.take = null
    }
    return true
  }

  // Copy context frames [from, to) of this quantum into the take. A window
  // edge can fall anywhere inside a quantum; only the overlap is copied.
  copy(input, quantumStart, from, to) {
    const take = this.take
    // An input with no active sources has zero channels: leave the zeros.
    if (input.length === 0) return
    const left = input[0]
    const right = input.length > 1 ? input[1] : input[0] // mono is copied to both
    let f = from
    while (f < to) {
      const pos = f - take.startFrame
      const c = Math.floor(pos / CHUNK)
      const segEnd = Math.min(to, take.startFrame + (c + 1) * CHUNK)
      const pair = this.chunk(c)
      const at = pos - c * CHUNK
      pair[0].set(left.subarray(f - quantumStart, segEnd - quantumStart), at)
      pair[1].set(right.subarray(f - quantumStart, segEnd - quantumStart), at)
      f = segEnd
    }
  }

  // Post every chunk that lies wholly inside the first `covered` frames.
  flush(covered) {
    const take = this.take
    while (take.sent < take.chunks.length) {
      const c = take.sent
      const chunkEnd = Math.min((c + 1) * CHUNK, take.frames)
      if (chunkEnd > covered) break
      const [l, r] = this.chunk(c)
      take.chunks[c] = null
      take.sent++
      this.port.postMessage({ type: 'chunk', id: take.id, offset: c * CHUNK, channels: [l, r] }, [l.buffer, r.buffer])
    }
  }
}

registerProcessor('rig-recorder', RigRecorder)
