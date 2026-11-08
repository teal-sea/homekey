import { describe, expect, it } from 'vitest'
import { footswitchLive, shortcutFor, shortcutsAllowed, spaceAction, type KeyLike, type LooperView } from './keys'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...mods })
const view = (state: LooperView['state'], hasBase = false, hasOverdub = false): LooperView => ({ state, hasBase, hasOverdub })

describe('spaceAction (the footswitch cycle)', () => {
  it('walks record, overdub, stop, then play', () => {
    expect(spaceAction(view('idle'))).toBe('record')
    expect(spaceAction(view('count-in'))).toBe('stop')
    expect(spaceAction(view('recording-base'))).toBe('stop')
    expect(spaceAction(view('playing', true))).toBe('overdub')
    expect(spaceAction(view('overdub-armed', true))).toBe('stop')
    expect(spaceAction(view('recording-overdub', true))).toBe('stop')
    expect(spaceAction(view('playing', true, true))).toBe('stop')
    expect(spaceAction(view('idle', true, true))).toBe('play')
    expect(spaceAction(view('idle', true))).toBe('play')
  })

  it('acknowledges an error with stop', () => {
    expect(spaceAction(view('error'))).toBe('stop')
    expect(spaceAction(view('error', true))).toBe('stop')
  })
})

describe('shortcutFor', () => {
  it('maps the letters in either case, and leaves Escape to the panic handler', () => {
    const idle = view('idle')
    expect(shortcutFor(key('r'), idle)).toBe('record')
    expect(shortcutFor(key('R'), idle)).toBe('record')
    expect(shortcutFor(key('o'), idle)).toBe('overdub')
    expect(shortcutFor(key('p'), idle)).toBe('play')
    expect(shortcutFor(key('s'), idle)).toBe('stop')
    expect(shortcutFor(key('u'), idle)).toBe('undo')
    expect(shortcutFor(key('Escape'), idle)).toBeNull()
    expect(shortcutFor(key(' '), idle)).toBe('record')
    expect(shortcutFor(key('x'), idle)).toBeNull()
  })

  it('leaves browser shortcuts and key repeat alone', () => {
    const idle = view('idle')
    expect(shortcutFor(key('r', { ctrlKey: true }), idle)).toBeNull()
    expect(shortcutFor(key('r', { metaKey: true }), idle)).toBeNull()
    expect(shortcutFor(key('s', { altKey: true }), idle)).toBeNull()
    expect(shortcutFor(key(' ', { repeat: true }), idle)).toBeNull()
  })
})

describe('shortcutsAllowed', () => {
  it('stands down in text fields, selects and editable content', () => {
    expect(shortcutsAllowed({ tagName: 'INPUT', type: 'number' })).toBe(false)
    expect(shortcutsAllowed({ tagName: 'INPUT', type: 'text' })).toBe(false)
    expect(shortcutsAllowed({ tagName: 'input' })).toBe(false)
    expect(shortcutsAllowed({ tagName: 'TEXTAREA' })).toBe(false)
    expect(shortcutsAllowed({ tagName: 'SELECT' })).toBe(false)
    expect(shortcutsAllowed({ tagName: 'DIV', isContentEditable: true })).toBe(false)
  })

  it('leaves a file picker its own keys: Space opens it', () => {
    expect(shortcutsAllowed({ tagName: 'INPUT', type: 'file' })).toBe(false)
  })

  it('works on the page, on buttons and on sliders', () => {
    expect(shortcutsAllowed(null)).toBe(true)
    expect(shortcutsAllowed({ tagName: 'BODY' })).toBe(true)
    expect(shortcutsAllowed({ tagName: 'BUTTON' })).toBe(true)
    expect(shortcutsAllowed({ tagName: 'INPUT', type: 'range' })).toBe(true)
  })
})

describe('footswitchLive', () => {
  it('leaves Space to the focused button until there is a looper and something real to do', () => {
    expect(footswitchLive(null, true)).toBe(false) // audio not started, or the recorder still loading
    expect(footswitchLive(view('idle'), false)).toBe(false) // nothing to record: Space presses Allow input
    expect(footswitchLive(view('idle'), true)).toBe(true)
  })

  it('keeps Space as the footswitch while a loop exists or the looper runs, input or not', () => {
    // An unplugged input must not take away the key that stops the loop.
    expect(footswitchLive(view('playing', true), false)).toBe(true)
    expect(footswitchLive(view('idle', true), false)).toBe(true)
    expect(footswitchLive(view('error'), false)).toBe(true)
    expect(footswitchLive(view('count-in'), false)).toBe(true)
  })
})
