// ─── Audio input ────────────────────────────────────────────────────
// Opens one audio-input device on the graph's context and splits it into the
// two feeds the rig needs (SPEC "Audio graph"):
//
//   MediaStreamSource ─┬─ ChannelSplitter ── selected channel ─ mono (trim) ─┬─ meter
//                      │                                                    ├─ note follower (pre-amp)
//                      │                                                    └─ tone (amp)
//                      └─ stereo (whole source, for bypass of already-processed input)
//
// The input is an interface with a guitar in it, not a laptop mic, so every
// browser voice stage is requested OFF: echo cancellation "learns" a sustained
// note away, noise suppression eats quiet tails, auto gain pumps the dynamics
// the amp model should see. What the browser actually accepted is read back
// into `settings`, because a request is not a guarantee.
//
// No silent fallback (SPEC rule 5). ModalRuns retried the system default when
// a remembered device had vanished; a rig must not, because "I picked my
// interface and it recorded the laptop mic" is the worst failure a recorder
// can have. Every failure throws InputError and the caller decides.

import type { Graph } from './graph'
import { measureRms } from './pitch'

// ─── Devices ───

export interface InputDevice { deviceId: string; label: string }

type DeviceEntry = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>

// 'default' and 'communications' are OS-preference aliases for a device that
// is also listed under its own ID. The UI offers "System default" itself
// (deviceId null), so the aliases would only be confusing duplicates.
const ALIASES = new Set(['default', 'communications'])

/** Audio inputs without the aliases. Labels stay empty until permission is granted. */
export function audioInputsFrom(devices: readonly DeviceEntry[]): InputDevice[] {
  return devices
    .filter(d => d.kind === 'audioinput' && !ALIASES.has(d.deviceId))
    .map(d => ({ deviceId: d.deviceId, label: d.label }))
}

export async function listInputs(): Promise<InputDevice[]> {
  const md = globalThis.navigator?.mediaDevices
  if (!md?.enumerateDevices) return []
  try {
    return audioInputsFrom(await md.enumerateDevices())
  } catch {
    return []
  }
}

/** Fires when an interface is plugged in or pulled out. Returns an unsubscribe. */
export function onInputsChanged(cb: () => void): () => void {
  const md = globalThis.navigator?.mediaDevices
  if (!md?.addEventListener) return () => {}
  md.addEventListener('devicechange', cb)
  return () => md.removeEventListener('devicechange', cb)
}

/**
 * True when the device the session runs on is gone from a fresh enumeration.
 * Checked against the raw list, aliases included: a track opened on the system
 * default reports deviceId 'default' in Chromium, and that must not read as
 * "vanished" just because someone plugged in a USB stick.
 */
export function deviceVanished(devices: readonly DeviceEntry[], deviceId: string): boolean {
  const inputs = devices.filter(d => d.kind === 'audioinput')
  // Without permission every ID is blank and nothing can be concluded. (An
  // empty list is different: the last input was just unplugged.)
  if (inputs.length > 0 && inputs.every(d => d.deviceId === '')) return false
  return !inputs.some(d => d.deviceId === deviceId)
}

// ─── Errors ───

export type InputErrorKind = 'permission' | 'not-found' | 'busy' | 'overconstrained' | 'unsupported' | 'failed'

export class InputError extends Error {
  readonly kind: InputErrorKind
  /** A sentence the UI can show as-is. */
  readonly userMessage: string

  constructor(kind: InputErrorKind, userMessage: string, cause?: unknown) {
    super(`${kind}: ${userMessage}`, cause === undefined ? undefined : { cause })
    this.name = 'InputError'
    this.kind = kind
    this.userMessage = userMessage
  }
}

const errorName = (err: unknown): string =>
  typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name
    : ''

/** Map a getUserMedia rejection to a message. `deviceId` is what was asked for. */
export function inputErrorFor(err: unknown, deviceId: string | null): InputError {
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new InputError('permission',
        'Audio input access is blocked. Allow the microphone for this page in the browser\'s site settings, then try again.', err)
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new InputError('not-found', deviceId === null
        ? 'No audio input found. Connect your interface, then try again.'
        : 'The selected input is not connected. Plug it in, or choose another input from the list.', err)
    case 'OverconstrainedError': {
      const constraint = (err as { constraint?: unknown }).constraint
      // An exact deviceId that no longer matches means the device is gone (or
      // the browser rotated its IDs after site data was cleared).
      if (deviceId !== null && (constraint === 'deviceId' || constraint === undefined || constraint === '')) {
        return new InputError('not-found',
          'The selected input is no longer available. It may be unplugged, or the browser reset its device list. Choose it again from the list.', err)
      }
      return new InputError('overconstrained',
        `The input cannot be opened with the requested settings${typeof constraint === 'string' && constraint ? ` (${constraint})` : ''}.`, err)
    }
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new InputError('busy',
        'The input is busy or failed to start. Close other apps that use it (a DAW, a video call), then try again.', err)
    default:
      return new InputError('failed', 'The audio input could not be opened.', err)
  }
}

