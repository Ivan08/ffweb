/**
 * Draggable column widths, remembered between sessions.
 *
 * The three columns hold very different things — a file tree, a video, a form —
 * and no fixed split suits every screen or every task, so the split is the
 * user's to set.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { clamp } from '../core/geometry'

export interface Resizable {
  width: number
  /** Attach to the splitter's `onPointerDown`. */
  onPointerDown: (event: React.PointerEvent) => void
  dragging: boolean
  /** Double-click a splitter to restore the default. */
  reset: () => void
}

export function useResizable(
  key: string,
  initial: number,
  min: number,
  max: number,
  /** `end` for a column resized from its left edge, where dragging left grows it. */
  edge: 'start' | 'end' = 'start',
): Resizable {
  const storageKey = `ffweb.layout.${key}`

  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey))
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved
    } catch {
      // Storage can be unavailable; the default is fine.
    }
    return initial
  })
  const [dragging, setDragging] = useState(false)
  const origin = useRef({ x: 0, width: 0 })

  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      const delta = event.clientX - origin.current.x
      const next = origin.current.width + (edge === 'start' ? delta : -delta)
      setWidth(Math.round(clamp(next, min, max)))
    }
    const onUp = () => setDragging(false)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // While dragging, the pointer regularly leaves the 5px splitter; without
    // this the browser starts selecting text in whatever it passes over.
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = previousSelect
      document.body.style.cursor = previousCursor
    }
  }, [dragging, edge, min, max])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width))
    } catch {
      // Not remembering the layout is a minor loss.
    }
  }, [storageKey, width])

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      origin.current = { x: event.clientX, width }
      setDragging(true)
    },
    [width],
  )

  const reset = useCallback(() => setWidth(initial), [initial])

  return { width, onPointerDown, dragging, reset }
}
