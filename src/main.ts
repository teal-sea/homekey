// ─── Page wiring ────────────────────────────────────────────────────
// The page: wires the audio modules to the controls built in ui/page.ts.
// Nothing here makes sound or computes a note itself; it decides WHEN the
// modules act and shows what they report.
//
// Order of life: the page and fretboard draw at once; "Start audio" (a user
// gesture, for autoplay policy) creates the one Graph and everything on it;
// "Allow input" opens a device. Monitoring starts off and only the player
// turns it on (SPEC rule 4).

import { createGraph, type Graph } from './audio/graph'
import { InputError, listInputs, onInputsChanged, openInput, type InputDevice, type InputSession } from './audio/input'
import { createNoteFollower, type HeardNote, type NoteFollower } from './audio/analysis'
import { createTone, type Tone, type ToneMode } from './audio/tone'
import { createDrone, type Drone } from './audio/drone'
import { BPM_MAX, BPM_MIN, createTransport, type Transport } from './audio/transport'
import {
  createLooper, defaultLatencyMs, looperReducer,
  type Looper, type LooperEvent, type LooperSnapshot, type LooperState, type TakeMeta,
} from './audio/looper'
import { computeFretboard, type FretboardCells } from './theory/fretboard'
import { midiName, toPc } from './theory/notes'
import { characterSemitones, characterLabel, formulaOf, getScale, keyLabel, keyRootName, keyUsesFlats, SCALE_KEYS, type ScaleKey } from './theory/scales'
import { createFretboardView } from './ui/fretboard-view'
import { buildPage } from './ui/page'
import { replaceOptions, say, setPressed, setText, show } from './ui/dom'
import { downloadFile } from './ui/download'
import { footswitchLive, shortcutFor, shortcutsAllowed, type ShortcutAction, type TargetLike } from './ui/keys'
import { BAR_CHOICES, browserStorage, loadSettings, saveSettings, type Bars } from './ui/settings'
import { NOTHING_SEEN, markExported, track, unsaved, type TakeGuard } from './ui/take-guard'
import {
  acceptedSummary, audioStatus, formatCents, formatDb, latencyExplanation, LOOPER_LABELS, meterFill,
  modelLines, processingWarning, sampleRateWarning, toDb,
} from './ui/format'

// ─── State ───

const storage = browserStorage()
const settings = loadSettings(storage)
const persist = (): void => { saveSettings(storage, settings) }

interface Rig { graph: Graph; tone: Tone; transport: Transport; drone: Drone; looper: Looper | null }

type InputStatus =
  | { kind: 'closed' }
  | { kind: 'opening' }
  | { kind: 'open' }
  | { kind: 'lost'; reason: string }
  | { kind: 'error'; message: string }

const SYSTEM_DEFAULT = '*system-default'
const CHOOSE = ''

let rig: Rig | null = null
let startError: string | null = null
let looperLoadError: string | null = null
let session: InputSession | null = null
let follower: NoteFollower | null = null
let inputStatus: InputStatus = { kind: 'closed' }
let inputNotice: string | null = null
let devices: InputDevice[] = []
let openToken = 0
let heard: HeardNote | null = null
let toneMessage: string | null = null
// What each layer was recorded through, captured when its take is accepted:
// the tone can change between the base and the overdub.
let takeMeta: TakeMeta | null = null
let overdubMeta: TakeMeta | null = null
// Export is the only backup (SPEC rule 10). A take holds audio the last export
// does not until it is exported; Clear and leaving the page ask first.
let takeGuard: TakeGuard = NOTHING_SEEN
let clearArmed: ReturnType<typeof setTimeout> | null = null
// Panic switches monitoring off; on unmute the deck says so, and never switches it back.
let panicTookMonitoring = false
let beatText = ''
let wasRunning = false
let peakHold = { db: -90, at: 0 }
let cells: FretboardCells = computeFretboard({ rootPc: settings.rootPc, scaleKey: settings.scaleKey })

const ui = buildPage(document.getElementById('app') as HTMLElement)
const fretboard = createFretboardView(ui.fretboard)

// ─── Audio start ───

function startAudio(): void {
  if (rig) {
    // Suspended by the browser (another tab, an interruption): the button resumes it.
    void rig.graph.ctx.resume().finally(renderAll)
    return
  }
  let graph: Graph
  try {
    graph = createGraph()
  } catch (err) {
    startError = `Audio could not start: ${messageOf(err)}`
    renderAll()
    return
  }
  const tone = createTone(graph)
  tone.setMode(settings.toneMode)
  tone.setInputGainDb(settings.inputGainDb)
  tone.setOutputGainDb(settings.outputGainDb)
  const transport = createTransport(graph, { bpm: settings.bpm, beatsPerBar: 4, bars: settings.bars, countInBars: 1 })
  transport.setClick(settings.clickOn)
  transport.setClickLevel(settings.clickLevel)
  const drone = createDrone(graph)
  drone.setLevel(settings.droneLevel)
  const current: Rig = { graph, tone, transport, drone, looper: null }
  rig = current
  startError = null

  graph.ctx.addEventListener('statechange', renderAll)
  // A load in flight holds Record and Play back, so the looper buttons follow the tone too.
  tone.onChange(renderLooper)
  transport.onBeat(b => {
    beatText = b.countIn ? `Count-in ${b.beat + 1}` : `Bar ${b.bar + 1} · beat ${b.beat + 1}`
    setText(ui.beatLabel, beatText)
  })
  requestAnimationFrame(frame)
  renderAll()

  createLooper(graph, transport).then(looper => {
    if (settings.latencyMs !== null) looper.setLatencyMs(settings.latencyMs)
    looper.subscribe(() => { looperChanged(); renderLooper() })
    current.looper = looper
    renderAll()
  }, err => {
    looperLoadError = `The recorder failed to load, so the looper is off: ${messageOf(err)}`
    renderAll()
  })
}

