// End to end, in order, on one page: the way a player meets the rig. Each step
// leans on the one before (no model, no amp sound; no base, no overdub), so the
// tests run serially on a shared page rather than rebuilding state each time.
//
// The "guitar" is Chromium's fake capture device: a short beep, repeated. It is
// not a guitar, so these tests prove wiring and timing, not tone or tracking
// quality on real playing.

/// <reference types="node" />
import { expect, test, type Download, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { decodeWav, encodeWav } from '../../src/export/wav'
import { readZip } from '../zip-reader'
import { APP_SLUG } from '../../src/app-name'

test.describe.configure({ mode: 'serial' })

const BASE_URL = `http://127.0.0.1:${process.env.RIG_E2E_PORT}`
const IDENTITY_MODEL = fileURLToPath(new URL('../fixtures/identity.nam', import.meta.url))

let page: Page
const consoleErrors: string[] = []
const pageErrors: string[] = []

const cspViolations = (): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

const looperState = (): Promise<string | null> => page.locator('#looper-state').getAttribute('data-state')

/**
 * Presses Export and opens what it downloads: exactly one zip, unpacked by the
 * tests' own reader (tests/zip-reader.ts), which checks every header and CRC.
 */
async function exportTake(): Promise<{ zipName: string; files: Map<string, Uint8Array> }> {
  const downloads: Download[] = []
  const collect = (d: Download): void => { downloads.push(d) }
  page.on('download', collect)
  await page.locator('#export').click()
  await expect.poll(() => downloads.length, { timeout: 10_000 }).toBeGreaterThan(0)
  // A second download from the same click would land within moments of the first.
  await page.waitForTimeout(500)
  page.off('download', collect)
  expect(downloads.length).toBe(1)
  const zip = await readFile(await downloads[0].path())
  const entries = readZip(new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength))
  return { zipName: downloads[0].suggestedFilename(), files: new Map(entries.map(e => [e.name, e.data])) }
}

const decodeEntry = (files: Map<string, Uint8Array>, name: string) => {
  const data = files.get(name)
  if (!data) throw new Error(`${name} is not in the zip`)
  return decodeWav(data.slice().buffer as ArrayBuffer)
}

const peakOf = (channels: Float32Array[]): number =>
  channels.reduce((m, c) => c.reduce((n, v) => Math.max(n, Math.abs(v)), m), 0)

const takeJsonOf = (files: Map<string, Uint8Array>) =>
  JSON.parse(new TextDecoder().decode(files.get('take.json')))

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true })
  page = await context.newPage()
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => { pageErrors.push(e.message) })
  // Installed before any page script runs, so no violation can slip past.
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = seen
    document.addEventListener('securitypolicyviolation', e => {
      seen.push(`${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`)
    })
    // Keep the streams the page opens, so a test can stand in for an unplugged device.
    const streams: MediaStream[] = []
    ;(window as unknown as { __streams: MediaStream[] }).__streams = streams
    const md = navigator.mediaDevices
    const open = md.getUserMedia.bind(md)
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await open(constraints)
      streams.push(stream)
      return stream
    }
  })
})

test.afterAll(async () => {
  await page?.context().close()
})

test('(a) the page loads under the production CSP with no violations and no console errors', async () => {
  const response = await page.goto(`${BASE_URL}/`)
  expect(response?.status()).toBe(200)
  const csp = response?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(csp).toContain("style-src 'self'")
  await expect(page.locator('#start-audio')).toBeVisible()
  // The fretboard draws before any audio exists.
  await expect(page.locator('svg.fb .fb-dot').first()).toBeVisible()
  await expect(page.locator('svg.fb')).toHaveAttribute('aria-label', /A Aeolian/)
  await page.waitForLoadState('networkidle')
  expect(await cspViolations()).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
  // The engine ships with its licence and the notices for what its wasm compiles in.
  for (const [file, text] of [['LICENSE', 'TONE3000'], ['THIRD_PARTY_NOTICES.txt', 'NeuralAmpModelerCore']]) {
    const res = await page.request.get(`${BASE_URL}/nam/${file}`)
    expect(res.status(), file).toBe(200)
    expect(await res.text(), file).toContain(text)
  }
})

