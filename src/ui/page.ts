// ─── Page skeleton ──────────────────────────────────────────────────
// Builds every element once and hands back references; main.ts wires them to
// the audio modules. No audio here and no state, so the layout can be read
// top to bottom as the player meets it.
//
// The deck (Start, status, Panic and the looper's big buttons) is sticky:
// Record and Panic stay in reach however far down the page the player is.

import { h, type Child } from './dom'
import { SHORTCUT_HELP } from './keys'
import { BAR_CHOICES, GAIN_MAX_DB, GAIN_MIN_DB, LEVEL_MAX_DB, LEVEL_MIN_DB } from './settings'
import { BPM_MAX, BPM_MIN } from '../audio/transport'
import { LATENCY_MAX_MS } from '../audio/looper'
import { APP_NAME } from '../app-name'

const section = (id: string, title: string, children: Child[]): HTMLElement =>
  h('section', { id, class: 'panel', 'aria-labelledby': `${id}-title` }, [h('h2', { id: `${id}-title` }, [title]), ...children])

/** A label over its control; `forId` names the labelled element when `control` is a wrapper around it. */
const field = (label: string, control: HTMLElement, forId = control.id): HTMLElement =>
  h('div', { class: 'field' }, [h('label', { for: forId }, [label]), control])

const note = (id: string, cls = 'note'): HTMLParagraphElement => h('p', { id, class: cls, hidden: true })

const slider = (id: string, min: number, max: number, step: number): HTMLInputElement =>
  h('input', { id, type: 'range', min, max, step })

// A toggle's name never changes ("Monitoring", not "Monitoring off"): a name
// that reads as the state and also carries aria-pressed is ambiguous both to a
// screen reader and to the eye. The on/off tag is for the eye only.
const stateTag = (): HTMLSpanElement => h('span', { class: 'toggle-state', 'aria-hidden': 'true' }, ['off'])

const toggle = (id: string, text: string): HTMLButtonElement =>
  h('button', { id, type: 'button', class: 'toggle', 'aria-pressed': 'false' }, [text, stateTag()])

// The native file input says "No file chosen" even with a model loaded, so it
// is hidden (still focusable, Space and Enter still open it) behind a label
// styled as a button, whose text main.ts keeps in step with what is loaded.
const filePicker = (id: string, accept: string, text: string) => {
  const input = h('input', { id, type: 'file', accept, class: 'visually-hidden', disabled: true })
  const button = h('label', { for: id, class: 'file-button' }, [text])
  return { input, button, row: h('div', { class: 'file-pick' }, [input, button]) }
}