// ─── Input ───

async function refreshDevices(): Promise<void> {
  devices = await listInputs()
  renderDeviceOptions()
}

function closeSession(): void {
  follower?.stop()
  follower = null
  rig?.tone.disconnectInput()
  session?.close()
  session = null
  heard = null
  renderHeard()
}

/** Open exactly this device (null = the system default, chosen as such). Never another one (SPEC rule 5). */
async function openDevice(deviceId: string | null): Promise<void> {
  const r = rig
  if (!r) return
  const token = ++openToken
  closeSession()
  inputStatus = { kind: 'opening' }
  inputNotice = null
  renderInput()
  try {
    const s = await openInput(r.graph, deviceId, 2)
    if (token !== openToken) { s.close(); return } // a later choice won
    session = s
    settings.deviceId = deviceId
    const channel = settings.channel < s.channelCount ? settings.channel : 0
    if (channel !== settings.channel) inputNotice = `This input has ${s.channelCount} channel; using channel 1.`
    s.setChannel(channel)
    persist()
    r.tone.connectInput(s.mono, s.stereo)
    follower = createNoteFollower(r.graph, s.mono)
    follower.onNote(n => { heard = n; renderHeard() })
    s.onLost(reason => { if (session === s) inputLost(reason) })
    inputStatus = { kind: 'open' }
  } catch (err) {
    if (token !== openToken) return
    inputStatus = { kind: 'error', message: err instanceof InputError ? err.userMessage : `The audio input could not be opened: ${messageOf(err)}` }
  }
  await refreshDevices()
  renderAll()
}

function inputLost(reason: string): void {
  // A take whose input died is not a take: stop it rather than loop silence.
  if (rig?.looper?.isBusy()) rig.looper.stop()
  closeSession()
  inputStatus = { kind: 'lost', reason }
  void refreshDevices()
  renderAll()
}

function allowInput(): void {
  void openDevice(settings.deviceId)
}

function chooseAgain(): void {
  inputStatus = { kind: 'closed' }
  void refreshDevices().then(() => {
    ui.deviceSelect.value = CHOOSE
    ui.deviceSelect.focus()
    renderInput()
  })
}

// ─── Looper actions ───

function looperState(s: LooperSnapshot): LooperState {
  return { mode: s.state, hasBase: s.hasBase, hasOverdub: s.hasOverdub, error: s.error }
}

/** True when the looper would accept the event now: the reducer is the single source of truth. */
function accepts(event: LooperEvent['type']): boolean {
  const looper = rig?.looper
  if (!looper) return false
  const s = looperState(looper.snapshot())
  return looperReducer(s, { type: event } as LooperEvent) !== s
}

/**
 * Why Record or Play must wait although the looper would take them, or null.
 * Both start the transport: a model or IR load already under way would freeze
 * the audio thread during the count-in (SPEC rule 6), and with no input open
 * a base take could only be silence.
 */
function startBlockReason(action: 'record' | 'play'): string | null {
  if (!rig) return null
  if (rig.tone.busy()) return 'Record and Play wait for the load to finish, so it cannot land in a take.'
  if (action === 'record' && !session) return 'No input is open, so a take would be silent. Allow input first.'
  return null
}

const canStart = (action: 'record' | 'play'): boolean => accepts(action) && startBlockReason(action) === null

// While the loop plays, Clear IR is allowed and ducks the guitar for about
// 40 ms; an overdub armed in that moment could catch the dip at its start.
const canOverdub = (): boolean => accepts('overdub') && !(rig?.tone.busy() ?? false)

/** Counting in or recording: tone, input and loads stay as they are until the take is done. */
const looperBusy = (): boolean => rig?.looper?.isBusy() ?? false

/** A loop exists that the last export does not hold. */
const unsavedTake = (): boolean => unsaved(takeGuard, rig?.looper?.snapshot() ?? null)

function currentMeta(): TakeMeta {
  const mode = rig?.tone.mode() ?? settings.toneMode
  const channels = session?.channelCount ?? 2
  const channelLayout = mode === 'amp'
    ? `input channel ${(session?.selectedChannel ?? settings.channel) + 1} through the amp, mono on L and R`
    : channels === 1 ? 'mono input on L and R' : 'input channels 1 and 2 as L and R, unprocessed'
  return { toneMode: mode, modelName: mode === 'amp' ? rig?.tone.model()?.name ?? null : null, channelLayout }
}

