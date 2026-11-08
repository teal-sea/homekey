# Homekey

An instrument rig that runs in a web browser, built around playing in a key and mode. Guitar
comes first: plug a guitar into an audio interface, open the page and play:

- **An amp sound.** Load a [Neural Amp Modeler](https://www.neuralampmodeler.com/) model
  (a `.nam` file) and the browser runs it live, through TONE3000's open-source WebAssembly
  engine. Add a cabinet impulse response (a `.wav`) if the model has no cabinet in it.
- **A fretboard that follows your key.** Pick a root and one of 11 scales and modes: the seven
  modes, major and minor pentatonic, blues and harmonic minor. A 15-fret neck in standard
  tuning shows the scale, marks the root and, for most scales, the note that gives the mode its
  character, and rings the exact note you play at every place it sits. It follows one note at a
  time, not chords.
- **A looper.** A one-bar click counts you in. Record a 1, 2 or 4-bar loop in 4/4, add one
  overdub, undo it, and export one zip of WAV files. Each file is exactly one loop long and
  starts on the loop's first downbeat, so they line up when placed at the same point in a DAW.
- **A drone** on the root and fifth, to improvise against.

It is a static web page: no account, no backend, and **audio never leaves your device**.

The same rig is meant to grow to bass, voice and keys: see the [roadmap](#roadmap-after-milestone-1).

## Screenshots

![The rig in a 1440 by 900 window. At the top, the deck: Start audio reads "Audio on", the status line reads 44100 Hz, render quantum 128, output latency 30 ms, base latency 10 ms, then Panic mute and the looper buttons, stopped. Below, the Key panel set to A minor pentatonic with the drone on and the heard note E3, -6 cents, "5, in the scale". The 15-fret neck shows the scale with roots as red squares and the other notes as blue dots, and E3 ringed in green at the three places it can be played. The list of keyboard shortcuts is at the bottom.](docs/screenshots/rig.jpg)

![The looper playing a base loop and one overdub: the deck reads "Playing · base + overdub, Bar 1 · beat 3" over a position bar a third full. Below, three panels. Input: System default, channel 1, the level meter before the amp with a peak of -13.9 dB, and what the browser accepted (2 channels, 44100 Hz, echo cancellation, noise suppression and auto gain off). Tone: Amp mode, "Ready: deluxe-a2.nam", and the page's warning that the model was trained at 48000 Hz while the audio runs at 44100 Hz; model loading is locked while the looper runs. Looper: tempo 90 and length 2 bars locked while a loop exists, click on, latency offset 50 ms with its explanation, and Export take.](docs/screenshots/looper.jpg)

<img src="docs/screenshots/phone.jpg" width="300" alt="The phone layout in a 390 by 844 window. The deck stays at the top with Panic mute, the six looper buttons in a three by two grid and &quot;Playing · base + overdub, Bar 2 · beat 3&quot;. Below it, the Key panel stacked in one column: A, Minor Pentatonic, Note names off, Drone on, and the heard note E4, -9 cents, &quot;5, in the scale&quot;. The neck scrolls sideways and shows its first five frets, with E4 ringed in two places and a tag reading &quot;2 more&quot; with an arrow to the right.">

How they were made: the production build in headless Chromium 153 on Linux. The input is
Chromium's fake capture device playing a recorded guitar DI, a single-note slide line in
A minor, scaled to peak at -12 dBFS. The amp is `deluxe-a2.nam`. Both are demo files from the
[neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) repository and
neither is in this repo. Headless Chromium here runs audio at 44.1 kHz, so the page warns that the
48 kHz model is not running at its own rate (second picture).

## Status

Milestone 1 (November 2026). Built: audio input, pitch detection, music theory and the
fretboard, the amp chain, the drone, the transport and click, the recorder and looper, WAV and
zip export, and the page that wires them together, with unit tests and browser tests. It has
run only in headless Chromium on Linux with a fake audio device, never with a real guitar and
interface. [SPEC.md](SPEC.md) is the contract the modules follow;
[What was tested, and what was not](#what-was-tested-and-what-was-not) is below.

## Why this is hard

- **Timing.** A loop has to land on the beat for as long as it plays. All musical time is
  counted in whole audio frames from one origin. A timer only decides when to schedule the next
  clicks, up to 100 ms ahead on the audio clock; the frame grid alone decides where a beat
  falls, so the click and the loop cannot drift apart. A unit test checks the grid 10,000 loops
  out.
- **Recording only the guitar.** The recorder listens to the guitar bus and nothing else, so
  loop playback, the click and the drone cannot reach a take through the browser's audio
  graph. A browser test checks this.
- **Reading the note before the amp.** Pitch detection listens to the input channel you choose,
  before the amp, so distortion added in the browser cannot fool the fretboard. In Bypass mode
  the input is already processed by your hardware, and the detector hears that processed sound.
- **What the browser actually does, measured in Chromium 153.** Three findings shaped the design:
  1. The amp engine cannot compile its WebAssembly under a strict security policy unless
     `'wasm-unsafe-eval'` is allowed, so the app ships that policy and its browser tests run
     under it.
  2. Loading an amp model froze the whole audio thread for 80 to 122 ms, so models and impulse
     responses load only while the looper is stopped.
  3. If the browser renders audio in blocks larger than 128 frames, the amp engine silently
     passes the dry guitar through. Where the browser reports its block size, the page checks
     it, warns and offers Bypass only.
- **One channel into the amp.** NAM models are mono. The amp gets the one input channel you
  choose, not an average of both.

## Two ways to plug in

| Route | Sound comes from | You hear it through |
|---|---|---|
| Guitar into an interface's instrument (Hi-Z) input (**Amp** mode) | The NAM model in the browser | The browser, with Monitoring on, on wired headphones |
| Already-processed sound, such as a multi-effects unit (a BOSS GT-1) or a pedalboard (**Bypass** mode) | Your hardware | Your hardware's own monitoring; the browser records and loops the input as it arrives, in stereo |

Choose the input and the channel the guitar is on (1 or 2). In both modes the fretboard listens
to that channel before anything the browser adds.

Monitoring starts off. **Panic mute** sits in the deck at the top of the page, which stays in
view on windows taller than 560 px, and `Esc` triggers it from anywhere. The page never switches
to another input by itself: if your interface disappears, it says so, closes the input and stops
any take in progress. **Choose again** lets you pick it from the list once it is back.

## Run it

Needs Node.js 20, 22, or 24 and later, and npm.

```sh
npm ci                 # the exact versions in package-lock.json
npm run dev            # http://localhost:5174, served with the production security policy
npm test               # unit tests (Vitest, in Node)
npm run build          # typecheck, then a production build into dist/
npm run preview        # after a build: serves dist/ at http://localhost:4174, same policy
npm run test:browser   # builds, serves the build with `vite preview`, runs Playwright in Chromium
```

`dev` and `build` first copy the amp engine's files from `node_modules` into `public/nam/`
(`scripts/copy-engine.mjs`).

The browser tests use `CHROMIUM_PATH` when it is set; otherwise Playwright's own Chromium
(`npx playwright install chromium`); otherwise a `chromium` link inside
`PLAYWRIGHT_BROWSERS_PATH`.

To play, use a recent Chromium-based browser such as Chrome or Edge. Firefox and Safari have not
been tried.

## Using it

1. **Start audio.** The status line shows the sample rate, the render quantum and the output and
   base latency the browser reports. At a render quantum other than 128 the page warns and offers
   Bypass only. If the browser suspends audio, the button turns into **Resume audio**.
2. **Allow input.** This opens the input you used last, or the system default. The browser asks
   for permission once, then lists your inputs by name. Pick your interface and the guitar's
   channel. The meter shows the level before the amp, with a peak readout held for about a
   second and a half. The page lists what the browser accepted: echo cancellation, noise
   suppression and auto gain are requested off, and it warns if any stayed on, or if the input
   and the audio engine run at different sample rates.
3. **Load a model** (`.nam`) and, if you want, a cabinet IR (`.wav`, mono or stereo, up to
   10 s). If the model was trained at a different sample rate than the browser runs at, the page
   says so. A model that comes in several sizes gets a size slider. Set the input gain into the
   amp (-24 to +24 dB) and the output level (-40 to +12 dB). In Amp mode with no model loaded
   the amp stays silent, and the page says so.
4. **Monitoring** is off when the page opens. Turn it on to hear yourself through the browser, on
   headphones; while an input is open and monitoring is off, the top bar says so. **Panic mute**
   (or `Esc`) silences everything and turns monitoring off; unmuting leaves monitoring off and
   the top bar says that too.
5. **Pick a key.** Root and scale or mode. **Note names** switches the neck's labels from
   intervals to note names. The drone follows the root.
6. **Record.** Set the tempo (30 to 300 BPM) and length, press **Record** (or `Space`) and play
   after the one-bar count-in. The loop plays straight back. **Overdub** records one layer on
   top, from the start of the next full loop cycle; **Undo** removes it; **Clear** deletes
   everything and unlocks tempo and length. **Export** downloads one zip,
   `homekey-take-<date>-<time>-<bpm>bpm.zip`, holding `base.wav`, `overdub.wav` (when there
   is one) and `mix.wav` (a plain sum of the two), all 24-bit stereo, plus `take.json`: tempo,
   beats per bar, bars, sample rate, loop length in frames, latency offset (and the overdub's,
   if it differed), channel layout, tone mode, model name, and an `overdub` block when the
   overdub went through a different mode, model or channel.
   Takes live only in memory, so export the ones you want to keep: until you do, **Clear** needs
   a second press within 3 seconds, and the browser asks before a reload or close. Record needs
   an open input and waits while a model or IR is loading. Tone mode, Clear IR, the input device
   and the channel are held still from the count-in until the take is done. A take the browser
   interrupts (a suspended or interrupted audio context) is discarded with a message rather than
   looped with a gap.

Keys, also listed on the page: `Space` is a footswitch (record, then overdub, then stop; play
when a stopped loop exists), `R` record, `O` overdub, `P` play, `S` stop, `U` undo, `Esc` panic.
Clear has no key. Keys ignore Ctrl, Alt and Cmd combinations and auto-repeat. They stand down
while a text field, a list or a file picker has focus; `Enter` in a number field, or a pick from
a list with the mouse, hands them back. `Esc` always works. `Space` takes over from a focused
button only once there is an input to record or a loop to drive; before that it presses the
button as usual.

**Latency offset.** What you play against the click reaches the recorder late. The default is the
output latency the browser reports (`outputLatency + baseLatency`) plus 10 ms for the input side
it cannot measure; you can set 0 to 300 ms. If overdubs land late against the loop, raise it;
early, lower it. A value you set is remembered; **Use default** goes back. The default has not
yet been checked against a real interface.

## Security policy

One set of security headers is used in dev, preview and the browser tests. It lives in
`csp.mjs`; `vercel.json` repeats it for a Vercel deployment (Vercel's config is static JSON),
and `src/vercel-headers.test.ts` fails if the two ever differ.

- `script-src 'self' 'wasm-unsafe-eval'`: the amp engine cannot compile its WebAssembly without
  `'wasm-unsafe-eval'`. That keyword allows WebAssembly compilation only, not JavaScript `eval`.
- No `'unsafe-inline'` for scripts or styles. The page builds its elements with DOM calls and sets
  the few live values (meter, loop position) through the CSSOM, which the policy allows.
- Audio worklets are same-origin files (`/nam/`, `/worklets/`), never Blob URLs.
- `connect-src 'self'`: no network calls beyond the page's own files.
- The page cannot be framed (`frame-ancestors 'none'`), and the Permissions-Policy header allows
  the microphone for this page only, with no camera or location.

## Privacy

- Audio is processed in the browser and never uploaded. Takes exist only in memory until you
  export them.
- Settings are kept in this browser's `localStorage` under one key, `homekey.settings.v1`:
  input device and channel, tone mode, input gain and output level, root and scale, note-name
  labels, drone level, tempo, length, click on or off and its level, and the latency offset if
  you set one. Monitoring is never remembered as on, and the drone always starts off. Models and
  IRs are not stored; load them each session.

## Dependencies and licences

- [neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) 3.0.7 by
  TONE3000, MIT licence: a WebAssembly build of Steven Atkinson's NeuralAmpModelerCore v0.5.4,
  and the only third-party code the page ships. Its worklet and WebAssembly files are copied
  into `public/nam/` at build time, together with the package's `LICENSE` and this repo's
  [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), and served next to the engine. The notices
  list what the WebAssembly compiles in: NeuralAmpModelerCore (MIT), Eigen (MPL-2.0),
  nlohmann/json (MIT) and the Emscripten runtime (MIT or NCSA; musl under MIT, libc++ under
  Apache-2.0 with LLVM exceptions).
- The package also carries a React player, so it lists React as a peer dependency. This app
  imports only its engine (`neural-amp-modeler-wasm/engine`), and `.npmrc` keeps npm from
  installing React. The player's own dependencies (`lucide-react`, `react-knob-headless`) still
  install, but nothing imports them and they are not in the build.
- The zip export is written by this repo (`src/export/zip.ts`, store-only, no compression), not a
  library.
- No amp models, cabinet impulse responses or recordings ship with this repo. Bring your own.
  The test model in `tests/fixtures/identity.nam` was written for this repo and is not a capture
  of any amp.
- Parts are adapted from the author's own [Modal Runs](https://modalruns.com) app: pitch detection
  and the note commit rule, the music theory and fretboard code, the drone and the click sound.
  Each adapted file says so in a comment.
- Development only, not shipped: Vite, TypeScript, Vitest, Playwright, `@types/node`.

This project's own licence has not been chosen yet.

## What was tested, and what was not

All of it ran on Linux, in Node 22 and headless Chromium 153.

- **Unit tests** (`npm test`, 323 tests in 21 files, in Node): theory and fretboard, pitch
  detection and the note commit rule, input handling, the tone chain, the drone, the transport
  grid (exact beat offsets 10,000 loops out, every click on the grid through 200 loops, and a
  stalled main thread skipping beats rather than playing them late), the looper state machine,
  the recorder worklet frame by frame, WAV round trips, the zip writer (read back by a separate
  strict reader), and the page's settings, keys, readouts and headers. Modules that need Web
  Audio run against stand-in objects, not a browser.
- **Browser tests** (`npm run test:browser`, 17 tests): the production build under the production
  security policy, in headless Chromium with its fake audio device, which plays a short repeated
  beep. They check no policy violations, console errors or page errors; start audio; the fake
  input listed and the meter moving; the test model and a test IR loading; a 1-bar base and an
  overdub at 120 BPM; the export as one zip whose WAVs decode to exactly one loop each and are
  not silent; that loop, click and drone never reach a take; undo and clear; the second press
  on Clear and the warning before a reload; the fretboard ringing the beep's pitch in all three
  places; the keys; panic and monitoring; a simulated unplug with no fallback, and recovery; a
  390 px window where no focused control hides under the deck; settings surviving a reload.
- **The screenshots above** are the only run with a real guitar recording and a real amp model.
  The meter, the note readout and the neck followed the recording, a base and an overdub
  recorded, and the page logged no errors. No test asserts this, and the sound was not listened
  to.
- **Not tested:** a real guitar through a real audio interface; real latency and the default
  offset; how well pitch detection follows a distorted signal (Bypass with a multi-effects
  unit); Firefox and Safari, so no iPhone or iPad; macOS, Windows and real phones; a screen
  reader; a render quantum other than 128 in a real browser; long sessions.

## Roadmap after milestone 1

- More overdub layers, with per-layer level and mute
- Saving sessions on the device, with a portable export
- Latency calibration with a loopback test instead of a manual offset
- A tuner
- Effects after the amp: delay and reverb
- An "answer" mode: play a phrase, and the app answers in the mode
- Firefox and Safari support, and real phones and tablets (a narrow layout exists, checked only
  in a 390 px headless window)
- More export options and accessibility work

### More instruments, in the order they reuse what exists

Guitar comes first. The same rig is meant to grow to:

- **Bass.** The amp engine already runs bass amp models and the pitch detector already reads
  down to a 5-string's low B (28 Hz floor). Needed: 4- and 5-string fretboards and bass tunings,
  low-frequency latency and detection behaviour, a bass-friendly analysis window.
- **Voice.** A microphone input path with its own chain (EQ, compression, reverb), the pitch
  detector showing the sung note against the mode on a keyboard or staff view, later harmonies.
- **Keys from a MIDI controller.** Web MIDI input, a built-in synth, and a keyboard view of the
  mode beside the fretboard, recorded and looped like the guitar.
