import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InputError, acceptedSettings, audioInputsFrom, checkChannel, deviceVanished,
  inputConstraints, inputErrorFor, levels, openInput, resolveChannelCount,
} from './input'
import type { Graph } from './graph'

const dev = (deviceId: string, label = '', kind: MediaDeviceKind = 'audioinput') => ({ deviceId, label, kind })

// ─── Pure helpers ───

describe('audioInputsFrom', () => {
  it('keeps audio inputs only and drops the default/communications aliases', () => {
    const list = audioInputsFrom([
      dev('default', 'Default - Scarlett 2i2'),
      dev('communications', 'Communications - Built-in'),
      dev('abc', 'Scarlett 2i2 USB'),
      dev('out1', 'Speakers', 'audiooutput'),
      dev('cam', 'FaceTime', 'videoinput'),
      dev('def', 'Built-in Microphone'),
    ])
    expect(list).toEqual([
      { deviceId: 'abc', label: 'Scarlett 2i2 USB' },
      { deviceId: 'def', label: 'Built-in Microphone' },
    ])
  })

  it('keeps empty labels as empty (before permission there are no names)', () => {
    expect(audioInputsFrom([dev('abc')])).toEqual([{ deviceId: 'abc', label: '' }])
  })
})

describe('deviceVanished', () => {
  const list = [dev('default'), dev('abc'), dev('out', '', 'audiooutput')]
  it('is false while the device is listed', () => expect(deviceVanished(list, 'abc')).toBe(false))
  it('is true once it is gone', () => expect(deviceVanished(list, 'xyz')).toBe(true))
  it('treats the default alias as present while listed', () => expect(deviceVanished(list, 'default')).toBe(false))
  it('ignores outputs with the same ID', () => expect(deviceVanished([dev('abc', '', 'audiooutput')], 'abc')).toBe(true))
  it('concludes nothing when every ID is blank', () => expect(deviceVanished([dev(''), dev('')], 'abc')).toBe(false))
  it('is true when the last input was unplugged', () => expect(deviceVanished([], 'abc')).toBe(true))
})

describe('inputErrorFor', () => {
  const err = (name: string, extra: object = {}) => Object.assign(new Error(name), { name }, extra)

  it.each([
    ['NotAllowedError', 'permission'],
    ['PermissionDeniedError', 'permission'],
    ['SecurityError', 'permission'],
    ['NotFoundError', 'not-found'],
    ['DevicesNotFoundError', 'not-found'],
    ['NotReadableError', 'busy'],
    ['TrackStartError', 'busy'],
    ['AbortError', 'busy'],
    ['TypeError', 'failed'],
  ])('%s -> %s', (name, kind) => {
    const e = inputErrorFor(err(name), 'abc')
    expect(e).toBeInstanceOf(InputError)
    expect(e.kind).toBe(kind)
    expect(e.userMessage.length).toBeGreaterThan(10)
  })

  it('an exact deviceId that no longer matches reads as not found', () => {
    const e = inputErrorFor(err('OverconstrainedError', { constraint: 'deviceId' }), 'abc')
    expect(e.kind).toBe('not-found')
    expect(e.userMessage).toMatch(/no longer available/)
  })

  it('other overconstraints name the constraint', () => {
    const e = inputErrorFor(err('OverconstrainedError', { constraint: 'sampleRate' }), null)
    expect(e.kind).toBe('overconstrained')
    expect(e.userMessage).toMatch(/sampleRate/)
  })

  it('distinguishes "no input at all" from "the selected input is missing"', () => {
    expect(inputErrorFor(err('NotFoundError'), null).userMessage).toMatch(/No audio input found/)
    expect(inputErrorFor(err('NotFoundError'), 'abc').userMessage).toMatch(/selected input/)
  })

  it('keeps the original error as the cause', () => {
    const original = err('NotAllowedError')
    expect(inputErrorFor(original, null).cause).toBe(original)
  })

  it('copes with non-Error rejections', () => {
    expect(inputErrorFor('weird', null).kind).toBe('failed')
    expect(inputErrorFor(null, null).kind).toBe('failed')
  })
})