function act(action: ShortcutAction): void {
  const looper = rig?.looper
  if (!looper) return
  switch (action) {
    case 'record':
      if (!canStart('record')) return
      takeMeta = currentMeta()
      looper.record()
      break
    case 'overdub':
      if (!canOverdub()) return
      overdubMeta = currentMeta()
      looper.overdub()
      break
    case 'stop': looper.stop(); break
    case 'play':
      if (!canStart('play')) return
      looper.play()
      break
    case 'undo': looper.undo(); break
  }
}

async function exportTake(): Promise<void> {
  const looper = rig?.looper
  if (!looper) return
  try {
    const hasOverdub = looper.snapshot().hasOverdub
    downloadFile(await looper.exportArchive(takeMeta ?? currentMeta(), hasOverdub ? overdubMeta ?? currentMeta() : null))
    takeGuard = markExported(takeGuard)
    disarmClear(false)
    guardUnload(unsavedTake())
    renderLooper()
  } catch (err) {
    say(ui.looperError, `Export failed: ${messageOf(err)}`)
  }
}

/**
 * What follows from a looper or transport change, whether or not anything is
 * redrawn: the tone's load lock (the second fence behind SPEC rule 6; the
 * disabled pickers are the first) and the unexported-take guard. Called from
 * the looper's subscription and when the frame loop sees the transport flip.
 */
function looperChanged(): void {
  const r = rig
  if (r) r.tone.setLoadLock((r.looper?.isBusy() ?? false) || r.transport.running())
  takeGuard = track(takeGuard, r?.looper?.snapshot() ?? null)
  if (!unsavedTake()) disarmClear(false)
  guardUnload(unsavedTake())
}

// The browser asks before a reload or close loses an unexported take. Added
// only while there is one: an unload handler can keep a page out of the
// back/forward cache.
const askBeforeUnload = (e: BeforeUnloadEvent): void => {
  e.preventDefault()
  e.returnValue = true // older browsers ask only when this is set
}
let unloadGuarded = false
function guardUnload(on: boolean): void {
  if (on === unloadGuarded) return
  unloadGuarded = on
  if (on) window.addEventListener('beforeunload', askBeforeUnload)
  else window.removeEventListener('beforeunload', askBeforeUnload)
}

const CLEAR_CONFIRM_MS = 3000

/** Clear deletes an unexported take only on a second press within a few seconds. */
function pressClear(): void {
  const looper = rig?.looper
  if (!looper || !accepts('clear')) return
  if (unsavedTake() && clearArmed === null) {
    clearArmed = setTimeout(() => disarmClear(), CLEAR_CONFIRM_MS)
    renderLooper()
    return
  }
  disarmClear(false)
  looper.clear()
  takeMeta = null
  overdubMeta = null
}

function disarmClear(render = true): void {
  if (clearArmed === null) return
  clearTimeout(clearArmed)
  clearArmed = null
  if (render) renderLooper()
}

function setPanic(on: boolean): void {
  const graph = rig?.graph
  if (!graph) return
  // A panic is usually feedback: unmuting must not bring it straight back.
  if (on && graph.isMonitoring()) {
    graph.setMonitoring(false)
    panicTookMonitoring = true
  }
  graph.setPanic(on)
  renderTone()
  renderDeck()
}

/** The one way monitoring changes, from the Tone panel or the deck. Only ever by the player (SPEC rule 4). */
function setMonitoring(on: boolean): void {
  const graph = rig?.graph
  if (!graph) return
  graph.setMonitoring(on)
  if (on) panicTookMonitoring = false
  renderTone()
  renderDeck()
}

// ─── Tone actions ───

async function loadModelFile(file: File): Promise<void> {
  const tone = rig?.tone
  if (!tone) return
  toneMessage = null
  try {
    await tone.loadModel({ name: file.name, text: await file.text() })
    ui.slimInput.value = '1'
  } catch (err) {
    toneMessage = messageOf(err)
  }
  renderTone()
}

async function loadIrFile(file: File): Promise<void> {
  const tone = rig?.tone
  if (!tone) return
  toneMessage = null
  try {
    await tone.loadIr({ name: file.name, data: await file.arrayBuffer() })
  } catch (err) {
    toneMessage = messageOf(err)
  }
  renderTone()
}

/** Why loading a model or IR is off right now, or null when it is allowed (SPEC rule 6). */
function loadBlockReason(): string | null {
  if (!rig) return 'Start audio to load a model.'
  const { tone, transport, looper, graph } = rig
  if (!graph.ampSupported) return tone.error()
  switch (tone.status()) {
    case 'loading-engine': return 'The amp engine is starting.'
    case 'error': return 'The amp engine failed to start. Reload the page to try again.'
    case 'loading-model': return 'Loading…'
    default: break
  }
  if (tone.busy()) return 'Loading…' // an IR load sets no status of its own
  if (looper?.isBusy() || transport.running()) {
    return 'Models and IRs load only while the looper is stopped: a model load freezes all audio for a moment. Press Stop first.'
  }
  return null
}

