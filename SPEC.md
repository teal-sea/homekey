# Guitar rig: milestone 1 spec

A browser guitar rig. Plug a guitar into an audio interface, get an amp sound from a
Neural Amp Modeler (NAM) model, see the key and mode on a fretboard that lights the note
you play, and record a loop with one overdub. Everything runs in the browser. No accounts,
no analytics, no server, no network calls except same-origin static files. Audio never
leaves the device.

Working name only: "Guitar Rig". The product name is not chosen.

## Hard rules

1. **One AudioContext**, owned by `src/audio/graph.ts`. Nobody else creates one.
2. **The recorder records the guitar bus only.** Loop playback, drone and click never reach
   the recorder or the pitch analyser through the graph.
3. **Pitch analysis taps the selected input channel before the amp**, so distortion and
   effects added in the browser never confuse it.
4. **Monitoring starts OFF.** Turning it on is explicit. A panic mute silences all output.
5. **No silent device fallback.** If the selected input disappears or fails, show an error
   and stop; never switch to another device by yourself.
6. **No model or IR loads while the transport runs.** A NAM model load freezes the whole
   audio thread for about 80–130 ms (measured 2026-11-08, Chromium 153). The UI disables
   loading unless the looper is idle and the transport stopped.
7. **Render quantum must be 128.** At 256 the NAM worklet silently passes the dry input
   through (measured). Create the context without `renderSizeHint`; if
   `ctx.renderQuantumSize` exists and is not 128, show a warning and treat the amp as bypassed.
8. **CSP:** the deployed policy must allow `'wasm-unsafe-eval'` in `script-src` (measured: the
   engine fails to instantiate without it). Worklets are same-origin files, never Blob URLs.
9. **Musical time is integer frames from one origin.** UI timers schedule ahead; they never
   define a boundary.
10. **Settings may persist in localStorage. Audio never persists in M1.** Export is the backup.

## Audio graph

```
getUserMedia stream (echoCancellation, noiseSuppression, autoGainControl all false)
  └─ MediaStreamSource ─┬─ ChannelSplitter ── selected channel (mono) ─ inputTrim ─┬─ analyser (pitch, pre-amp)
                        │                                                         └─ toneIn
                        └─ bypassIn (stereo, for already-processed input such as a GT-1)

toneIn ─ NamNode (mono) ─ [IR convolver, optional] ─ toneOut (gain)

guitarBus (stereo)  ← toneOut   when toneMode = 'amp'
                    ← bypassIn  when toneMode = 'bypass'
guitarBus ─┬─ recorder worklet (2 ch)          ← the ONLY thing recorded
           └─ monitorGain (0 when monitoring off) ─ master

loopBus  ─ master        (loop playback)
droneBus ─ master
clickBus ─ master
master ─ limiter (DynamicsCompressor, gentle) ─ ctx.destination
```

`master` has a panic mute. No reverb is added by the app in M1.

## Modules and owners

| File | Exports | Notes |
|---|---|---|
| `src/audio/graph.ts` | `createGraph`, `Graph` | Context + all buses above. Written first; others consume it |
| `src/audio/input.ts` | `listInputs`, `openInput`, `InputSession` | Device, channel select, accepted settings, device loss |
| `src/audio/pitch.ts` | `detectPitch`, `measureRms`, `freqToMidi` | McLeod pitch method, pure |
| `src/audio/analysis.ts` | `createNoteFollower` | Polls the analyser, commit rule, emits notes |
| `src/audio/tone.ts` | `createTone`, `Tone` | NAM engine attach, model and IR load, bypass, gains |
| `src/audio/drone.ts` | `createDrone`, `Drone` | Root + fifth bed on `droneBus` |
| `src/audio/transport.ts` | `createTransport`, `Transport`, grid math | Look-ahead clock, click, bar grid |
| `src/audio/looper.ts` | `createLooper`, `Looper`, `looperReducer` | Base + one overdub, undo, clear, export |
| `public/worklets/recorder.js` | processor `rig-recorder` | Frame-exact capture, chunks to main thread |
| `src/export/wav.ts` | `encodeWav`, `decodeWav` | 16- or 24-bit PCM, pure |
| `src/theory/*.ts` | notes, scales, fretboard | Pure, deterministic |
| `src/ui/*.ts`, `src/main.ts`, `src/styles.css` | the page | Vanilla TypeScript and DOM, no framework |

## Transport and looper contract

- `framesPerBeat = sampleRate * 60 / bpm` (float). `loopFrames = Math.round(framesPerBeat * beatsPerBar * bars)` (integer).
- Loop boundary `k` is at `originFrame + k * loopFrames`. Beat `i` of loop `k` is at
  `originFrame + k * loopFrames + Math.round(i * loopFrames / (beatsPerBar * bars))`. Never
  accumulate floats across loops; drift must be zero by construction.
