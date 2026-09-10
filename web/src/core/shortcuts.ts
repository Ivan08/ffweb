/**
 * Keyboard shortcuts, as data.
 *
 * One table, because the same facts are needed in three places: to decide what
 * a keystroke did, to label the buttons that do the same thing, and to test
 * that no two of them collide. When the shortcut lived in the handler and its
 * name lived in a `title` string, the two were already disagreeing.
 *
 * Nothing here touches the DOM beyond reading a `KeyboardEvent`, so it can be
 * proven without a browser.
 */

export type ShortcutId =
  | 'open'
  | 'export'
  | 'undo'
  | 'redo'
  | 'playPause'
  | 'stepBack'
  | 'stepForward'
  | 'skipBack'
  | 'skipForward'
  | 'toStart'
  | 'toEnd'
  | 'split'
  | 'remove'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'

export interface Shortcut {
  id: ShortcutId
  /** `event.key`, matched without regard to case. */
  key: string
  /** Ctrl on Windows and Linux, Command on a Mac. */
  mod?: boolean
  shift?: boolean
  /** Held down to repeat: stepping through frames, not splitting a clip. */
  repeatable?: boolean
}

/**
 * Every shortcut the interface answers to.
 *
 * Unmodified letters are deliberately few. The command bar is a textarea that
 * is always on screen, so a bare letter is a keystroke somebody is probably
 * typing; only `s` earns one, and only because the guard below keeps it out of
 * every field.
 */
export const SHORTCUTS: Shortcut[] = [
  { id: 'open', key: 'o', mod: true },
  { id: 'export', key: 'e', mod: true },

  { id: 'undo', key: 'z', mod: true },
  // Shift+Ctrl+Z rather than Ctrl+Y: the same key going the other way is
  // easier to find than a second one, and it is what browsers themselves use.
  { id: 'redo', key: 'z', mod: true, shift: true },

  { id: 'playPause', key: ' ' },
  { id: 'stepBack', key: 'ArrowLeft', repeatable: true },
  { id: 'stepForward', key: 'ArrowRight', repeatable: true },
  { id: 'skipBack', key: 'ArrowLeft', shift: true, repeatable: true },
  { id: 'skipForward', key: 'ArrowRight', shift: true, repeatable: true },
  { id: 'toStart', key: 'Home' },
  { id: 'toEnd', key: 'End' },

  { id: 'split', key: 's' },
  { id: 'remove', key: 'Delete' },

  { id: 'zoomIn', key: '=', mod: true },
  { id: 'zoomOut', key: '-', mod: true },
  { id: 'zoomFit', key: '0', mod: true },
]

/** How far one press of an arrow moves the playhead, in seconds. */
export const STEP_SECONDS = 1 / 30
export const SKIP_SECONDS = 1

/**
 * Whether a keystroke is this shortcut.
 *
 * Shift is compared exactly, in both directions: Ctrl+Z and Ctrl+Shift+Z are
 * opposite actions, so a rule that ignored shift would undo when asked to redo.
 * Alt is never part of a shortcut and always disqualifies one, so the system
 * and the browser keep their own.
 */
export function matches(shortcut: Shortcut, event: KeyboardEvent): boolean {
  if (event.altKey) return false
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false
  if ((event.metaKey || event.ctrlKey) !== Boolean(shortcut.mod)) return false
  return event.shiftKey === Boolean(shortcut.shift)
}

/**
 * Which shortcut a keystroke is, if any.
 *
 * At most one can match: `matches` compares both modifiers exactly, so two
 * entries answering the same keystroke would have to be the same chord twice —
 * which the table is tested not to contain. That is why this can take the
 * first match without ranking them.
 */
export function shortcutFor(event: KeyboardEvent): Shortcut | undefined {
  return SHORTCUTS.find((shortcut) => matches(shortcut, event))
}

/** How the key names are spelled on a Mac. */
const MAC_KEYS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
}

/**
 * The shortcut as a person would write it, for a tooltip.
 *
 * `apple` is passed in rather than sniffed, so this stays testable and so a
 * caller can spell it either way.
 */
export function labelFor(id: ShortcutId, apple = false): string {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id)
  if (!shortcut) return ''

  const parts: string[] = []
  if (shortcut.mod) parts.push(apple ? '⌘' : 'Ctrl')
  if (shortcut.shift) parts.push(apple ? '⇧' : 'Shift')
  parts.push(MAC_KEYS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key))

  return apple ? parts.join('') : parts.join('+')
}

/** True on a Mac, where the modifier is Command and is written differently. */
export function onApple(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}