// ─── Rendering ───

function renderDeck(): void {
  const graph = rig?.graph
  ui.startBtn.disabled = graph !== undefined && graph.ctx.state === 'running'
  setText(ui.startBtn, !graph ? 'Start audio' : graph.ctx.state === 'running' ? 'Audio on' : 'Resume audio')
  if (startError) {
    setText(ui.audioStatus, startError)
  } else if (graph) {
    const ctx = graph.ctx as AudioContext & { outputLatency?: number }
    setText(ui.audioStatus, audioStatus({
      sampleRate: ctx.sampleRate, renderQuantum: graph.renderQuantum,
      outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency, state: ctx.state,
    }))
  }
  say(ui.audioWarning, graph && !graph.ampSupported
    ? `Render quantum is ${graph.renderQuantum}, not 128: the amp model cannot run here, so only Bypass works.`
    : null)
  ui.panicBtn.disabled = !graph
  const panicked = graph?.isPanicked() ?? false
  setPressed(ui.panicBtn, panicked)
  document.body.classList.toggle('panicked', panicked)
  renderMonitorNote()
}

/**
 * The deck's line about what the player hears. The meter moves whether or
 * not monitoring is on, and its switch is far down the page on a phone, so
 * the deck says when the guitar is not coming through here, and why.
 */
function renderMonitorNote(): void {
  const graph = rig?.graph
  const panicked = graph?.isPanicked() ?? false
  const text = !graph ? null
    : panicked ? 'Everything is muted. Press Panic mute again to unmute.'
    : !session || graph.isMonitoring() ? null
    : panicTookMonitoring ? 'Panic turned monitoring off. Turn it back on when it is safe.'
    : 'Monitoring is off: you are not hearing the guitar through this page.'
  setText(ui.monitorText, text ?? '')
  show(ui.monitorNote, text !== null)
  show(ui.deckMonitorBtn, text !== null && !panicked)
}

function renderInput(): void {
  // Reopening, switching device or channel mid-take would cut a hole in it.
  const busy = looperBusy()
  ui.allowBtn.disabled = !rig || inputStatus.kind === 'opening' || busy
  setText(ui.allowBtn, inputStatus.kind === 'opening' ? 'Opening…' : session ? 'Reopen input' : 'Allow input')
  ui.deviceSelect.disabled = !rig || inputStatus.kind === 'opening' || busy || (devices.length === 0 && !session && inputStatus.kind === 'closed')
  ui.channelSelect.disabled = !session || session.channelCount < 2 || busy
  if (session) ui.channelSelect.value = String(session.selectedChannel)

  ui.accepted.replaceChildren(...(session ? acceptedSummary(session.settings) : []).map(t => {
    const li = document.createElement('li')
    li.textContent = t
    return li
  }))
  const warnings = session
    ? [inputNotice, processingWarning(session.settings), rig ? sampleRateWarning(session.settings, rig.graph.ctx.sampleRate) : null]
    : []
  say(ui.inputWarning, warnings.filter(Boolean).join(' ') || null)

  const problem = inputStatus.kind === 'lost' ? `Input lost. ${inputStatus.reason} Nothing else was opened in its place.`
    : inputStatus.kind === 'error' ? inputStatus.message
    : null
  say(ui.inputError, problem)
  show(ui.chooseAgainBtn, problem !== null)
  ui.meter.dataset.state = session ? 'open' : 'closed'
}