test('(b) Start audio, allow input: the fake device is listed and the meter moves', async () => {
  await page.locator('#start-audio').click()
  await expect(page.locator('#audio-status')).toContainText('render quantum 128')
  await expect(page.locator('#audio-status')).toContainText(/\d+ Hz/)
  // The engine attaches (needs 'wasm-unsafe-eval') and waits for a model.
  await expect(page.locator('#tone-status')).toHaveAttribute('data-status', 'no-model', { timeout: 15_000 })
  // Monitoring starts off (SPEC rule 4).
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#latency')).toBeEnabled() // the recorder (and with it the footswitch) is ready

  // With no input open a take can only be silence: Record waits, and says why.
  await expect(page.locator('#record')).toBeDisabled()
  await expect(page.locator('#looper-hint')).toContainText('No input is open')
  // Space on a focused button presses it until there is something to record:
  // here it opens the input instead of counting in a silent take.
  await page.locator('#allow-input').focus()
  await page.keyboard.press('Space')
  await expect(page.locator('#device option', { hasText: 'Fake' }).first()).toBeAttached({ timeout: 10_000 })
  expect(await looperState()).toBe('idle')
  await expect(page.locator('#accepted')).toContainText('Echo cancellation: off')
  await expect(page.locator('#input-error')).toBeHidden()
  // The deck says the guitar is not coming through the page.
  await expect(page.locator('#monitor-note')).toContainText('Monitoring is off')
  await expect(page.locator('#deck-monitor')).toBeVisible()

  // Amp mode with no model: Record is allowed, and the warning stays through the count-in.
  await page.locator('#record').click()
  await expect.poll(looperState).toBe('count-in')
  await expect(page.locator('#looper-hint')).toContainText('this take will be silent')
  // Tone and input are held still while a take is under way.
  await expect(page.locator('#mode-bypass')).toBeDisabled()
  await expect(page.locator('#device')).toBeDisabled()
  await page.locator('#stop').click()
  await expect.poll(looperState).toBe('idle')
  await expect(page.locator('#mode-bypass')).toBeEnabled()

  // The fake device beeps; the peak-hold readout rises above the floor.
  // (An object, not the number: a 0 dB peak is falsy and would never resolve the wait.)
  const peak = await page.waitForFunction(() => {
    const db = Number(document.querySelector<HTMLElement>('#input-meter')?.dataset.peakDb)
    return db > -40 ? { db } : null
  }, null, { polling: 'raf', timeout: 10_000 })
  expect((await peak.jsonValue() as { db: number }).db).toBeGreaterThan(-40)
})

test('(c) the authored identity model loads through the file input', async () => {
  const picker = page.locator('label.file-button[for="model-file"]')
  await expect(picker).toHaveText('Load model…')
  await expect(page.locator('#model-file')).toBeEnabled()
  await page.locator('#model-file').setInputFiles(IDENTITY_MODEL)
  await expect(page.locator('#tone-status')).toHaveAttribute('data-status', 'ready', { timeout: 10_000 })
  await expect(page.locator('#model-summary')).toContainText('identity.nam')
  await expect(page.locator('#tone-error')).toBeHidden()
  // The picker follows what is loaded, instead of the native "No file chosen".
  await expect(picker).toHaveText('Change model…')
})

test('(d) 1 bar at 120 bpm: record a base, then an overdub', async () => {
  await page.locator('#bars').selectOption('1')
  await page.locator('#bpm').fill('120')
  await page.locator('#bpm').blur()
  await expect(page.locator('#bpm')).toHaveValue('120')

  await page.locator('#record').click()
  await expect.poll(looperState).toMatch(/count-in|recording-base/)
  // Loading is locked while the transport runs (SPEC rule 6).
  await expect(page.locator('#model-file')).toBeDisabled()
  await expect(page.locator('#bpm')).toBeDisabled()
  // A mode switch or Clear IR mid-take would duck the guitar and record the gap.
  await expect(page.locator('#mode-amp')).toBeDisabled()
  await expect(page.locator('#mode-bypass')).toBeDisabled()
  await expect(page.locator('#clear-ir')).toBeDisabled()
  // Count-in 2 s + take 2 s + latency offset.
  await expect.poll(looperState, { timeout: 15_000 }).toBe('playing')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'true')
  await expect(page.locator('#mode-bypass')).toBeEnabled()

  await page.locator('#overdub').click()
  await expect.poll(looperState).toMatch(/overdub-armed|recording-overdub/)
  await expect.poll(looperState, { timeout: 15_000 }).toBe('playing')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-overdub', 'true')
  await expect(page.locator('#looper-error')).toBeHidden()
})