export function buildPage(root: HTMLElement) {
  // ─── Deck ───
  const startBtn = h('button', { id: 'start-audio', type: 'button', class: 'primary' }, ['Start audio'])
  const audioStatus = h('p', { id: 'audio-status', class: 'status' }, ['Audio is off. Start audio, then allow input.'])
  const audioWarning = note('audio-warning', 'warn')
  const panicBtn = h('button', { id: 'panic', type: 'button', class: 'panic', 'aria-pressed': 'false', title: 'Mute everything (Esc)' }, ['Panic mute', stateTag()])
  // Monitoring lives in the Tone panel, a screen or more below on a phone; the
  // deck says when the player is not hearing the guitar here, and why.
  const monitorText = h('span', { id: 'monitor-text' })
  const deckMonitorBtn = h('button', { id: 'deck-monitor', type: 'button', class: 'inline' }, ['Turn monitoring on'])
  const monitorNote = h('p', { id: 'monitor-note', class: 'status monitor-note', 'aria-live': 'polite', hidden: true }, [monitorText, ' ', deckMonitorBtn])

  const big = (id: string, text: string, key: string, cls = ''): HTMLButtonElement =>
    h('button', { id, type: 'button', class: `big ${cls}`.trim(), 'aria-keyshortcuts': key || undefined, disabled: true }, [text])
  const recordBtn = big('record', 'Record', 'R', 'record')
  const overdubBtn = big('overdub', 'Overdub', 'O')
  const stopBtn = big('stop', 'Stop', 'S')
  const playBtn = big('play', 'Play', 'P')
  const undoBtn = big('undo', 'Undo', 'U')
  const clearBtn = big('clear', 'Clear', '')
  const stateLabel = h('span', { id: 'looper-state', class: 'state', 'data-state': 'idle', 'aria-live': 'polite' }, ['Stopped'])
  const beatLabel = h('span', { id: 'beat', class: 'beat' })
  const positionFill = h('div', { class: 'position-fill' })
  const positionBar = h('div', { id: 'position', class: 'position', role: 'progressbar', 'aria-label': 'Loop position', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, [positionFill])
  const looperError = h('p', { id: 'looper-error', class: 'error', role: 'alert', hidden: true })
  const looperHint = h('p', { id: 'looper-hint', class: 'note', hidden: true })

  const deck = h('header', { class: 'deck' }, [
    h('div', { class: 'deck-top' }, [
      h('h1', {}, [APP_NAME]),
      startBtn,
      h('div', { class: 'deck-status' }, [audioStatus, audioWarning, monitorNote]),
      panicBtn,
    ]),
    h('div', { class: 'deck-transport', role: 'group', 'aria-label': 'Looper' }, [
      h('div', { class: 'transport-buttons' }, [recordBtn, overdubBtn, stopBtn, playBtn, undoBtn, clearBtn]),
      h('div', { class: 'transport-state' }, [stateLabel, beatLabel, positionBar]),
    ]),
    looperError,
    looperHint,
  ])

  // ─── Input ───
  const allowBtn = h('button', { id: 'allow-input', type: 'button', disabled: true }, ['Allow input'])
  const allowHelp = h('p', { class: 'help' }, [
    'Opens the input you used last, or the system default. The browser asks for permission once. ',
    'Use your audio interface with the guitar plugged in.',
  ])
  const deviceSelect = h('select', { id: 'device', disabled: true })
  const channelSelect = h('select', { id: 'channel', disabled: true }, [
    h('option', { value: '0' }, ['Channel 1']),
    h('option', { value: '1' }, ['Channel 2']),
  ])
  const meterFill = h('div', { class: 'meter-fill' })
  const meterPeak = h('div', { class: 'meter-peak' })
  const meter = h('div', { id: 'input-meter', class: 'meter', role: 'meter', 'aria-labelledby': 'meter-label', 'aria-valuemin': -60, 'aria-valuemax': 0, 'aria-valuenow': -60, 'data-peak-db': -90 }, [meterFill, meterPeak])
  const meterText = h('span', { id: 'input-level', class: 'meter-text' }, ['-∞ dB'])
  const accepted = h('ul', { id: 'accepted', class: 'facts', 'aria-label': 'Input settings the browser accepted' })
  const inputWarning = note('input-warning', 'warn')
  const inputError = h('p', { id: 'input-error', class: 'error', role: 'alert', hidden: true })
  const chooseAgainBtn = h('button', { id: 'choose-again', type: 'button', hidden: true }, ['Choose again'])

  const input = section('input', 'Input', [
    h('div', { class: 'row' }, [allowBtn]),
    allowHelp,
    field('Input device', deviceSelect),
    field('Guitar channel', channelSelect),
    h('div', { class: 'field' }, [
      h('span', { class: 'label', id: 'meter-label' }, ['Level (before the amp)']),
      h('div', { class: 'meter-row' }, [meter, meterText]),
    ]),
    accepted,
    inputWarning,
    inputError,
    chooseAgainBtn,
  ])

  // ─── Tone ───
  const ampBtn = h('button', { id: 'mode-amp', type: 'button', class: 'seg', 'aria-pressed': 'true' }, ['Amp'])
  const bypassBtn = h('button', { id: 'mode-bypass', type: 'button', class: 'seg', 'aria-pressed': 'false' }, ['Bypass'])
  const modeHelp = h('p', { class: 'help' })
  const toneStatus = h('p', { id: 'tone-status', class: 'status', 'data-status': 'off' }, ['Amp engine: waiting for audio.'])
  const modelPick = filePicker('model-file', '.nam,application/json', 'Load model…')
  const modelInput = modelPick.input
  const modelSummary = h('p', { id: 'model-summary', class: 'fact' }, ['No model loaded.'])
  const modelWarning = note('model-warning', 'warn')
  const slimInput = slider('slim', 0, 1, 0.01)
  const slimValue = h('output', { for: 'slim' })
  const slimRow = h('div', { class: 'field', hidden: true }, [
    h('label', { for: 'slim' }, ['Model size (smaller uses less CPU)']),
    h('div', { class: 'slider-row' }, [slimInput, slimValue]),
  ])
  const irPick = filePicker('ir-file', '.wav,audio/wav,audio/x-wav', 'Load IR…')
  const irInput = irPick.input
  const irSummary = h('p', { id: 'ir-summary', class: 'fact' }, ['No IR: the model plays without a cabinet.'])
  const clearIrBtn = h('button', { id: 'clear-ir', type: 'button', disabled: true }, ['Clear IR'])
  const loadReason = h('p', { id: 'load-reason', class: 'note' }, ['Start audio to load a model.'])
  const inputGain = slider('input-gain', GAIN_MIN_DB, GAIN_MAX_DB, 0.5)
  const inputGainValue = h('output', { for: 'input-gain' })
  const outputGain = slider('output-gain', LEVEL_MIN_DB, LEVEL_MAX_DB, 0.5)
  const outputGainValue = h('output', { for: 'output-gain' })
  const monitorBtn = toggle('monitor', 'Monitoring')
  const monitorHelp = h('p', { class: 'help' }, [
    'Monitoring plays your guitar through this page. Use headphones: on speakers with a microphone nearby it can feed back. ',
    'Recording works with it off.',
  ])
  const toneError = h('p', { id: 'tone-error', class: 'error', role: 'alert', hidden: true })

  const tone = section('tone', 'Tone', [
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Tone mode' }, [ampBtn, bypassBtn]),
    modeHelp,
    toneStatus,
    field('Amp model (.nam)', modelPick.row, modelInput.id),
    modelSummary,
    modelWarning,
    slimRow,
    field('Cabinet IR (.wav, optional)', irPick.row, irInput.id),
    h('div', { class: 'row' }, [irSummary, clearIrBtn]),
    loadReason,
    h('div', { class: 'field' }, [h('label', { for: 'input-gain' }, ['Input gain (into the amp)']), h('div', { class: 'slider-row' }, [inputGain, inputGainValue])]),
    h('div', { class: 'field' }, [h('label', { for: 'output-gain' }, ['Output level']), h('div', { class: 'slider-row' }, [outputGain, outputGainValue])]),
    h('div', { class: 'row' }, [monitorBtn]),
    monitorHelp,
    toneError,
  ])

  // ─── Key ───
  const rootSelect = h('select', { id: 'root' })
  const scaleSelect = h('select', { id: 'scale' })
  const namesBtn = toggle('names', 'Note names')
  const formula = h('p', { id: 'formula', class: 'fact' })
  const droneBtn = toggle('drone', 'Drone')
  const droneLevel = slider('drone-level', 0, 1, 0.01)
  const heardNote = h('span', { id: 'heard-note', class: 'heard-note' }, ['–'])
  const heardCents = h('span', { id: 'heard-cents', class: 'heard-cents' })
  const heardRole = h('span', { id: 'heard-role', class: 'heard-role' }, ['Play a note'])
  const heard = h('div', { id: 'heard', class: 'heard', 'data-midi': '' }, [heardNote, heardCents, heardRole])
  const fretboard = h('div', { id: 'fretboard', class: 'fretboard' })

  const key = section('key', 'Key', [
    h('div', { class: 'row key-row' }, [
      field('Root', rootSelect),
      field('Scale or mode', scaleSelect),
      h('div', { class: 'field' }, [h('span', { class: 'label' }, ['Labels']), namesBtn]),
      h('div', { class: 'field' }, [h('span', { class: 'label' }, ['Drone (root and fifth)']), h('div', { class: 'slider-row' }, [droneBtn, droneLevel])]),
      heard,
    ]),
    formula,
    fretboard,
  ])
  droneLevel.setAttribute('aria-label', 'Drone level')

  // ─── Looper settings ───
  const bpmInput = h('input', { id: 'bpm', type: 'number', min: BPM_MIN, max: BPM_MAX, step: 1, inputmode: 'numeric', 'aria-describedby': 'bpm-note' })
  const bpmNote = note('bpm-note', 'warn')
  const barsSelect = h('select', { id: 'bars' }, BAR_CHOICES.map(b => h('option', { value: b }, [b === 1 ? '1 bar' : `${b} bars`])))
  const clickBtn = toggle('click', 'Click')
  const clickLevel = slider('click-level', 0, 1, 0.01)
  const latencyInput = h('input', { id: 'latency', type: 'number', min: 0, max: LATENCY_MAX_MS, step: 1, inputmode: 'numeric' })
  const latencyAutoBtn = h('button', { id: 'latency-auto', type: 'button' }, ['Use default'])
  const latencyHelp = h('p', { id: 'latency-help', class: 'help' })
  const lockNote = h('p', { id: 'lock-note', class: 'note', hidden: true }, ['Tempo and length are locked while a loop exists. Clear to change them.'])
  const exportBtn = h('button', { id: 'export', type: 'button', disabled: true }, ['Export take'])
  const exportHelp = h('p', { class: 'help' }, [
    'Downloads one .zip: base.wav, overdub.wav (if there is one) and mix.wav, all 24-bit, plus take.json. Audio is not saved anywhere else: export to keep a take.',
  ])

  const looper = section('looper', 'Looper', [
    h('div', { class: 'row' }, [
      field('Tempo (BPM)', bpmInput),
      field('Length', barsSelect),
      h('div', { class: 'field' }, [h('span', { class: 'label' }, ['Click (4/4, one bar count-in)']), h('div', { class: 'slider-row' }, [clickBtn, clickLevel])]),
    ]),
    bpmNote,
    lockNote,
    h('div', { class: 'field' }, [
      h('label', { for: 'latency' }, ['Latency offset (ms)']),
      h('div', { class: 'row' }, [latencyInput, latencyAutoBtn]),
    ]),
    latencyHelp,
    h('div', { class: 'row' }, [exportBtn]),
    exportHelp,
  ])
  clickLevel.setAttribute('aria-label', 'Click level')

  const shortcuts = h('section', { id: 'shortcuts', class: 'panel', 'aria-labelledby': 'shortcuts-title' }, [
    h('h2', { id: 'shortcuts-title' }, ['Keys']),
    h('dl', { class: 'keys' }, SHORTCUT_HELP.flatMap(s => [h('dt', {}, [h('kbd', {}, [s.keys])]), h('dd', {}, [s.does])])),
    h('p', { class: 'help' }, [
      'Keys work unless a text field, a list or a file picker has focus. Enter in a number field, or a pick ',
      'from a list with the mouse, hands them back. Esc works everywhere. On a focused button, Enter presses it; ',
      'Space stays the looper\'s once there is an input to record or a loop to drive.',
    ]),
  ])

  const footer = h('footer', { class: 'footer' }, [
    h('p', {}, ['Audio never leaves this device: no uploads, no accounts, no analytics. Bring your own .nam models and IRs.']),
  ])

  root.replaceChildren(deck, h('main', { class: 'grid' }, [input, tone, looper, key, shortcuts]), footer)

  return {
    deck, startBtn, audioStatus, audioWarning, panicBtn, monitorNote, monitorText, deckMonitorBtn,
    recordBtn, overdubBtn, stopBtn, playBtn, undoBtn, clearBtn, stateLabel, beatLabel, positionBar, positionFill, looperError, looperHint,
    allowBtn, deviceSelect, channelSelect, meter, meterFill, meterPeak, meterText, accepted, inputWarning, inputError, chooseAgainBtn,
    ampBtn, bypassBtn, modeHelp, toneStatus, modelInput, modelPickLabel: modelPick.button, modelSummary, modelWarning, slimRow, slimInput, slimValue,
    irInput, irPickLabel: irPick.button, irSummary, clearIrBtn, loadReason, inputGain, inputGainValue, outputGain, outputGainValue, monitorBtn, toneError,
    rootSelect, scaleSelect, namesBtn, formula, droneBtn, droneLevel, heard, heardNote, heardCents, heardRole, fretboard,
    bpmInput, bpmNote, barsSelect, clickBtn, clickLevel, latencyInput, latencyAutoBtn, latencyHelp, lockNote, exportBtn,
  }
}
