// ─── DOM helpers ────────────────────────────────────────────────────
// The page is built with createElement, never innerHTML: the CSP has no
// 'unsafe-inline', so markup can carry no style attribute or inline handler,
// and building nodes keeps any file or device name a user brings as text.

export type Child = Node | string | null | undefined | false

export type Attrs = Record<string, string | number | boolean | null | undefined>

/** Create an element. `true` sets a boolean attribute; false, null and undefined leave it off. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue
    node.setAttribute(name, value === true ? '' : String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child)
  }
  return node
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

/** Show or hide with the `hidden` attribute (the stylesheet keeps it authoritative). */
export function show(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible
}

/** A message line: hidden when there is nothing to say. */
export function say(node: HTMLElement, text: string | null): void {
  setText(node, text ?? '')
  show(node, text !== null && text !== '')
}

export function setPressed(button: HTMLButtonElement, on: boolean): void {
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
}

export function replaceOptions(select: HTMLSelectElement, options: { value: string; label: string; disabled?: boolean }[], value: string): void {
  select.replaceChildren(...options.map(o => {
    const opt = h('option', { value: o.value, disabled: o.disabled === true }, [o.label])
    return opt
  }))
  select.value = value
}
