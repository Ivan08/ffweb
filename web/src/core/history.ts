/**
 * Undo and redo, as a value.
 *
 * The whole of what the user is editing is one `Project`, replaced wholesale on
 * every change, so a step of history is a snapshot rather than a pair of
 * do/undo commands. A snapshot cannot fall out of step with the model the way
 * an inverse command can: there is no second description of the edit to get
 * wrong, and an action added later gets history without writing anything.
 *
 * This lives here, apart from the store, because the store imports the API
 * client, which reads `window.location` as it loads — and the tests run in
 * node. Anything that has to be proven has to be reachable without a browser.
 */

/** One step back: the value as it was, and what kind of edit replaced it. */
export interface Step<T> {
  value: T
  /** What the edit was, for merging. Undefined never merges. */
  key?: string
  /** When it was recorded, in milliseconds. */
  at: number
}

export interface History<T> {
  past: Step<T>[]
  future: T[]
}

/**
 * How many steps back you can go.
 *
 * Deep enough that nobody reaches the floor by accident, shallow enough that
 * fifty timelines' worth of clips, sounds and overlays is not worth thinking
 * about.
 */
export const HISTORY_LIMIT = 50

/**
 * How close together two edits of the same kind become one step.
 *
 * Dragging a trim handle emits an edit every few milliseconds; without this,
 * one gesture would cost forty steps and undo would move the handle by a pixel.
 * The window is what makes a *gesture* the unit, and it is deliberately short:
 * two considered nudges a second apart are two intentions.
 */
export const MERGE_MS = 500

export function cleared<T>(): History<T> {
  return { past: [], future: [] }
}

/**
 * Note the value that is about to be replaced.
 *
 * Call it with the *outgoing* value, before the new one is set. `key` names
 * what kind of edit is happening: two in a row with the same key, close enough
 * in time, keep the earlier snapshot rather than adding another, so the whole
 * drag undoes at once. Structural edits — adding, removing, reordering,
 * splitting — pass no key and always take a step, because two removals
 * collapsed into one is not an undo anybody asked for.
 *
 * Any edit clears the redo stack: once you have gone a different way, the way
 * you came back from is gone.
 */
export function record<T>(
  history: History<T>,
  present: T,
  key: string | undefined,
  now: number,
): History<T> {
  const last = history.past[history.past.length - 1]

  if (last && key !== undefined && last.key === key && now - last.at < MERGE_MS) {
    // Keep the older snapshot — it is the one from before the gesture began —
    // but move the clock forward, so a drag that runs for a minute stays one
    // step instead of taking a new one every half second.
    const merged = [...history.past]
    merged[merged.length - 1] = { ...last, at: now }
    return { past: merged, future: [] }
  }

  const past = [...history.past, { value: present, key, at: now }]
  // Drop from the far end, which is the step nobody is coming back for.
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
  return { past, future: [] }
}

/** Step back. Null when there is nowhere to go, so the caller changes nothing. */
export function undo<T>(
  history: History<T>,
  present: T,
): { history: History<T>; present: T } | null {
  const last = history.past[history.past.length - 1]
  if (!last) return null
  return {
    history: { past: history.past.slice(0, -1), future: [present, ...history.future] },
    present: last.value,
  }
}

/** Step forward again, undoing an undo. Null when there is nothing to redo. */
export function redo<T>(
  history: History<T>,
  present: T,
): { history: History<T>; present: T } | null {
  const [next, ...rest] = history.future
  if (next === undefined) return null
  return {
    // No key: a redone step must never merge with the edit that follows it.
    history: { past: [...history.past, { value: present, at: 0 }], future: rest },
    present: next,
  }
}