describe('inputConstraints', () => {
  it('turns every voice stage off and asks for the channel count as ideal', () => {
    expect(inputConstraints(null, 2)).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
      video: false,
    })
  })

  it('pins a chosen device with exact, never ideal', () => {
    const audio = inputConstraints('abc', 1).audio as MediaTrackConstraints
    expect(audio.deviceId).toEqual({ exact: 'abc' })
    expect(audio.channelCount).toEqual({ ideal: 1 })
  })
})

describe('acceptedSettings', () => {
  it('copies what the browser reported', () => {
    expect(acceptedSettings({
      deviceId: 'abc', channelCount: 2, sampleRate: 48000,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0.01,
    }, 'Scarlett 2i2')).toEqual({
      deviceId: 'abc', label: 'Scarlett 2i2', channelCount: 2, sampleRate: 48000,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0.01,
    })
  })

  it('leaves out what was not reported instead of guessing', () => {
    expect(acceptedSettings({}, '')).toEqual({})
  })

  it('reads an echo-cancellation mode string as on, unless it says off', () => {
    expect(acceptedSettings({ echoCancellation: 'all' }, '').echoCancellation).toBe(true)
    expect(acceptedSettings({ echoCancellation: 'remote-only' }, '').echoCancellation).toBe(true)
    expect(acceptedSettings({ echoCancellation: 'none' }, '').echoCancellation).toBe(false)
  })
})

describe('channels and levels', () => {
  it('prefers the reported channel count, falls back to the node, clamps to 1..32', () => {
    expect(resolveChannelCount(1, 2)).toBe(1)
    expect(resolveChannelCount(undefined, 2)).toBe(2)
    expect(resolveChannelCount(0, 2)).toBe(2)
    expect(resolveChannelCount(64, 2)).toBe(32)
    expect(resolveChannelCount(undefined, 0)).toBe(1)
  })

  it('accepts only existing channel indexes', () => {
    expect(checkChannel(1, 2)).toBe(1)
    expect(() => checkChannel(2, 2)).toThrow(RangeError)
    expect(() => checkChannel(-1, 2)).toThrow(RangeError)
    expect(() => checkChannel(0.5, 2)).toThrow(RangeError)
    expect(() => checkChannel(1, 1)).toThrow(RangeError)
  })

  it('measures rms and peak', () => {
    const buf = new Float32Array([0.5, -0.5, 0.5, -0.5])
    expect(levels(buf)).toEqual({ rms: 0.5, peak: 0.5 })
    expect(levels(new Float32Array([0, -0.9, 0.1, 0]))).toMatchObject({ peak: expect.closeTo(0.9, 6) })
    expect(levels(new Float32Array(8))).toEqual({ rms: 0, peak: 0 })
  })
})

// ─── openInput against a fake browser ───

class FakeTrack extends EventTarget {
  stopped = false
  constructor(public label: string, private reported: MediaTrackSettings) { super() }
  getSettings() { return this.reported }
  stop() { this.stopped = true }
}

class FakeMediaDevices extends EventTarget {
  devices = [dev('default', 'Default'), dev('abc', 'Scarlett 2i2'), dev('def', 'Built-in')]
  getUserMedia = vi.fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()
  enumerateDevices = vi.fn(async () => this.devices as unknown as MediaDeviceInfo[])
}

const streamOf = (track: FakeTrack) =>
  ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream

