// ─── Audio graph ────────────────────────────────────────────────────
// Owns the one AudioContext and every bus. Other modules receive a Graph
// and connect into its nodes; none of them creates a context (SPEC rule 1).
//
//   guitarBus ─┬─ (recorder taps here, see looper.ts)
//              └─ monitorGain ─ master
//   loopBus, droneBus, clickBus ─ master
//   master ─ limiter ─ destination

export interface Graph {
  ctx: AudioContext
  /** Everything the player hears from the guitar, stereo. The recorder taps this bus only. */
  guitarBus: GainNode
  /** Gain between guitarBus and master. 0 = monitoring off (the default). */
  monitorGain: GainNode
  loopBus: GainNode
  droneBus: GainNode
  clickBus: GainNode
  /** Sum of all buses, before the limiter. Panic mute sets this to 0. */
  master: GainNode
  limiter: DynamicsCompressorNode
  /** The context's render quantum, or 128 when the browser does not report one. */
  renderQuantum: number
  /** False when the render quantum is not 128: the NAM worklet then passes dry audio (SPEC rule 7). */
  ampSupported: boolean
  setMonitoring(on: boolean): void
  isMonitoring(): boolean
  setPanic(muted: boolean): void
  isPanicked(): boolean
}

// ─── Gain automation ───
// The one gain glide every module uses, so they all move a gain the same way.

/** Seconds: short enough to feel instant, long enough not to click. */
export const RAMP = 0.015

/**
 * Glide `param` from wherever it is now to `value`, on the audio clock. The
 * current value is read BEFORE cancelling: once a glide in flight is
 * cancelled, `value` may report where that glide started rather than where it
 * got to, and the new glide would jump back first.
 */
export function rampTo(param: AudioParam, ctx: BaseAudioContext, value: number, seconds = RAMP): void {
  const now = ctx.currentTime
  const from = param.value
  param.cancelScheduledValues(now)
  param.setValueAtTime(from, now)
  param.linearRampToValueAtTime(value, now + seconds)
}

/** Create the context and buses. Call from a user gesture (autoplay policy). */
export function createGraph(options: { sampleRate?: number } = {}): Graph {
  const ctx = new AudioContext({ latencyHint: 'interactive', ...(options.sampleRate ? { sampleRate: options.sampleRate } : {}) })

  const stereo = (gain = 1): GainNode => {
    const node = ctx.createGain()
    node.gain.value = gain
    node.channelCount = 2
    node.channelCountMode = 'explicit'
    node.channelInterpretation = 'speakers'
    return node
  }

  const guitarBus = stereo()
  const monitorGain = stereo(0)
  const loopBus = stereo()
  const droneBus = stereo()
  const clickBus = stereo()
  const master = stereo()

  // A safety net, not a tone stage: guitar, loop, drone and click can sum past
  // full scale, and an over at the destination clips harshly. -3 dB leaves
  // normal levels untouched; 12:1 (the node's maximum is 20) with a 2 ms attack
  // holds a peak down within a few ms; the 120 ms release keeps it from pumping.
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 2
  limiter.ratio.value = 12
  limiter.attack.value = 0.002
  limiter.release.value = 0.12

  guitarBus.connect(monitorGain).connect(master)
  loopBus.connect(master)
  droneBus.connect(master)
  clickBus.connect(master)
  master.connect(limiter).connect(ctx.destination)

  const reported = (ctx as AudioContext & { renderQuantumSize?: number }).renderQuantumSize
  const renderQuantum = typeof reported === 'number' ? reported : 128

  let monitoring = false
  let panicked = false

  return {
    ctx, guitarBus, monitorGain, loopBus, droneBus, clickBus, master, limiter,
    renderQuantum,
    ampSupported: renderQuantum === 128,
    setMonitoring(on) { monitoring = on; rampTo(monitorGain.gain, ctx, on ? 1 : 0) },
    isMonitoring: () => monitoring,
    setPanic(muted) { panicked = muted; rampTo(master.gain, ctx, muted ? 0 : 1) },
    isPanicked: () => panicked,
  }
}