// ─── Constraints and accepted settings ───

export function inputConstraints(deviceId: string | null, channelCount: 1 | 2): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // ideal, not exact: a mono interface must still open, and the channel
      // count it really gave is read back from the settings.
      channelCount: { ideal: channelCount },
      // exact, never ideal: a soft hint would quietly hand back another device.
      ...(deviceId === null ? {} : { deviceId: { exact: deviceId } }),
    },
    video: false,
  }
}

export interface AcceptedSettings {
  deviceId?: string
  label?: string
  channelCount?: number
  sampleRate?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  latency?: number
}

type RawSettings = Omit<MediaTrackSettings, 'echoCancellation'> & { echoCancellation?: unknown; latency?: unknown }

/** Keep only what the browser reported, with the types it promised. */
export function acceptedSettings(raw: RawSettings, label: string): AcceptedSettings {
  const out: AcceptedSettings = {}
  if (typeof raw.deviceId === 'string' && raw.deviceId) out.deviceId = raw.deviceId
  if (label) out.label = label
  if (typeof raw.channelCount === 'number') out.channelCount = raw.channelCount
  if (typeof raw.sampleRate === 'number') out.sampleRate = raw.sampleRate
  // Newer Chromium may report echo cancellation as a mode string
  // ('all', 'remote-only'); any mode other than off means it is on.
  const ec = raw.echoCancellation
  if (typeof ec === 'boolean') out.echoCancellation = ec
  else if (typeof ec === 'string') out.echoCancellation = ec !== 'none' && ec !== 'false'
  if (typeof raw.noiseSuppression === 'boolean') out.noiseSuppression = raw.noiseSuppression
  if (typeof raw.autoGainControl === 'boolean') out.autoGainControl = raw.autoGainControl
  if (typeof raw.latency === 'number') out.latency = raw.latency
  return out
}

// ─── Channels and levels ───

const MAX_CHANNELS = 32 // ChannelSplitter's limit

/**
 * The source's real channel count: what the track reported, else the node's.
 * The node's channelCount is the generic AudioNode attribute (2 by default),
 * so it is a fallback, not a measurement.
 */
export function resolveChannelCount(reported: number | undefined, nodeChannelCount: number): number {
  const n = typeof reported === 'number' && reported > 0 ? reported : nodeChannelCount
  return Math.min(MAX_CHANNELS, Math.max(1, Math.floor(n) || 1))
}

export function checkChannel(index: number, channelCount: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= channelCount) {
    throw new RangeError(`channel ${index} does not exist; this input has ${channelCount} (0-${channelCount - 1})`)
  }
  return index
}

export const dbToGain = (db: number): number => 10 ** (db / 20)

export function levels(buf: Float32Array): { rms: number; peak: number } {
  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > peak) peak = a
  }
  return { rms: measureRms(buf), peak }
}

// ─── Session ───

export interface InputSession {
  source: MediaStreamAudioSourceNode
  channelCount: number
  /** Live: reflects the last setChannel(). */
  readonly selectedChannel: number
  setChannel(i: number): void
  /** Selected channel after trim: feeds analysis and the amp. */
  mono: GainNode
  /** Whole source, for bypass of already-processed input (a GT-1, say). */
  stereo: GainNode
  setTrimDb(db: number): void
  /** Mono path, pre-amp, post-trim. Zeros while the context is not running. */
  meter(): { rms: number; peak: number }
  /** What the browser ACCEPTED, read back from the track. */
  settings: AcceptedSettings
  /** Device unplugged or access revoked. Fires once; the caller shows it and stops. */
  onLost(cb: (reason: string) => void): () => void
  close(): void
}

const TRIM_SMOOTHING = 0.01 // seconds; a dragged trim knob must not zipper
const METER_SIZE = 2048     // ~46 ms at 44.1 kHz, plenty for a UI-rate meter

/**
 * Open `deviceId` exactly, or the system default when null (an explicit user
 * choice, never a fallback). Throws InputError; never tries another device.
 */