test('(e) Export: one zip; base and overdub decode with identical length equal to loopFrames, and are not silent', async () => {
  const { zipName, files } = await exportTake()
  expect(zipName).toMatch(new RegExp(`^${APP_SLUG}-take-\\d{4}-\\d{2}-\\d{2}-\\d{4}-120bpm\\.zip$`))
  expect([...files.keys()]).toEqual(['base.wav', 'overdub.wav', 'mix.wav', 'take.json'])

  const take = takeJsonOf(files)
  expect(take).toMatchObject({ bpm: 120, beatsPerBar: 4, bars: 1, toneMode: 'amp', modelName: 'identity.nam' })
  expect(take).not.toHaveProperty('overdub') // both layers went through the same amp
  expect(take.loopFrames).toBe(Math.round(take.sampleRate * 60 / 120 * 4))
  expect(take.files).toEqual(['base.wav', 'overdub.wav', 'mix.wav'])

  const decode = (name: string) => decodeEntry(files, name)
  for (const name of ['base.wav', 'overdub.wav', 'mix.wav']) {
    const wav = decode(name)
    expect(wav.sampleRate, name).toBe(take.sampleRate)
    expect(wav.channels.length, name).toBe(2)
    expect(wav.channels[0].length, name).toBe(take.loopFrames)
    expect(wav.channels[1].length, name).toBe(take.loopFrames)
  }
  // The fake device's beep reached the takes through the amp (identity model).
  expect(peakOf(decode('base.wav').channels)).toBeGreaterThan(0.01)
  expect(peakOf(decode('overdub.wav').channels)).toBeGreaterThan(0.01)
})

test('(f) Undo removes the overdub; Clear unlocks tempo and length', async () => {
  await page.locator('#undo').click()
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-overdub', 'false')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'true')
  expect(await looperState()).toBe('playing')
  await expect(page.locator('#bpm')).toBeDisabled()

  await page.locator('#stop').click()
  await expect.poll(looperState).toBe('idle')
  // Stopped with a loop: still locked, and loading is allowed again.
  await expect(page.locator('#bpm')).toBeDisabled()
  await expect(page.locator('#model-file')).toBeEnabled()

  await page.locator('#clear').click()
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'false')
  await expect(page.locator('#bpm')).toBeEnabled()
  await expect(page.locator('#bars')).toBeEnabled()
  await expect(page.locator('#lock-note')).toBeHidden()
  await expect(page.locator('#record')).toBeEnabled()
})

test('a cab IR loads through its file input, the amp sounds through it, and Clear IR drops it', async () => {
  // A unit impulse, 100 ms long, written here like identity.nam: no third-party
  // IR in the repo. The convolver normalises an IR's power, so a lone impulse
  // comes out quieter than the dry beep, but nowhere near silent.
  const impulse = new Float32Array(4800)
  impulse[0] = 1
  const wav = Buffer.from(encodeWav([impulse], 48000, 24))
  await expect(page.locator('#ir-file')).toBeEnabled()
  await page.locator('#ir-file').setInputFiles({ name: 'impulse.wav', mimeType: 'audio/wav', buffer: wav })
  await expect(page.locator('#ir-summary')).toHaveText('IR: impulse.wav (100 ms)')
  await expect(page.locator('label.file-button[for="ir-file"]')).toHaveText('Change IR…')
  await expect(page.locator('#tone-error')).toBeHidden()
  await expect(page.locator('#clear-ir')).toBeEnabled()

  await page.locator('#record').click()
  await expect.poll(looperState).toMatch(/count-in|recording-base/)
  await expect(page.locator('#ir-file')).toBeDisabled() // loading waits for Stop (SPEC rule 6)
  await expect(page.locator('#clear-ir')).toBeDisabled() // dropping it mid-take would leave a gap
  await expect.poll(looperState, { timeout: 15_000 }).toBe('playing')
  await page.locator('#stop').click()
  await expect.poll(looperState).toBe('idle')
  const { files } = await exportTake()
  expect(takeJsonOf(files)).toMatchObject({ toneMode: 'amp', modelName: 'identity.nam' })
  expect(peakOf(decodeEntry(files, 'base.wav').channels)).toBeGreaterThan(0.01)

  await page.locator('#clear-ir').click()
  await expect(page.locator('#ir-summary')).toHaveText('No IR: the model plays without a cabinet.')
  await expect(page.locator('#clear-ir')).toBeDisabled()
  await page.locator('#clear').click() // exported, so one press clears it
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'false')
})