function renderDeviceOptions(): void {
  const options = [
    ...(session ? [] : [{ value: CHOOSE, label: 'Choose an input…', disabled: true }]),
    { value: SYSTEM_DEFAULT, label: 'System default' },
    ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Input ${i + 1} (name hidden until access is allowed)` })),
  ]
  const value = session ? (settings.deviceId ?? SYSTEM_DEFAULT) : CHOOSE
  // The open device may be missing from a list taken without permission; keep it selectable.
  if (session && settings.deviceId && !devices.some(d => d.deviceId === settings.deviceId)) {
    options.push({ value: settings.deviceId, label: session.settings.label ?? 'Current input' })
  }
  replaceOptions(ui.deviceSelect, options, value)
}

function renderTone(): void {
  const tone = rig?.tone
  const ampSupported = rig?.graph.ampSupported ?? true
  const mode: ToneMode = tone?.mode() ?? settings.toneMode
  // Switching mode ducks the guitar for about 30 ms, dropping the IR for about
  // 40 ms; mid-take that gap would be recorded and looped forever, so they wait
  // for the take.
  const busy = looperBusy()
  setPressed(ui.ampBtn, mode === 'amp')
  setPressed(ui.bypassBtn, mode === 'bypass')
  ui.ampBtn.disabled = !ampSupported || busy
  ui.bypassBtn.disabled = busy
  setText(ui.modeHelp, busy
    ? 'Tone mode is locked while a take records: switching drops the sound for a moment, and the take would keep the gap.'
    : mode === 'amp'
      ? 'Amp: the guitar channel goes through the NAM model, and the IR if one is loaded.'
      : 'Bypass: the input goes straight through in stereo, for a signal already processed by a pedal or multi-effects like a GT-1.')

  const status = !rig ? 'off' : tone?.status() ?? 'off'
  ui.toneStatus.dataset.status = status
  const model = tone?.model() ?? null
  setText(ui.toneStatus, ({
    'off': 'Amp engine: waiting for audio.',
    'loading-engine': 'Amp engine: starting…',
    'no-model': mode === 'amp' ? 'Amp ready, no model loaded: amp mode stays silent until you load one.' : 'Amp ready, no model loaded.',
    'loading-model': 'Loading…',
    'ready': `Ready: ${model?.name ?? ''}`,
    'unsupported': 'Amp unavailable in this browser setup: Bypass only.',
    'error': 'Amp engine failed to start.',
  } as Record<string, string>)[status] ?? status)

  setText(ui.modelPickLabel, model ? 'Change model…' : 'Load model…')
  if (model) {
    const lines = modelLines(model)
    setText(ui.modelSummary, `Model: ${lines.summary}`)
    say(ui.modelWarning, lines.warning)
  } else {
    setText(ui.modelSummary, 'No model loaded.')
    say(ui.modelWarning, null)
  }
  show(ui.slimRow, model?.slimmable ?? false)
  setText(ui.slimValue, `${Math.round(Number(ui.slimInput.value) * 100)}%`)
  const ir = tone?.ir() ?? null
  setText(ui.irSummary, ir ? `IR: ${ir.name} (${Math.round(ir.seconds * 1000)} ms)` : 'No IR: the model plays without a cabinet.')
  setText(ui.irPickLabel, ir ? 'Change IR…' : 'Load IR…')

  const blocked = loadBlockReason()
  ui.modelInput.disabled = blocked !== null
  ui.irInput.disabled = blocked !== null
  ui.slimInput.disabled = blocked !== null
  ui.clearIrBtn.disabled = !ir || busy
  say(ui.loadReason, blocked)

  setText(ui.inputGainValue, formatDb(settings.inputGainDb))
  setText(ui.outputGainValue, formatDb(settings.outputGainDb))
  const monitoring = rig?.graph.isMonitoring() ?? false
  ui.monitorBtn.disabled = !rig
  setPressed(ui.monitorBtn, monitoring)
  renderMonitorNote()

  const engineError = tone && (tone.status() === 'error' || tone.status() === 'unsupported') ? tone.error() : null
  say(ui.toneError, toneMessage ?? engineError)
}

function renderKey(): void {
  const { rootPc, scaleKey } = settings
  replaceOptions(ui.rootSelect, Array.from({ length: 12 }, (_, pc) => ({ value: String(pc), label: keyRootName(pc, scaleKey) })), String(rootPc))
  if (ui.scaleSelect.options.length === 0) {
    replaceOptions(ui.scaleSelect, SCALE_KEYS.map(k => ({ value: k, label: getScale(k).name })), scaleKey)
  }
  ui.scaleSelect.value = scaleKey
  setPressed(ui.namesBtn, settings.showNames)
  const character = characterSemitones(scaleKey) === null ? '' : ` Character note: ${characterLabel(scaleKey)}.`
  setText(ui.formula, `${keyLabel(rootPc, scaleKey)}: ${formulaOf(scaleKey)}.${character}`)
  const droneOn = rig?.drone.isOn() ?? false
  ui.droneBtn.disabled = !rig
  setPressed(ui.droneBtn, droneOn)
  renderHeard()
}

function renderHeard(): void {
  const midi = heard?.midi ?? null
  fretboard.update(cells, { heardMidi: midi, showNames: settings.showNames, scaleKey: settings.scaleKey })
  ui.heard.dataset.midi = midi === null ? '' : String(midi)
  if (midi === null) {
    setText(ui.heardNote, '–')
    setText(ui.heardCents, '')
    setText(ui.heardRole, session ? 'Play a note' : 'Allow input to see what you play')
    return
  }
  setText(ui.heardNote, midiName(midi, keyUsesFlats(settings.rootPc, settings.scaleKey)))
  // Any cell of this pitch class carries its interval in the current key.
  const cell = cells.flat().find(c => c.pc === toPc(midi))
  setText(ui.heardRole, !cell ? '' : cell.isRoot ? 'the root' : cell.inScale ? `${cell.interval}, in the scale` : `${cell.interval}, outside the scale`)
  renderCents()
}

function renderCents(): void {
  const now = follower?.current() ?? heard
  setText(ui.heardCents, now ? formatCents(now.cents) : '')
}

function renderLooper(): void {
  const looper = rig?.looper ?? null
  const snap = looper?.snapshot() ?? null
  const mode = snap?.state ?? 'idle'
  ui.stateLabel.dataset.state = mode
  ui.stateLabel.dataset.hasBase = String(snap?.hasBase ?? false)
  ui.stateLabel.dataset.hasOverdub = String(snap?.hasOverdub ?? false)
  const layers = snap?.hasBase ? (snap.hasOverdub ? ' · base + overdub' : ' · base') : ''
  setText(ui.stateLabel, `${LOOPER_LABELS[mode]}${layers}`)

  ui.recordBtn.disabled = !canStart('record')
  ui.overdubBtn.disabled = !canOverdub()
  ui.stopBtn.disabled = !accepts('stop')
  ui.playBtn.disabled = !canStart('play')
  ui.undoBtn.disabled = !accepts('undo')
  ui.clearBtn.disabled = !accepts('clear')
  setText(ui.clearBtn, clearArmed !== null ? 'Clear take?' : 'Clear')
  ui.exportBtn.disabled = !(snap?.hasBase && (mode === 'idle' || mode === 'playing' || mode === 'error'))

  say(ui.looperError, snap?.error ?? looperLoadError)
  say(ui.looperHint, looperHint(snap))

  const locked = snap?.locked ?? false
  // Tempo and length can be set before audio starts; the transport takes them on creation.
  ui.bpmInput.disabled = locked
  ui.barsSelect.disabled = locked
  show(ui.lockNote, locked)
  if (document.activeElement !== ui.bpmInput) ui.bpmInput.value = String(rig?.transport.params().bpm ?? settings.bpm)
  ui.barsSelect.value = String(rig?.transport.params().bars ?? settings.bars)
  setPressed(ui.clickBtn, settings.clickOn)
  ui.latencyInput.disabled = !looper
  ui.latencyAutoBtn.disabled = !looper || settings.latencyMs === null
  if (looper && document.activeElement !== ui.latencyInput) ui.latencyInput.value = String(looper.latencyMs())
  renderLatencyHelp()
  renderInput() // device and channel are held still during a take
  renderTone() // the load lock and the mode buttons follow the looper
}

/** The line under the deck buttons: why Record waits, or why a take would be empty. */
function looperHint(snap: LooperSnapshot | null): string | null {
  if (!rig) return null
  if (!rig.looper) return 'The recorder is loading…'
  const mode = snap?.state ?? 'idle'
  if (clearArmed !== null) return 'This take has not been exported. Press Clear take? again to delete it, or Export take to keep it.'
  if (mode === 'idle' && rig.tone.busy()) return startBlockReason('play')
  // Through the count-in and the take too: a player who starts anyway sees why the loop is empty.
  const firstTake = !snap?.hasBase && (mode === 'idle' || mode === 'count-in' || mode === 'recording-base')
  if (!firstTake) return null
  if (!session) return startBlockReason('record')
  if (rig.tone.mode() === 'amp' && !rig.tone.model()) {
    return mode === 'idle'
      ? 'Amp mode has no model loaded, so a take would be silent. Load a model or switch to Bypass.'
      : 'Amp mode has no model loaded, so this take will be silent. Stop, then load a model or switch to Bypass.'
  }
  return null
}

function renderLatencyHelp(): void {
  const ctx = rig?.graph.ctx as (AudioContext & { outputLatency?: number }) | undefined
  if (!ctx) {
    setText(ui.latencyHelp, 'Start audio to see the default: the latency your system reports, plus 10 ms.')
    return
  }
  const using = settings.latencyMs === null ? ' Using the default.' : ` Using your setting, ${settings.latencyMs} ms.`
  setText(ui.latencyHelp, latencyExplanation(ctx.outputLatency, ctx.baseLatency, defaultLatencyMs(ctx)) + using)
}

function renderAll(): void {
  renderDeck()
  renderDeviceOptions()
  renderKey()
  renderLooper() // draws the input and tone panels too: the looper locks parts of both
}

// ─── Animation frame: meter, position, cents ───

let lastSlow = 0

function frame(now: number): void {
  const r = rig
  if (!r) return
  if (session) {
    const m = session.meter()
    const rmsDb = toDb(m.rms)
    const peakDb = toDb(m.peak)
    // Peak hold: a pick attack is a few ms; the eye needs about a second.
    if (peakDb >= peakHold.db || now - peakHold.at > 1500) peakHold = { db: peakDb, at: now }
    ui.meterFill.style.clipPath = `inset(0 ${(1 - meterFill(rmsDb)) * 100}% 0 0)`
    ui.meterPeak.style.left = `${meterFill(peakHold.db) * 100}%`
    ui.meter.dataset.peakDb = peakHold.db.toFixed(1)
    ui.meter.setAttribute('aria-valuenow', String(Math.max(-60, Math.round(rmsDb))))
    ui.meter.classList.toggle('clip', peakHold.db > -0.5)
    setText(ui.meterText, `peak ${formatDb(peakHold.db)}`)
  } else if (ui.meter.dataset.peakDb !== '-90.0') {
    peakHold = { db: -90, at: now }
    ui.meterFill.style.clipPath = 'inset(0 100% 0 0)'
    ui.meterPeak.style.left = '0%'
    ui.meter.dataset.peakDb = '-90.0'
    setText(ui.meterText, formatDb(-90))
  }

  const snap = r.looper?.snapshot()
  const position = snap?.position ?? 0
  ui.positionFill.style.transform = `scaleX(${position})`
  ui.positionBar.setAttribute('aria-valuenow', String(Math.round(position * 100)))
  if (!r.transport.running() && beatText !== '') { beatText = ''; setText(ui.beatLabel, '') }
  if (heard) renderCents()

  // Slow refresh: latency figures settle after start; the load lock follows the transport.
  if (now - lastSlow > 500) {
    lastSlow = now
    renderDeck()
    if (settings.latencyMs === null && r.looper && !snap?.hasBase && snap?.state === 'idle') {
      const auto = defaultLatencyMs(r.graph.ctx)
      if (auto !== r.looper.latencyMs()) r.looper.setLatencyMs(auto)
    }
    const running = r.transport.running()
    if (running !== wasRunning) { wasRunning = running; looperChanged(); renderTone() }
    renderLatencyHelp()
  }
  requestAnimationFrame(frame)
}

// ─── Events ───

ui.startBtn.addEventListener('click', startAudio)
ui.panicBtn.addEventListener('click', () => setPanic(!(rig?.graph.isPanicked() ?? false)))

ui.allowBtn.addEventListener('click', allowInput)
ui.chooseAgainBtn.addEventListener('click', chooseAgain)
ui.deviceSelect.addEventListener('change', () => {
  const v = ui.deviceSelect.value
  if (v === CHOOSE) return
  void openDevice(v === SYSTEM_DEFAULT ? null : v)
})
ui.channelSelect.addEventListener('change', () => {
  const i = Number(ui.channelSelect.value)
  try {
    session?.setChannel(i)
    settings.channel = i
    inputNotice = null
    persist()
  } catch (err) {
    inputNotice = messageOf(err)
  }
  renderInput()
})
onInputsChanged(() => { void refreshDevices() })

const setMode = (m: ToneMode) => () => {
  if (looperBusy()) return // the buttons are disabled; this also covers a stale click
  rig?.tone.setMode(m)
  settings.toneMode = rig?.tone.mode() ?? m
  persist()
  renderTone()
  renderLooper()
}
ui.ampBtn.addEventListener('click', setMode('amp'))
ui.bypassBtn.addEventListener('click', setMode('bypass'))

ui.modelInput.addEventListener('change', () => {
  const file = ui.modelInput.files?.[0]
  ui.modelInput.value = '' // the same file can be picked again
  if (file) void loadModelFile(file).then(renderLooper)
})
ui.irInput.addEventListener('change', () => {
  const file = ui.irInput.files?.[0]
  ui.irInput.value = ''
  if (file) void loadIrFile(file)
})
ui.clearIrBtn.addEventListener('click', () => { if (!looperBusy()) rig?.tone.clearIr() })
ui.slimInput.addEventListener('input', () => setText(ui.slimValue, `${Math.round(Number(ui.slimInput.value) * 100)}%`))
// On release only: every resize reloads the model and stalls the audio thread.
ui.slimInput.addEventListener('change', () => {
  toneMessage = null
  rig?.tone.setSlim(Number(ui.slimInput.value)).catch(err => { toneMessage = messageOf(err) }).finally(renderTone)
})

ui.inputGain.addEventListener('input', () => {
  settings.inputGainDb = Number(ui.inputGain.value)
  rig?.tone.setInputGainDb(settings.inputGainDb)
  setText(ui.inputGainValue, formatDb(settings.inputGainDb))
})
ui.outputGain.addEventListener('input', () => {
  settings.outputGainDb = Number(ui.outputGain.value)
  rig?.tone.setOutputGainDb(settings.outputGainDb)
  setText(ui.outputGainValue, formatDb(settings.outputGainDb))
})
ui.inputGain.addEventListener('change', persist)
ui.outputGain.addEventListener('change', persist)
ui.monitorBtn.addEventListener('click', () => setMonitoring(!(rig?.graph.isMonitoring() ?? true)))
ui.deckMonitorBtn.addEventListener('click', () => setMonitoring(true))

ui.rootSelect.addEventListener('change', () => {
  settings.rootPc = Number(ui.rootSelect.value)
  keyChanged()
})
ui.scaleSelect.addEventListener('change', () => {
  settings.scaleKey = ui.scaleSelect.value as ScaleKey
  keyChanged()
})
function keyChanged(): void {
  cells = computeFretboard({ rootPc: settings.rootPc, scaleKey: settings.scaleKey })
  if (rig?.drone.isOn()) rig.drone.start(settings.rootPc) // retunes with a crossfade
  persist()
  renderKey()
}
ui.namesBtn.addEventListener('click', () => {
  settings.showNames = !settings.showNames
  persist()
  renderKey()
})
ui.droneBtn.addEventListener('click', () => {
  const drone = rig?.drone
  if (!drone) return
  if (drone.isOn()) drone.stop()
  else drone.start(settings.rootPc)
  renderKey()
})
ui.droneLevel.addEventListener('input', () => {
  settings.droneLevel = Number(ui.droneLevel.value)
  rig?.drone.setLevel(settings.droneLevel)
})
ui.droneLevel.addEventListener('change', persist)

const button = (b: HTMLButtonElement, action: ShortcutAction) => b.addEventListener('click', () => act(action))
button(ui.recordBtn, 'record')
button(ui.overdubBtn, 'overdub')
button(ui.stopBtn, 'stop')
button(ui.playBtn, 'play')
button(ui.undoBtn, 'undo')
ui.clearBtn.addEventListener('click', pressClear)
ui.exportBtn.addEventListener('click', () => { void exportTake() })

ui.bpmInput.addEventListener('change', () => {
  const bpm = Number(ui.bpmInput.value)
  const ok = rig ? rig.transport.setBpm(bpm) : Number.isFinite(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX
  if (ok) {
    settings.bpm = bpm
    persist()
  }
  const kept = rig?.transport.params().bpm ?? settings.bpm
  ui.bpmInput.value = String(kept)
  // Put back without a word, a typo looks like it took.
  say(ui.bpmNote, ok ? null : `Tempo must be ${BPM_MIN}–${BPM_MAX} BPM; kept ${kept}.`)
  renderLooper()
})
ui.bpmInput.addEventListener('input', () => say(ui.bpmNote, null)) // the player is already correcting it
ui.barsSelect.addEventListener('change', () => {
  const bars = Number(ui.barsSelect.value) as Bars
  const ok = rig ? rig.transport.setBars(bars) : BAR_CHOICES.includes(bars)
  if (ok) {
    settings.bars = bars
    persist()
  }
  renderLooper()
})
ui.clickBtn.addEventListener('click', () => {
  settings.clickOn = !settings.clickOn
  rig?.transport.setClick(settings.clickOn)
  persist()
  renderLooper()
})
ui.clickLevel.addEventListener('input', () => {
  settings.clickLevel = Number(ui.clickLevel.value)
  rig?.transport.setClickLevel(settings.clickLevel)
})
ui.clickLevel.addEventListener('change', persist)
ui.latencyInput.addEventListener('change', () => {
  const looper = rig?.looper
  if (!looper) return
  looper.setLatencyMs(Number(ui.latencyInput.value))
  settings.latencyMs = looper.latencyMs()
  persist()
  ui.latencyInput.value = String(looper.latencyMs())
  renderLooper()
})
ui.latencyAutoBtn.addEventListener('click', () => {
  const looper = rig?.looper
  if (!looper || !rig) return
  settings.latencyMs = null
  looper.setLatencyMs(defaultLatencyMs(rig.graph.ctx))
  persist()
  renderLooper()
})

// ─── Keyboard ───

document.addEventListener('keydown', e => {
  // Panic works from anywhere, a text field included.
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (rig) setPanic(true)
    return
  }
  if (!shortcutsAllowed(e.target as TargetLike | null)) return
  const snap = rig?.looper?.snapshot() ?? null
  if (e.key === ' ') {
    // Until the footswitch can do something real, Space presses the focused
    // button as usual (Start audio, Allow input). After that it never scrolls
    // the page or presses a focused button: it is the looper's.
    if (!footswitchLive(snap, session !== null)) return
    e.preventDefault()
  }
  const action = snap ? shortcutFor(e, snap) : null
  if (!action) return
  e.preventDefault()
  act(action)
})
// Chromium presses a focused button on Space's keyup, not keydown.
document.addEventListener('keyup', e => {
  if (e.key !== ' ' || !shortcutsAllowed(e.target as TargetLike | null)) return
  if (footswitchLive(rig?.looper?.snapshot() ?? null, session !== null)) e.preventDefault()
})

// ─── Focus hand-back ───
// Keys stand down while a number field or a list has focus, so once a value is
// set focus leaves it: the natural order is set the tempo, then hit Space.

for (const input of [ui.bpmInput, ui.latencyInput]) {
  // blur() commits the value, so the change handler still runs.
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
}
for (const select of document.querySelectorAll('select')) {
  // Only a pick made with the mouse: a keyboard user arrowing through options keeps focus.
  let byPointer = false
  select.addEventListener('pointerdown', () => { byPointer = true })
  select.addEventListener('keydown', () => { byPointer = false })
  select.addEventListener('change', () => {
    if (byPointer) select.blur()
    byPointer = false
  })
}

// ─── Deck height ───
// Feeds html's scroll-padding-top, so a focused control never sits hidden
// under the sticky deck (WCAG 2.4.11). The deck only sticks on a tall enough window.

function measureDeck(): void {
  const sticky = getComputedStyle(ui.deck).position === 'sticky'
  document.documentElement.style.setProperty('--deck-h', `${sticky ? ui.deck.offsetHeight : 0}px`)
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureDeck).observe(ui.deck)
window.addEventListener('resize', measureDeck)
measureDeck()

// ─── First paint ───

ui.inputGain.value = String(settings.inputGainDb)
ui.outputGain.value = String(settings.outputGainDb)
ui.droneLevel.value = String(settings.droneLevel)
ui.clickLevel.value = String(settings.clickLevel)
ui.slimInput.value = '1'
renderAll()

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
