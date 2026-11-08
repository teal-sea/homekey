// ─── Keyboard ───────────────────────────────────────────────────────
// A guitarist has both hands on the instrument, so the looper answers to a
// few single keys. Space is the one that matters: it walks record → overdub →
// stop like a footswitch. Shortcuts stand down while the player is typing in
// a field, and never fire with a modifier held (so browser shortcuts survive).

import type { LooperMode } from '../audio/looper'

// Esc (panic) is not here: main.ts handles it first, from anywhere, a text
// field included, so it never goes through the looper's key rules.
export type ShortcutAction = 'record' | 'overdub' | 'stop' | 'play' | 'undo'

export interface ShortcutHelp { keys: string; does: string }

export const SHORTCUT_HELP: readonly ShortcutHelp[] = [
  { keys: 'Space', does: 'Record, then overdub, then stop (a footswitch cycle)' },
  { keys: 'R', does: 'Record the base loop' },
  { keys: 'O', does: 'Overdub' },
  { keys: 'P', does: 'Play the loop' },
  { keys: 'S', does: 'Stop' },
  { keys: 'U', does: 'Undo the overdub' },
  { keys: 'Esc', does: 'Panic: mute all output' },
]

export interface LooperView { state: LooperMode; hasBase: boolean; hasOverdub: boolean }

/** What one press of Space does from here. */
export function spaceAction(s: LooperView): ShortcutAction {
  switch (s.state) {
    case 'idle': return s.hasBase ? 'play' : 'record'
    case 'playing': return s.hasOverdub ? 'stop' : 'overdub'
    // Counting in, recording, armed, or showing an error: the next press stops.
    default: return 'stop'
  }
}

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean }

export function shortcutFor(e: KeyLike, looper: LooperView): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null
  switch (e.key) {
    case ' ': return spaceAction(looper)
    case 'r': case 'R': return 'record'
    case 'o': case 'O': return 'overdub'
    case 'p': case 'P': return 'play'
    case 's': case 'S': return 'stop'
    case 'u': case 'U': return 'undo'
    default: return null
  }
}

/**
 * Whether Space is the footswitch right now. It takes Space from a focused
 * button (a toggle the mouse just clicked keeps focus, and must not flip on a
 * footswitch press), so it claims the key only while it can do something real:
 * a looper exists, and either there is input to record or a loop to drive.
 * Before that, Space presses the focused button as usual: Start audio, Allow input.
 */
export function footswitchLive(looper: LooperView | null, inputOpen: boolean): boolean {
  if (looper === null) return false
  return inputOpen || looper.hasBase || looper.state !== 'idle'
}

export interface TargetLike { tagName?: string; type?: string; isContentEditable?: boolean }

// Inputs whose keys are not text: a press on them can be a shortcut. A file
// input is not one of them: Space is how a keyboard opens its picker.
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'])

/**
 * False while focus is somewhere keys are typed: a text or number field, a
 * select (letters jump between options), a file picker, a text area or
 * editable content. On a button, Space is taken for the looper while
 * footswitchLive() says so; Enter always presses the button.
 */
export function shortcutsAllowed(target: TargetLike | null): boolean {
  if (target === null) return true
  if (target.isContentEditable) return false
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return false
  if (tag === 'INPUT') return NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())
  return true
}