// Records the graph's edges as "from:out>to:in" so wiring can be asserted.
function fakeGraph() {
  const edges = new Set<string>()
  let n = 0
  const node = (kind: string, extra: object = {}) => {
    const self = {
      id: `${kind}${n++}`,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      connect(dest: { id: string }, out = 0, inp = 0) {
        edges.add(`${self.id}:${out}>${dest.id}:${inp}`)
        return dest
      },
      disconnect(dest?: { id: string }, out?: number, inp?: number) {
        for (const e of [...edges]) {
          if (!e.startsWith(`${self.id}:`)) continue
          if (dest && !e.includes(`>${dest.id}:`)) continue
          if (out !== undefined && !e.startsWith(`${self.id}:${out}>`)) continue
          if (inp !== undefined && !e.endsWith(`:${inp}`)) continue
          edges.delete(e)
        }
      },
      ...extra,
    }
    return self
  }
  const ctx = {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    createMediaStreamSource: vi.fn(() => node('source')),
    createChannelSplitter: vi.fn((count: number) => node('splitter', { numberOfOutputs: count })),
    createGain: () => node('gain', { gain: { value: 1 } }),
    createAnalyser: () => node('analyser', {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      getFloatTimeDomainData: (out: Float32Array) => out.fill(0.25),
    }),
  }
  return { graph: { ctx } as unknown as Graph, ctx, edges }
}