export async function openInput(graph: Graph, deviceId: string | null, channelCount: 1 | 2 = 2): Promise<InputSession> {
  const md = globalThis.navigator?.mediaDevices
  if (!md?.getUserMedia) {
    throw new InputError('unsupported',
      'This browser cannot open audio inputs on this page. Use a current Chrome, Edge, Firefox or Safari over https or localhost.')
  }
  // An empty ID is a device the browser has not named yet (no permission).
  // Treating it as "default" would be exactly the silent fallback rule 5 bans.
  if (deviceId === '') {
    throw new InputError('not-found', 'That input has no ID yet. Allow audio input access, then choose it from the list again.')
  }

  let stream: MediaStream
  try {
    stream = await md.getUserMedia(inputConstraints(deviceId, channelCount))
  } catch (err) {
    throw inputErrorFor(err, deviceId)
  }
  const stopTracks = (): void => { for (const t of stream.getTracks()) t.stop() }

  const track = stream.getAudioTracks()[0]
  if (!track) {
    stopTracks()
    throw new InputError('failed', 'The browser opened the input but gave no audio track.')
  }
  const settings = acceptedSettings(track.getSettings(), track.label)
  // Belt and braces for rule 5: `exact` already forbids another device, but a
  // browser that ignored it would otherwise go unnoticed.
  if (deviceId !== null && settings.deviceId !== undefined && settings.deviceId !== deviceId) {
    stopTracks()
    throw new InputError('not-found', 'The browser opened a different input than the one selected, so it was closed. Choose the input again.')
  }

  const { ctx } = graph
  let source: MediaStreamAudioSourceNode
  try {
    source = ctx.createMediaStreamSource(stream)
  } catch (err) {
    stopTracks()
    // Firefox refuses to connect a track whose rate differs from the context's.
    const rates = settings.sampleRate && settings.sampleRate !== ctx.sampleRate
      ? ` The input runs at ${settings.sampleRate} Hz and the audio engine at ${ctx.sampleRate} Hz; set both to the same rate.`
      : ''
    throw new InputError('failed', `The input opened but could not be connected to the audio engine.${rates}`, err)
  }

  const count = resolveChannelCount(settings.channelCount, source.channelCount)
  const splitter = ctx.createChannelSplitter(count)

  const mono = ctx.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'discrete'

  const stereo = ctx.createGain()
  stereo.channelCount = 2
  stereo.channelCountMode = 'explicit'
  stereo.channelInterpretation = 'speakers' // a mono source lands on both sides

  const meterTap = ctx.createAnalyser()
  meterTap.fftSize = METER_SIZE
  meterTap.smoothingTimeConstant = 0
  const meterBuf = new Float32Array(METER_SIZE)

  let selected = 0
  source.connect(splitter)
  splitter.connect(mono, selected, 0)
  mono.connect(meterTap)
  source.connect(stereo)

  // ─── Device loss ───
  let closed = false
  let lostReason: string | null = null
  const lostListeners = new Set<(reason: string) => void>()
  const declareLost = (reason: string): void => {
    if (closed || lostReason !== null) return
    lostReason = reason
    for (const cb of [...lostListeners]) cb(reason)
  }
  const onEnded = (): void => declareLost('The input stopped: the device was unplugged, or access to it was revoked.')
  const onDeviceChange = async (): Promise<void> => {
    const id = settings.deviceId
    if (!id || closed || lostReason !== null) return
    let devices: MediaDeviceInfo[]
    try {
      devices = await md.enumerateDevices()
    } catch {
      return // can't tell; the track's 'ended' still covers a real unplug
    }
    if (deviceVanished(devices, id)) declareLost('The input was disconnected.')
  }
  track.addEventListener('ended', onEnded)
  md.addEventListener?.('devicechange', onDeviceChange)

  return {
    source,
    channelCount: count,
    get selectedChannel() { return selected },
    setChannel(i) {
      checkChannel(i, count)
      if (closed || i === selected) return
      splitter.disconnect(mono, selected, 0)
      splitter.connect(mono, i, 0)
      selected = i
    },
    mono,
    stereo,
    setTrimDb(db) {
      if (!Number.isFinite(db)) throw new RangeError(`trim must be a finite dB value, got ${db}`)
      mono.gain.setTargetAtTime(dbToGain(db), ctx.currentTime, TRIM_SMOOTHING)
    },
    meter() {
      // A suspended context leaves the analyser holding its last block.
      if (closed || ctx.state !== 'running') return { rms: 0, peak: 0 }
      meterTap.getFloatTimeDomainData(meterBuf)
      return levels(meterBuf)
    },
    settings,
    onLost(cb) {
      lostListeners.add(cb)
      // Lost before anyone subscribed (between open and onLost): still report it.
      if (lostReason !== null) {
        const reason = lostReason
        queueMicrotask(() => { if (lostListeners.has(cb)) cb(reason) })
      }
      return () => { lostListeners.delete(cb) }
    },
    close() {
      if (closed) return
      closed = true
      track.removeEventListener('ended', onEnded)
      md.removeEventListener?.('devicechange', onDeviceChange)
      lostListeners.clear()
      stopTracks()
      // Disconnecting mono and stereo also drops whatever the tone and the
      // note follower hung off them: a closed input leaves the graph entirely.
      for (const node of [source, splitter, mono, stereo, meterTap]) {
        try { node.disconnect() } catch { /* already disconnected */ }
      }
    },
  }
}
