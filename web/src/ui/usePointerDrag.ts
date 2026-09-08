/**
 * Run a pointer drag to completion.
 *
 * Every draggable thing needs the same three: the listeners on the window
 * rather than on the element, so the pointer may leave it; text selection
 * suppressed while it runs; and a teardown that always happens.
 *
 * "Always" is the hard part. A drag does not only end with `pointerup`. The
 * browser sends `pointercancel` when it takes the gesture over — a native image
 * drag, a touch that turns into a scroll — and after that no `pointerup` is
 * coming, so a handler waiting for one keeps running: the thing being dragged
 * follows a mouse button nobody is holding down. Losing the window has the same
 * effect. All three end it.
 */

import { useEffect, useRef } from 'react'

export function useDrag(onMove: ((event: PointerEvent) => void) | null, onEnd?: () => void) {
  const moveRef = useRef(onMove)
  moveRef.current = onMove
  const endRef = useRef(onEnd)
  endRef.current = onEnd

  useEffect(() => {
    if (!onMove) return

    const move = (event: PointerEvent) => moveRef.current?.(event)
    const stop = () => endRef.current?.()

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('lostpointercapture', stop)
    window.addEventListener('blur', stop)

    const previous = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('lostpointercapture', stop)
      window.removeEventListener('blur', stop)
      document.body.style.userSelect = previous
    }
    // Only whether a drag is in progress matters; the handler itself is read
    // through a ref so a re-render mid-drag does not detach the listeners.
  }, [Boolean(onMove)])
}