describe('openInput', () => {
  let md: FakeMediaDevices

  const install = () => {
    md = new FakeMediaDevices()
    vi.stubGlobal('navigator', { mediaDevices: md })
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('reports an unsupported browser', async () => {
    vi.stubGlobal('navigator', {})
    await expect(openInput(fakeGraph().graph, null)).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('refuses a blank device ID instead of opening the default', async () => {
    install()
    await expect(openInput(fakeGraph().graph, '')).rejects.toBeInstanceOf(InputError)
    expect(md.getUserMedia).not.toHaveBeenCalled()
  })

  it('never falls back to another device when the chosen one is gone (SPEC rule 5)', async () => {
    install()
    md.getUserMedia.mockRejectedValue(Object.assign(new Error('gone'), { name: 'OverconstrainedError', constraint: 'deviceId' }))
    await expect(openInput(fakeGraph().graph, 'abc')).rejects.toMatchObject({ kind: 'not-found' })
    expect(md.getUserMedia).toHaveBeenCalledTimes(1)
    const audio = md.getUserMedia.mock.calls[0][0].audio as MediaTrackConstraints
    expect(audio.deviceId).toEqual({ exact: 'abc' })
  })

  it('maps a denied permission and asks only once', async () => {
    install()
    md.getUserMedia.mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    await expect(openInput(fakeGraph().graph, null)).rejects.toMatchObject({ kind: 'permission' })
    expect(md.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('closes and rejects a stream that landed on a different device', async () => {
    install()
    const track = new FakeTrack('Built-in', { deviceId: 'def' })
    md.getUserMedia.mockResolvedValue(streamOf(track))
    const { graph, ctx } = fakeGraph()
    await expect(openInput(graph, 'abc')).rejects.toMatchObject({ kind: 'not-found' })
    expect(track.stopped).toBe(true)
    expect(ctx.createMediaStreamSource).not.toHaveBeenCalled()
  })

  it('releases the device when the graph cannot take the stream', async () => {
    install()
    const track = new FakeTrack('Scarlett', { deviceId: 'abc', sampleRate: 44100 })
    md.getUserMedia.mockResolvedValue(streamOf(track))
    const { graph, ctx } = fakeGraph()
    ctx.createMediaStreamSource.mockImplementation(() => { throw new Error('NotSupportedError') })
    await expect(openInput(graph, 'abc')).rejects.toMatchObject({ kind: 'failed', userMessage: expect.stringMatching(/44100 Hz.*48000 Hz/) })
    expect(track.stopped).toBe(true)
  })

  async function openStereo() {
    install()
    const track = new FakeTrack('Scarlett 2i2', {
      deviceId: 'abc', channelCount: 2, sampleRate: 48000,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    })
    md.getUserMedia.mockResolvedValue(streamOf(track))
    const rig = fakeGraph()
    const session = await openInput(rig.graph, 'abc')
    return { ...rig, track, session }
  }

  it('wires source -> splitter -> mono (channel 0) and source -> stereo', async () => {
    const { session, edges, ctx } = await openStereo()
    expect(ctx.createChannelSplitter).toHaveBeenCalledWith(2)
    expect(session.channelCount).toBe(2)
    expect(session.selectedChannel).toBe(0)
    const ids = { src: (session.source as unknown as { id: string }).id, mono: (session.mono as unknown as { id: string }).id, stereo: (session.stereo as unknown as { id: string }).id }
    expect([...edges].filter(e => e.startsWith(`${ids.src}:`))).toHaveLength(2)
    expect(edges.has(`${ids.src}:0>${ids.stereo}:0`)).toBe(true)
    expect([...edges].some(e => e.endsWith(`>${ids.mono}:0`) && e.includes(':0>'))).toBe(true)
    expect(session.mono.channelCount).toBe(1)
    expect(session.mono.channelCountMode).toBe('explicit')
    expect(session.stereo.channelCount).toBe(2)
    session.close()
  })

  it('setChannel moves the mono feed to the other splitter output', async () => {
    const { session, edges } = await openStereo()
    const mono = (session.mono as unknown as { id: string }).id
    const intoMono = () => [...edges].filter(e => e.endsWith(`>${mono}:0`))
    expect(intoMono()).toHaveLength(1)
    expect(intoMono()[0]).toMatch(/^splitter\d+:0>/)
    session.setChannel(1)
    expect(session.selectedChannel).toBe(1)
    expect(intoMono()).toHaveLength(1)
    expect(intoMono()[0]).toMatch(/^splitter\d+:1>/)
    expect(() => session.setChannel(2)).toThrow(RangeError)
    expect(session.selectedChannel).toBe(1)
    session.close()
  })

  it('reports the accepted settings', async () => {
    const { session } = await openStereo()
    expect(session.settings).toEqual({
      deviceId: 'abc', label: 'Scarlett 2i2', channelCount: 2, sampleRate: 48000,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    })
    session.close()
  })

  it('meters the mono path, and reads zero while the context is suspended', async () => {
    const { session, ctx } = await openStereo()
    expect(session.meter()).toEqual({ rms: 0.25, peak: 0.25 })
    ctx.state = 'suspended'
    expect(session.meter()).toEqual({ rms: 0, peak: 0 })
    session.close()
  })

  it('fires onLost once when the track ends', async () => {
    const { session, track } = await openStereo()
    const reasons: string[] = []
    session.onLost(r => reasons.push(r))
    track.dispatchEvent(new Event('ended'))
    track.dispatchEvent(new Event('ended'))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/unplugged/)
    session.close()
  })

  it('tells a late subscriber about a loss that already happened', async () => {
    const { session, track } = await openStereo()
    track.dispatchEvent(new Event('ended'))
    const reasons: string[] = []
    session.onLost(r => reasons.push(r))
    await Promise.resolve()
    expect(reasons).toHaveLength(1)
    session.close()
  })

  it('fires onLost when the device vanishes from the list, not on unrelated changes', async () => {
    const { session } = await openStereo()
    const reasons: string[] = []
    session.onLost(r => reasons.push(r))
    md.devices = [...md.devices, dev('usb', 'Webcam mic')]
    md.dispatchEvent(new Event('devicechange'))
    await vi.waitFor(() => expect(md.enumerateDevices).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(reasons).toHaveLength(0)
    md.devices = md.devices.filter(d => d.deviceId !== 'abc')
    md.dispatchEvent(new Event('devicechange'))
    await vi.waitFor(() => expect(reasons).toEqual(['The input was disconnected.']))
    session.close()
  })

  it('close() stops the track, unhooks every node and silences onLost', async () => {
    const { session, track, edges } = await openStereo()
    const reasons: string[] = []
    session.onLost(r => reasons.push(r))
    session.close()
    session.close()
    expect(track.stopped).toBe(true)
    expect(edges.size).toBe(0)
    track.dispatchEvent(new Event('ended'))
    md.dispatchEvent(new Event('devicechange'))
    await Promise.resolve()
    expect(reasons).toHaveLength(0)
    expect(md.enumerateDevices).not.toHaveBeenCalled()
  })
})
