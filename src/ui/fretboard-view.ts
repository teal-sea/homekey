// ─── Fretboard view ─────────────────────────────────────────────────
// Draws a computed board (src/theory/fretboard.ts) as inline SVG. It never works
// out a note itself: every name, interval and position comes from the cells.
//
// Two layers: the board and its scale dots change only with the key, and are
// rebuilt only then; the heard note changes many times a second, so it lives in
// its own small layer.
//
// The production CSP has style-src 'self' with no 'unsafe-inline', so nothing
// here writes a style attribute or a <style> element. Colours go on through the
// CSSOM (element.style), which CSP allows, as var(--fb-*) with a fallback, so the
// page's stylesheet themes the neck and the view still draws without one.

import { positionsOfMidi, type FretCell, type FretboardCells } from '../theory/fretboard'
import { midiName, midiOctave, toPc } from '../theory/notes'
import { getScale, type ScaleKey } from '../theory/scales'

export interface FretboardViewOptions {
  /** The exact note being played, lit wherever it sits on the neck. Null when nothing is heard. */
  heardMidi: number | null
  /** Label scale dots with note names instead of intervals. */
  showNames: boolean
  /** Lets the aria-label name the mode; without it the label names only the root. */
  scaleKey?: ScaleKey
}

export interface FretboardView {
  update(cells: FretboardCells, opts: FretboardViewOptions): void
  destroy(): void
}

// ─── Colours ────────────────────────────────────────────────────────
// The six the integrator themes, plus a few quieter ones with the same pattern.
// Default contrast: white labels on root and scale dots, dark on the bright two.
const COLOURS = {
  wood: 'var(--fb-wood, #35261b)',
  string: 'var(--fb-string, #d6cfbf)',
  fret: 'var(--fb-fret, #9d978b)',
  nut: 'var(--fb-nut, #ebe5d5)',
  marker: 'var(--fb-marker, rgba(255, 255, 255, 0.2))',
  root: 'var(--fb-root, #c23b27)',
  scale: 'var(--fb-scale, #2d68a8)',
  character: 'var(--fb-character, #f2b431)',
  heard: 'var(--fb-heard, #33e3a4)',
  label: 'var(--fb-label, #ffffff)',
  labelOnCharacter: 'var(--fb-label-character, #241a08)',
  labelOnHeard: 'var(--fb-label-heard, #05271a)',
  text: 'var(--fb-text, currentColor)',
}

// ─── Geometry (viewBox units) ───────────────────────────────────────
const PAD_LEFT = 26          // string names
const OPEN_LANE = 44         // open-string notes sit left of the nut
const BOARD_WIDTH = 930
const PAD_RIGHT = 16
const PAD_TOP = 10
const STRING_SPACING = 36
const PAD_BOTTOM = 30        // fret numbers
const VIEW_WIDTH = PAD_LEFT + OPEN_LANE + BOARD_WIDTH + PAD_RIGHT
const NUT_X = PAD_LEFT + OPEN_LANE
// Below this the labels get too small to read, so the neck scrolls sideways instead.
const MIN_WIDTH_PX = 720
// Real fret spacing makes the 15th fret about half as wide as the 1st; easing
// halfway to even spacing keeps the guitar look and room for a dot up high.
const TAPER_EASE = 0.5
const MARKER_FRETS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]
const DOUBLE_MARKERS = new Set([12, 24])

// x of fret wire `f` (0 = the nut).
function wireX(f: number, frets: number): number {
  if (f <= 0 || frets <= 0) return NUT_X
  const real = (1 - 2 ** (-f / 12)) / (1 - 2 ** (-frets / 12))
  const even = f / frets
  return NUT_X + BOARD_WIDTH * (real * (1 - TAPER_EASE) + even * TAPER_EASE)
}

// Where a note at `fret` is drawn: the middle of its fret cell, or the open lane.
function cellX(fret: number, frets: number): number {
  return fret === 0 ? NUT_X - OPEN_LANE / 2 : (wireX(fret - 1, frets) + wireX(fret, frets)) / 2
}

// ─── Layout (pure) ──────────────────────────────────────────────────
export type DotKind = 'root' | 'character' | 'scale'

export interface DotLayout { string: number; fret: number; x: number; y: number; kind: DotKind; label: string }
export interface HeardLayout { string: number; fret: number; x: number; y: number; inScale: boolean; label: string }

