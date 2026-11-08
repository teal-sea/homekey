// ─── Take guard ─────────────────────────────────────────────────────
// Export is the only backup (SPEC rule 10). A loop the last export does not
// hold is unsaved: Clear then asks for a second press and the browser asks
// before a reload or close. This is the bookkeeping behind that, pure, so it
// can be tested without a page; main.ts owns the timer, the unload listener
// and the buttons.

export interface Layers { hasBase: boolean; hasOverdub: boolean }

export interface TakeGuard {
  /** The last export holds every layer seen since. */
  exported: boolean
  /** The layers at the last looper change. */
  seen: Layers
}

export const NOTHING_SEEN: TakeGuard = { exported: false, seen: { hasBase: false, hasOverdub: false } }

/**
 * Call on every looper change. A layer that was not there before is audio no
 * export holds yet; a layer going away (Undo) leaves nothing new to lose.
 */
export function track(guard: TakeGuard, now: Layers | null): TakeGuard {
  const seen = { hasBase: now?.hasBase ?? false, hasOverdub: now?.hasOverdub ?? false }
  const fresh = (seen.hasBase && !guard.seen.hasBase) || (seen.hasOverdub && !guard.seen.hasOverdub)
  return { exported: fresh ? false : guard.exported, seen }
}

export function markExported(guard: TakeGuard): TakeGuard {
  return { ...guard, exported: true }
}

/** A loop exists that the last export does not hold. */
export function unsaved(guard: TakeGuard, now: Layers | null): boolean {
  return (now?.hasBase ?? false) && !guard.exported
}
