# Guitar Rig

A guitar rig that runs in your web browser. Plug a guitar into an audio interface, open the
page, and play:

- **A real amp sound.** Load a [Neural Amp Modeler](https://www.neuralampmodeler.com/) model
  (`.nam` file) and the browser runs it live, through TONE3000's open-source WebAssembly engine.
  Add a cabinet impulse response (`.wav`) if the model has no cabinet.
- **A fretboard that knows your key and mode.** Pick a root and a mode. The neck shows the scale,
  marks the root and the note that gives the mode its character, and lights up the note you just
  played at every place it sits on the neck.
- **A looper.** A click counts you in, you record a 1, 2 or 4-bar loop, add one overdub, undo
  it, and export WAV files that line up sample for sample in any DAW.

Nothing to install, no account, no server. **Audio never leaves your device.**

Working name. The product name is not chosen yet.

## Status

Milestone 1 is in progress (November 2026). The audio engine modules (input, pitch detection,
theory and fretboard, tone chain, drone, transport, recorder and looper, WAV export) are built
with unit tests; the page that wires them together is being finished. See [SPEC.md](SPEC.md) for
the contract every module follows.

## Why this is hard

- **Timing.** A loop has to land on the beat forever. All musical time is counted in audio
  frames from one origin and scheduled ahead on the audio clock, never on screen timers, so
  drift is zero by construction.
- **Recording only the guitar.** The recorder taps the guitar bus and nothing else. Loop
  playback, the click and the drone can never end up inside a take.
- **Reading the note before the amp.** Pitch detection listens to the clean input channel, so
  distortion added in the browser cannot fool the fretboard.
- **What the browser actually does, measured.** Three findings shaped the design:
  1. The amp engine's WebAssembly is blocked by a normal security policy until
     `'wasm-unsafe-eval'` is allowed, so the app ships that policy and tests against it.
  2. Loading an amp model freezes the whole audio thread for about 80 to 120 ms, so models and
     impulse responses can only load while nothing is recording or playing.
  3. If the browser renders audio in blocks larger than 128 frames, the amp engine silently
     passes the dry guitar through, so the app checks the block size and warns.
- **One channel into the amp.** NAM models are mono. The app feeds the amp the input channel you
  choose instead of averaging both channels.

## Two ways to plug in

| Route | Sound comes from | You hear it through |
|---|---|---|
| Interface + amp model | The NAM model in the browser | The browser, with monitoring switched on and wired headphones |
| Already-processed input (a multi-effects unit or pedalboard) | Your hardware | Your hardware's own monitoring; the browser records and loops, in Bypass mode |

Monitoring starts off, and a panic mute is always on screen.

## Run it

```sh
npm install
npm run dev            # http://localhost:5174
npm test               # unit tests (vitest)
npm run test:browser   # browser tests (Playwright, Chromium with a fake audio device)
npm run build
```

Use a recent Chromium-based browser for now. Firefox and Safari support is on the roadmap.

## Dependencies and licences

- [neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) 3.0.7 by
  TONE3000, MIT licence. Its worklet and WebAssembly files are copied into `public/nam/` at build
  time with their licence file.
- No amp models, cabinet impulse responses or recordings ship with this repo. Bring your own.
  The test model in `tests/fixtures/identity.nam` was written for this repo and is not a capture
  of any amp.
- The pitch detection and music theory code is adapted from the author's own
  [Modal Runs](https://modalruns.com) app.

This project's own licence has not been chosen yet.

## Roadmap after milestone 1

- More overdub layers, with per-layer level and mute
- Saving sessions on the device, with a portable export
- Latency calibration with a loopback test instead of a manual offset
- A tuner
- Effects after the amp: delay and reverb
- An "answer" mode: play a phrase, and the app answers in the mode
- Phone layout, and Firefox and Safari support
- More export options and accessibility work