export interface FretboardLayout {
  width: number
  height: number
  frets: number
  boardTop: number
  boardBottom: number
  boardRight: number
  radius: number
  strings: { string: number; y: number; thickness: number; label: string }[]
  wires: number[]
  markers: { x: number; y: number }[]
  fretNumbers: { fret: number; x: number }[]
  dots: DotLayout[]
  heard: HeardLayout[]
  ariaLabel: string
}

function dotKind(cell: FretCell): DotKind {
  return cell.isRoot ? 'root' : cell.isCharacter ? 'character' : 'scale'
}

function dotLabel(cell: FretCell, showNames: boolean): string {
  return showNames ? cell.name : cell.interval
}

/** The one-sentence summary a screen reader gets for the neck. */
export function describeFretboard(cells: FretboardCells, opts: FretboardViewOptions): string {
  const all = cells.flat()
  const root = all.find(cell => cell.isRoot)
  if (!root) return 'Fretboard, no notes shown.'
  const frets = cells[0].length - 1
  const key = opts.scaleKey ? `${root.name} ${getScale(opts.scaleKey).name}` : `root ${root.name}`
  const head = `Fretboard, ${key}, frets 0 to ${frets}.`
  if (opts.heardMidi === null) return `${head} No note heard.`

  const at = positionsOfMidi(cells, opts.heardMidi)
  // Off the neck shown: name it the way the board spells that pitch class.
  const heardPc = toPc(opts.heardMidi)
  const sample = at[0] ?? all.find(cell => cell.pc === heardPc)
  const name = sample ? sample.name + midiOctave(opts.heardMidi) : midiName(opts.heardMidi)
  if (at.length === 0) return `${head} Heard ${name}, beyond the frets shown.`
  const cell = at[0]
  const role = cell.isRoot ? 'the root'
    : cell.isCharacter ? `${cell.interval}, the character note`
    : cell.inScale ? cell.interval
    : `${cell.interval}, outside the scale`
  const places = at.length === 1 ? '1 place' : `${at.length} places`
  return `${head} Heard ${name} (${role}), ${places} on the neck.`
}

export function layoutFretboard(cells: FretboardCells, opts: FretboardViewOptions): FretboardLayout {
  const strings = cells.length
  const frets = strings > 0 ? cells[0].length - 1 : 0
  const boardTop = PAD_TOP
  const boardBottom = PAD_TOP + strings * STRING_SPACING
  // The highest string at the top, as the player looks down at the neck.
  const yOf = (string: number) => boardTop + STRING_SPACING / 2 + (strings - 1 - string) * STRING_SPACING
  const narrowest = frets > 0 ? wireX(frets, frets) - wireX(frets - 1, frets) : OPEN_LANE
  const radius = Math.min(15, STRING_SPACING * 0.42, narrowest * 0.4, OPEN_LANE * 0.4)
  // The gap between the two middle strings (an odd count has a string at the centre).
  const gapY = boardTop + (Math.floor(strings / 2)) * STRING_SPACING
  const markerX = (f: number) => cellX(f, frets)

  const dots: DotLayout[] = []
  for (const row of cells) {
    for (const cell of row) {
      if (!cell.inScale) continue
      dots.push({ string: cell.string, fret: cell.fret, x: cellX(cell.fret, frets), y: yOf(cell.string), kind: dotKind(cell), label: dotLabel(cell, opts.showNames) })
    }
  }

  const heard: HeardLayout[] = opts.heardMidi === null ? [] : positionsOfMidi(cells, opts.heardMidi).map(cell => ({
    string: cell.string, fret: cell.fret, x: cellX(cell.fret, frets), y: yOf(cell.string),
    inScale: cell.inScale, label: dotLabel(cell, opts.showNames),
  }))

  const shownMarkers = MARKER_FRETS.filter(f => f <= frets)
  return {
    width: VIEW_WIDTH,
    height: boardBottom + PAD_BOTTOM,
    frets, boardTop, boardBottom,
    boardRight: wireX(frets, frets),
    radius,
    strings: cells.map((row, string) => ({
      string,
      y: yOf(string),
      // Thicker toward the low strings, like the real set.
      thickness: 1 + (strings - 1 - string) * 0.35,
      label: row[0]?.name ?? '',
    })),
    wires: Array.from({ length: frets }, (_, i) => wireX(i + 1, frets)),
    // Inlays sit between strings, as on a real neck: the double dot at 12 one
    // string-gap either side of the centre (between B–G and D–A on a six-string).
    markers: shownMarkers.flatMap(f => DOUBLE_MARKERS.has(f) && strings >= 4
      ? [{ x: markerX(f), y: gapY - STRING_SPACING }, { x: markerX(f), y: gapY + STRING_SPACING }]
      : [{ x: markerX(f), y: gapY }]),
    fretNumbers: shownMarkers.map(f => ({ fret: f, x: markerX(f) })),
    dots, heard,
    ariaLabel: describeFretboard(cells, opts),
  }
}