test('an unexported take: Clear asks for a second press, and leaving the page asks first', async () => {
  // A cancelable stand-in for the browser's own event: the guard calls preventDefault on it.
  const unloadBlocked = (): Promise<boolean> => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })
  expect(await unloadBlocked()).toBe(false)

  await page.locator('#record').click()
  await expect.poll(looperState, { timeout: 15_000 }).toBe('playing')
  await page.locator('#stop').click()
  await expect.poll(looperState).toBe('idle')
  expect(await unloadBlocked()).toBe(true)

  // One press only arms it, and the arming lapses.
  await page.locator('#clear').click()
  await expect(page.locator('#clear')).toHaveText('Clear take?')
  await expect(page.locator('#looper-hint')).toContainText('has not been exported')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'true')
  await expect(page.locator('#clear')).toHaveText('Clear', { timeout: 5_000 })
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'true')

  // Two presses delete it, and the page can go without asking.
  await page.locator('#clear').click()
  await page.locator('#clear').click()
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'false')
  await expect(page.locator('#clear')).toHaveText('Clear')
  expect(await unloadBlocked()).toBe(false)
})

test('the recorder hears only the guitar: loop, click and drone never reach a take (SPEC rule 2)', async () => {
  await page.locator('#record').click()
  await expect.poll(looperState, { timeout: 15_000 }).toBe('playing')

  // Take the guitar away (as an unplug would) while the base loops, the click
  // runs and the drone plays. An overdub now has nothing to record but leaks.
  await page.evaluate(() => {
    const streams = (window as unknown as { __streams: MediaStream[] }).__streams
    streams[streams.length - 1].getAudioTracks()[0].dispatchEvent(new Event('ended'))
  })
  await expect(page.locator('#input-error')).toContainText('Input lost')
  expect(await looperState()).toBe('playing') // a loop with no take running plays on
  await page.locator('#drone').click()
  await expect(page.locator('#drone')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#click')).toHaveAttribute('aria-pressed', 'true')
  // Bypass for the overdub (allowed while the loop only plays): take.json must say so.
  await page.locator('#mode-bypass').click()
  await expect(page.locator('#mode-bypass')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('#overdub').click()
  await expect.poll(looperState).toMatch(/overdub-armed|recording-overdub/)
  await expect.poll(looperState, { timeout: 15_000 }).toBe('playing')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-overdub', 'true')

  const { files } = await exportTake()
  expect(peakOf(decodeEntry(files, 'base.wav').channels)).toBeGreaterThan(0.01)
  expect(peakOf(decodeEntry(files, 'overdub.wav').channels)).toBeLessThan(1e-4)
  const take = takeJsonOf(files)
  expect(take).toMatchObject({ toneMode: 'amp', modelName: 'identity.nam', overdub: { toneMode: 'bypass', modelName: null } })

  await page.locator('#mode-amp').click()
  await page.locator('#drone').click()
  await page.locator('#stop').click()
  await page.locator('#clear').click()
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'false')
  // Back to a working input for the tests that follow.
  await page.locator('#device').selectOption({ label: 'System default' })
  await expect(page.locator('#input-error')).toBeHidden()
  await expect(page.locator('#accepted li').first()).toContainText('Channels')
})

test('(g) the fretboard lights the note the fake device plays', async () => {
  // Chromium's fake device beeps at about G4 (MIDI 67). In A Aeolian on frets
  // 0 to 15 that pitch sits in three places: frets 3, 8 and 12.
  const lit = await page.waitForFunction(() => {
    const heard = document.querySelector<HTMLElement>('#heard')
    const rings = document.querySelectorAll('svg.fb .fb-heard').length
    if (!heard || heard.dataset.midi === '' || rings === 0) return null
    return { midi: Number(heard.dataset.midi), note: heard.querySelector('#heard-note')?.textContent ?? '', rings }
  }, null, { polling: 'raf', timeout: 10_000 })
  const { midi, note, rings } = await lit.jsonValue() as { midi: number; note: string; rings: number }
  expect(midi).toBe(67)
  expect(note).toBe('G4')
  expect(rings).toBe(3)
  await expect(page.locator('svg.fb')).toHaveAttribute('aria-label', /Heard G4 \(b7\), 3 places on the neck\.$/)
})

test('keys: Space walks the looper even on a focused button; Esc mutes everything', async () => {
  // Focus on the monitoring toggle: Space must start a take, never switch monitoring on.
  await page.locator('#monitor').focus()
  await page.keyboard.press('Space')
  await expect.poll(looperState).toMatch(/count-in|recording-base/)
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await expect.poll(looperState).toBe('idle')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'false')
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false')

  // A file picker keeps its own Space: it opens the picker and records nothing.
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
  await page.locator('#model-file').focus()
  await page.keyboard.press('Space')
  await chooser
  expect(await looperState()).toBe('idle')

  // In a text field the keys stand down: typing "r" records nothing.
  await page.locator('#bpm').focus()
  await page.keyboard.press('r')
  expect(await looperState()).toBe('idle')
  // An out-of-range tempo is put back, and says so.
  await page.locator('#bpm').fill('500')
  await page.locator('#bpm').press('Enter')
  await expect(page.locator('#bpm')).toHaveValue('120')
  await expect(page.locator('#bpm-note')).toHaveText('Tempo must be 30–300 BPM; kept 120.')
  // Enter commits and hands the keys back to the looper.
  await page.locator('#bpm').fill('120')
  await page.locator('#bpm').press('Enter')
  await expect(page.locator('#bpm')).not.toBeFocused()
  await expect(page.locator('#bpm-note')).toBeHidden()
  await page.keyboard.press('r')
  await expect.poll(looperState).toBe('count-in')
  await page.keyboard.press('s')
  await expect.poll(looperState).toBe('idle')

  await page.keyboard.press('Escape')
  await expect(page.locator('#panic')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#panic').click()
  await expect(page.locator('#panic')).toHaveAttribute('aria-pressed', 'false')
})

test('toggles keep one name; the deck shows monitoring, and what Panic did to it', async () => {
  // The name never flips to the state: aria-pressed carries it.
  for (const [id, name] of [['monitor', 'Monitoring'], ['drone', 'Drone'], ['click', 'Click'], ['names', 'Note names'], ['panic', 'Panic mute']]) {
    await expect(page.locator(`#${id}`), id).toHaveAccessibleName(name)
  }
  await page.locator('#names').click()
  await expect(page.locator('#names')).toHaveAccessibleName('Note names')
  await expect(page.locator('#names')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#names').click()

  await expect(page.locator('#monitor-note')).toContainText('Monitoring is off')
  await page.locator('#deck-monitor').click()
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#monitor-note')).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#monitor-note')).toContainText('Everything is muted')
  await page.locator('#panic').click()
  // Unmuted, monitoring stays off (SPEC rule 4), and the deck says why.
  await expect(page.locator('#panic')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#monitor-note')).toContainText('Panic turned monitoring off')
  await expect(page.locator('#deck-monitor')).toBeVisible()
})

test('key and drone: the board follows the key, the drone follows the root', async () => {
  await page.locator('#root').selectOption('0')
  await page.locator('#scale').selectOption('lydian')
  await expect(page.locator('svg.fb')).toHaveAttribute('aria-label', /^Fretboard, C Lydian/)
  await expect(page.locator('#formula')).toContainText('#4')

  await page.locator('#drone').click()
  await expect(page.locator('#drone')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#root').selectOption('9') // retunes while on
  await expect(page.locator('#drone')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#drone').click()
  await expect(page.locator('#drone')).toHaveAttribute('aria-pressed', 'false')
  await page.locator('#scale').selectOption('aeolian')
  await expect(page.locator('svg.fb')).toHaveAttribute('aria-label', /^Fretboard, A Aeolian/)
})

test('a lost input shows an error and opens nothing else; Choose again recovers', async () => {
  await expect(page.locator('#input-error')).toBeHidden()
  // A fake device cannot be unplugged; its track's 'ended' event is what an unplug fires.
  await page.evaluate(() => {
    const streams = (window as unknown as { __streams: MediaStream[] }).__streams
    const track = streams[streams.length - 1].getAudioTracks()[0]
    track.dispatchEvent(new Event('ended'))
  })
  await expect(page.locator('#input-error')).toContainText('Input lost')
  await expect(page.locator('#choose-again')).toBeVisible()
  await expect(page.locator('#device')).toHaveValue('')
  await expect(page.locator('#accepted li')).toHaveCount(0)
  await expect(page.locator('#heard')).toHaveAttribute('data-midi', '')
  // No silent fallback: no new stream was opened behind the player's back.
  const opened = await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length)

  await page.locator('#choose-again').click()
  await expect(page.locator('#device')).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length)).toBe(opened)

  await page.locator('#device').selectOption({ label: 'Fake Audio Input 1' })
  await expect(page.locator('#accepted li').first()).toContainText('Channels')
  await expect(page.locator('#input-error')).toBeHidden()
  await expect(page.locator('#device option:checked')).toHaveText('Fake Audio Input 1')
})

test('at phone width, no keyboard focus stop hides under the sticky deck (WCAG 2.4.11)', async () => {
  const desktop = page.viewportSize()
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    // Start from the last focus stop on the page and walk back to the deck.
    await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('button, input, select, [tabindex="0"]')]
        .filter(el => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0)
      all[all.length - 1].focus()
    })
    const covered: string[] = []
    let walked = 0
    for (let i = 0; i < 80; i++) {
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        const deck = document.querySelector('.deck') as HTMLElement
        if (!el || el === document.body || deck.contains(el)) return null
        const r = el.getBoundingClientRect()
        return { id: el.id || el.className, top: r.top, deckBottom: deck.getBoundingClientRect().bottom }
      })
      if (stop === null) break
      walked++
      if (stop.top < stop.deckBottom - 0.5) covered.push(`${stop.id} at ${Math.round(stop.top)} under a deck ending at ${Math.round(stop.deckBottom)}`)
      await page.keyboard.press('Shift+Tab')
    }
    expect(walked).toBeGreaterThan(10)
    expect(covered).toEqual([])

    // The neck scrolls sideways here; a heard note's other places off to the
    // right get a tag. (The fake device's beep is about G4: frets 3, 8 and 12.)
    await page.locator('.fb-viewport').evaluate(el => { el.scrollLeft = 0 })
    const tag = await page.waitForFunction(() => {
      const t = document.querySelector<HTMLElement>('.fb-more--right')
      return t && !t.hidden ? t.textContent : null
    }, null, { timeout: 10_000 })
    expect(await tag.jsonValue()).toMatch(/^\d+ more →$/)
  } finally {
    if (desktop) await page.setViewportSize(desktop)
  }
})

test('the whole session raised no CSP violation, console error or page error', async () => {
  expect(await cspViolations()).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('settings survive a reload; audio and monitoring do not', async () => {
  await page.reload()
  await expect(page.locator('#bpm')).toHaveValue('120')
  await expect(page.locator('#bars')).toHaveValue('1')
  await expect(page.locator('#start-audio')).toHaveText('Start audio')
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#looper-state')).toHaveAttribute('data-has-base', 'false')
  expect(await cspViolations()).toEqual([])
})