- Count-in: one bar of click before the base take, in its own click voice. The transport's
  origin is the first downbeat after the count-in (boundary 0). The base take captures
  exactly `loopFrames` frames starting at that downbeat, shifted by the latency offset
  (below). Record and play always (re)start the transport, so they always count in.
  Clicks are scheduled 100 ms ahead by a 25 ms timer; a beat the timer reaches too late
  (main thread stalled) is skipped, never played late.
- Latency offset: `latencyFrames = Math.round(latencyMs * sampleRate / 1000)`. Capture
  windows start `latencyFrames` later than the boundary they belong to, because what the
  player plays against the heard click reaches the recorder late. Default `latencyMs` =
  `round((ctx.outputLatency + ctx.baseLatency) * 1000) + 10`, user-adjustable from 0 to 300.
- A take belongs to the cycle that starts at boundary `k` and is first heard at boundary
  `k + 1`: the base (k = 0) from the downbeat right after the player's last bar, an overdub
  armed for cycle k from k + 1, in sync with the base. *(Changed 2026-11-08: this said
  "the boundary right after the base capture ends". With any latency offset the capture
  ends `latencyFrames` after boundary 1, so that boundary is 2 and the player would sit
  through one silent cycle before hearing the loop.)* The capture is not complete at
  boundary `k + 1`, so the first pass is built from the recorder's chunks: each chunk is
  scheduled the moment it arrives at `boundary(k + 1) + offset`, nearly a loop ahead. From
  boundary `k + 2` one `AudioBufferSourceNode` per layer loops the whole buffer (exactly
  `loopFrames` long, `loop = true`, loopStart/loopEnd left at 0 so no seconds-to-frames
  conversion is involved). A chunk that arrives too late for its slot leaves a hole in
  the first pass; nothing is ever started off the grid. All starts are integer frames
  converted with `frameTime()` (see transport.ts).
- The overdub's cycle is the first boundary not yet rendered whose capture window can
  still be armed (30 ms margin). If the worklet answers `late`, the looper re-arms the
  next cycle. A late base is an error.
- BPM and bars are locked while a loop exists. Clear unlocks them.
- States: `idle`, `count-in`, `recording-base`, `playing`, `overdub-armed`,
  `recording-overdub`, `error`. `looperReducer(state, event)` is pure and unit-tested.
- Undo removes the overdub. Clear stops and deletes everything.
- Export: `base.wav` and `overdub.wav`, identical length and origin, plus `mix.wav`.
  Also `take.json` with bpm, beatsPerBar, bars, sampleRate, loopFrames, latencyMs, channel
  layout, tone mode, model name.

## Recorder worklet protocol (`rig-recorder`)

Main → worklet: `{ type: 'arm', id, startFrame, frames }`, `{ type: 'cancel', id }`.
Worklet → main: `{ type: 'chunk', id, offset, channels: [Float32Array, Float32Array] }`
(transferred, 4096 frames each, in order), `{ type: 'done', id, startFrame, frames,
discontinuous }`, `{ type: 'late', id, currentFrame }` when armed after `startFrame` already
passed. Two input channels; a mono input is copied to both. Output: one silent channel,
connected to a zero gain so the node is always pulled. One take at a time; a new `arm`
replaces the take in progress.

- **The worklet counts frames itself.** In Chromium 153 `currentFrame` sometimes repeats the
  previous quantum's value for one `process()` call and then jumps 256 (measured
  2026-11-08: 10 times in 18 s of looping and overdubbing; cause not confirmed).
  Rendering is in order, so a reading behind the worklet's own count is stale and the count
  wins; a reading ahead of it is a real gap.
- A gap inside the window leaves zeros at the true position (audio is never shifted) and
  sets `discontinuous: true` on `done`. The looper discards a discontinuous take with an
  error rather than loop a dropout forever.
- Chunk storage is allocated per chunk as the take reaches it, not for the whole take at
  `arm`: allocating 230 chunk pairs (a 21 s take) at once took 3.7 ms in V8 (Node, dev
  container), more than a render quantum's budget on the audio thread.

## Tests

- `vitest` unit tests next to each pure module: theory, pitch, wav round trip, transport grid
  (no drift over 10,000 loops), looper reducer.
- `playwright` browser tests against `vite preview` with the production CSP headers and
  Chromium's fake audio device: the page loads with no CSP violations, the engine attaches,
  the test model loads, a base loop and an overdub record, and the exported WAVs decode with
  identical lengths.
- `tests/fixtures/identity.nam` is an authored, trivially small NAM model owned by this repo,
  so tests never depend on third-party captures.

## Out of scope for M1

More than one overdub, persistence of audio, time stretching, voice processing, an effects
board, a model catalog, AI accompaniment, accounts, analytics.
