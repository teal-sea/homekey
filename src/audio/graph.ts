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
  close(): Promise<void>
}

const RAMP = 0.015 // seconds; short enough to feel instant, long enough not to click

function ramp(param: AudioParam, ctx: BaseAudioContext, value: number): void {
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(value, now + RAMP)
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
    setMonitoring(on) { monitoring = on; ramp(monitorGain.gain, ctx, on ? 1 : 0) },
    isMonitoring: () => monitoring,
    setPanic(muted) { panicked = muted; ramp(master.gain, ctx, muted ? 0 : 1) },
    isPanicked: () => panicked,
    close: () => ctx.close(),
  }
}
