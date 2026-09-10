/**
 * The one keyboard listener.
 *
 * What it mostly does is decline. The command bar is a textarea that is always
 * on screen and the inspector is full of fields, so the interesting question is
 * not which key does what — that is `core/shortcuts.ts` — but when a keystroke
 * belongs to the application at all rather than to whatever the person is
 * typing into.
 */

import { useEffect } from 'react'

import { contentEnd, timelineDuration } from '../core/project'
import { clipAt } from '../core/timeline'
import {
  shortcutFor,
  SKIP_SECONDS,
  STEP_SECONDS,
  type ShortcutId,
} from '../core/shortcuts'
import { useStore } from '../store'

/**
 * Whether the keystroke belongs to something being typed into.
 *
 * Checked for every shortcut without exception, modified ones included: Ctrl+Z
 * in a text field is the browser's own undo of the text, and taking it over
 * would undo the timeline while somebody edits a caption.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Somebody else has already answered this one.
      if (event.defaultPrevented) return
      // Mid-composition in an IME, where every keystroke is part of a letter.
      if (event.isComposing || event.keyCode === 229) return
      if (isTyping(event.target)) return

      const shortcut = shortcutFor(event)
      if (!shortcut) return
      if (event.repeat && !shortcut.repeatable) return

      const state = useStore.getState()

      // A modal owns the keyboard while it is up. Escape is its own business
      // and never reaches this table.
      if (state.dialog !== null) return

      if (!run(shortcut.id)) return
      event.preventDefault()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Do the thing, and say whether anything was done.
 *
 * A shortcut that finds nothing to act on returns false and lets the keystroke
 * through, so `Delete` with nothing selected still does whatever it would have
 * done and the browser is not silently robbed of a key.
 */
function run(id: ShortcutId): boolean {
  const state = useStore.getState()
  const { project, playhead } = state

  switch (id) {
    case 'open':
      state.openDialog('files')
      return true

    case 'export':
      if (project.clips.length === 0) return false
      state.openDialog('export')
      return true

    case 'undo':
      if (state.history.past.length === 0) return false
      state.undo()
      return true

    case 'redo':
      if (state.history.future.length === 0) return false
      state.redo()
      return true

    case 'playPause': {
      const player = state.player
      if (!player) return false
      if (player.playing()) player.pause()
      else player.play()
      return true
    }

    case 'stepBack':
      return seek(playhead - STEP_SECONDS)
    case 'stepForward':
      return seek(playhead + STEP_SECONDS)
    case 'skipBack':
      return seek(playhead - SKIP_SECONDS)
    case 'skipForward':
      return seek(playhead + SKIP_SECONDS)
    case 'toStart':
      return seek(0)
    case 'toEnd':
      return seek(contentEnd(project))

    case 'split': {
      const at = clipAt(project.clips, playhead)
      if (!at) return false
      state.splitClip(at.uid, playhead)
      return true
    }

    case 'remove':
      return removeFocused()

    case 'zoomIn':
      if (!state.timelineView) return false
      state.timelineView.zoomIn()
      return true
    case 'zoomOut':
      if (!state.timelineView) return false
      state.timelineView.zoomOut()
      return true
    case 'zoomFit':
      if (!state.timelineView) return false
      state.timelineView.fit()
      return true
  }
}

function seek(seconds: number): boolean {
  const state = useStore.getState()
  if (timelineDuration(state.project) <= 0) return false
  state.setPlayhead(Math.max(0, Math.min(seconds, contentEnd(state.project))))
  return true
}

/** Delete whatever the inspector is showing, which is what "selected" means here. */
function removeFocused(): boolean {
  const state = useStore.getState()
  const { focus } = state

  switch (focus.kind) {
    case 'clip':
      state.removeClip(focus.uid)
      break
    case 'overlay':
      state.removeOverlay(focus.uid)
      break
    case 'sound':
      state.removeSound(focus.uid)
      break
    case 'subtitles':
      state.setSubtitles(null)
      break
    default:
      // The audio track cannot be removed, and nothing is selected otherwise.
      return false
  }

  state.setFocus({ kind: 'none' })
  return true
}