// ─── DOM ────────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg'
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

type Attrs = Record<string, string | number>

function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, attrs: Attrs = {}, paint: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  // CSSOM, not a style attribute: allowed under style-src 'self'.
  for (const [prop, value] of Object.entries(paint)) node.style.setProperty(prop, value)
  return node
}

function label(doc: Document, x: number, y: number, text: string, size: number, fill: string, cls: string): SVGTextElement {
  const node = svgEl(doc, 'text', {
    class: cls, x, y, dy: '0.35em', 'text-anchor': 'middle', 'font-family': FONT, 'font-size': size, 'font-weight': 600,
  }, { fill })
  node.textContent = text
  return node
}

function drawBoard(doc: Document, layer: SVGGElement, layout: FretboardLayout): void {
  const { boardTop, boardBottom, boardRight, radius } = layout
  const parts: SVGElement[] = []
  if (layout.frets > 0) {
    parts.push(svgEl(doc, 'rect', { class: 'fb-wood', x: NUT_X, y: boardTop, width: boardRight - NUT_X, height: boardBottom - boardTop }, { fill: COLOURS.wood }))
  }
  for (const m of layout.markers) parts.push(svgEl(doc, 'circle', { class: 'fb-marker', cx: m.x, cy: m.y, r: 5 }, { fill: COLOURS.marker }))
  for (const x of layout.wires) {
    parts.push(svgEl(doc, 'line', { class: 'fb-fret', x1: x, x2: x, y1: boardTop, y2: boardBottom }, { stroke: COLOURS.fret, 'stroke-width': '2' }))
  }
  parts.push(svgEl(doc, 'rect', { class: 'fb-nut', x: NUT_X - 3, y: boardTop - 2, width: 6, height: boardBottom - boardTop + 4, rx: 1.5 }, { fill: COLOURS.nut }))
  for (const s of layout.strings) {
    parts.push(svgEl(doc, 'line', { class: 'fb-string', x1: PAD_LEFT + 6, x2: boardRight, y1: s.y, y2: s.y }, { stroke: COLOURS.string, 'stroke-width': String(s.thickness) }))
    parts.push(label(doc, PAD_LEFT / 2, s.y, s.label, 12, COLOURS.text, 'fb-string-label'))
  }
  for (const n of layout.fretNumbers) {
    parts.push(label(doc, n.x, boardBottom + PAD_BOTTOM / 2 + 2, String(n.fret), 12, COLOURS.text, 'fb-fret-number'))
  }

  // Root and character differ by shape as well as colour, for colour-blind
  // players: the root is a rounded square, the character note wears a halo.
  const textSize = Math.round(radius * 0.9)
  for (const d of layout.dots) {
    const g = svgEl(doc, 'g', { class: `fb-dot fb-dot--${d.kind}`, 'data-string': d.string, 'data-fret': d.fret })
    if (d.kind === 'root') {
      g.append(svgEl(doc, 'rect', { x: d.x - radius, y: d.y - radius, width: radius * 2, height: radius * 2, rx: radius * 0.3 }, { fill: COLOURS.root }))
    } else if (d.kind === 'character') {
      g.append(svgEl(doc, 'circle', { cx: d.x, cy: d.y, r: radius + 3 }, { fill: 'none', stroke: COLOURS.character, 'stroke-width': '2' }))
      g.append(svgEl(doc, 'circle', { cx: d.x, cy: d.y, r: radius - 1 }, { fill: COLOURS.character }))
    } else {
      g.append(svgEl(doc, 'circle', { cx: d.x, cy: d.y, r: radius }, { fill: COLOURS.scale }))
    }
    g.append(label(doc, d.x, d.y, d.label, textSize, d.kind === 'character' ? COLOURS.labelOnCharacter : COLOURS.label, 'fb-label'))
    parts.push(g)
  }
  layer.replaceChildren(...parts)
}

function drawHeard(doc: Document, layer: SVGGElement, layout: FretboardLayout): void {
  const { radius } = layout
  const textSize = Math.round(radius * 0.9)
  layer.replaceChildren(...layout.heard.map(h => {
    const g = svgEl(doc, 'g', { class: `fb-heard${h.inScale ? '' : ' fb-heard--outside'}`, 'data-string': h.string, 'data-fret': h.fret })
    // A note outside the scale has no dot of its own, so it gets one here.
    if (!h.inScale) {
      g.append(svgEl(doc, 'circle', { cx: h.x, cy: h.y, r: radius - 1 }, { fill: COLOURS.heard }))
      g.append(label(doc, h.x, h.y, h.label, textSize, COLOURS.labelOnHeard, 'fb-label'))
    }
    g.append(svgEl(doc, 'circle', { cx: h.x, cy: h.y, r: radius + 6 }, { fill: 'none', stroke: COLOURS.heard, 'stroke-width': '3.5' }))
    return g
  }))
}

// What the board layer depends on. The caller may rebuild cells on every frame;
// comparing content, not identity, keeps that from rebuilding the SVG each time.
function boardSignature(cells: FretboardCells, showNames: boolean): string {
  return (showNames ? 'n' : 'i') + cells.map(row =>
    `${row[0]?.midi}${row[0]?.name}/${row.length}:` + row.map(c => c.inScale ? `${c.fret}${c.name}${c.interval}${dotKind(c)[0]}` : '').join(',')).join('|')
}

export function createFretboardView(container: HTMLElement): FretboardView {
  const doc = container.ownerDocument
  const viewport = doc.createElement('div')
  viewport.className = 'fb-viewport'
  viewport.style.overflowX = 'auto'

  const svg = svgEl(doc, 'svg', { class: 'fb', role: 'img', 'aria-label': 'Fretboard', viewBox: `0 0 ${VIEW_WIDTH} 100` })
  svg.style.display = 'block'
  svg.style.width = '100%'
  svg.style.height = 'auto'
  svg.style.minWidth = `${MIN_WIDTH_PX}px`
  const boardLayer = svgEl(doc, 'g', { class: 'fb-board' })
  const heardLayer = svgEl(doc, 'g', { class: 'fb-heard-layer' })
  svg.append(boardLayer, heardLayer)
  viewport.append(svg)
  container.append(viewport)

  // A neck narrower than its minimum scrolls sideways; a scroll box needs a
  // keyboard way in, but only while it actually scrolls (no dead tab stop).
  const syncScrollable = () => {
    if (viewport.scrollWidth > viewport.clientWidth + 1) {
      viewport.tabIndex = 0
      viewport.setAttribute('role', 'region')
      viewport.setAttribute('aria-label', 'Fretboard, scrolls sideways')
    } else {
      viewport.removeAttribute('tabindex')
      viewport.removeAttribute('role')
      viewport.removeAttribute('aria-label')
    }
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncScrollable)
  observer?.observe(viewport)

  let boardKey: string | null = null
  let heardKey: string | null = null

  return {
    update(cells, opts) {
      const layout = layoutFretboard(cells, opts)
      const nextBoard = boardSignature(cells, opts.showNames)
      const boardChanged = nextBoard !== boardKey
      if (boardChanged) {
        svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`)
        drawBoard(doc, boardLayer, layout)
        boardKey = nextBoard
      }
      const nextHeard = `${opts.heardMidi}`
      if (boardChanged || nextHeard !== heardKey) {
        drawHeard(doc, heardLayer, layout)
        heardKey = nextHeard
      }
      if (svg.getAttribute('aria-label') !== layout.ariaLabel) svg.setAttribute('aria-label', layout.ariaLabel)
      if (boardChanged) syncScrollable()
    },
    destroy() {
      observer?.disconnect()
      viewport.remove()
    },
  }
}
