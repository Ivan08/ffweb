/**
 * The shared time axis.
 *
 * Every track draws against the same visible window, so the window — and the
 * zooming and panning that move it — belongs to one place rather than to each
 * track. This is lifted almost unchanged from the old single-purpose trim bar,
 * where all three of its awkward parts were already solved: the wheel listener
 * has to be attached by hand, the thumbnail strip has to follow a *settled*
 * view, and a boundary dragged past the edge has to scroll the window.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  clampView,
  fractionOf,
  MIN_VIEW,
  secondsAt as secondsAtFraction,
  zoomAround as zoomView,
  type View,
} from '../../core/geometry'

/** How far past the edge a drag has to go before the window follows, in pixels. */
export const SCROLL_MARGIN = 28

export interface TimelineView {
  view: View
  /** The window after it has stopped moving, for anything expensive to fetch. */
  settledView: View
  viewLength: number
  zoomed: boolean
  duration: number
  /** Attach to the element that defines the axis; the wheel listener lives here. */
  axisRef: React.RefObject<HTMLDivElement | null>
  setView: (start: number, end: number) => void
  zoomAround: (anchor: number, factor: number) => void
  /** Where a client X coordinate falls, in seconds. */
  secondsAt: (clientX: number) => number
  /** Position across the visible window, 0..1. */
  fraction: (seconds: number) => number
  percent: (seconds: number) => string
  /** Seconds covered by a horizontal pixel distance. */
  secondsPerPixel: () => number
  /**
   * Stop the axis rescaling while a gesture changes what it measures, and let
   * it catch up once the gesture is over.
   */
  hold: () => void
  release: () => void
  /** Scroll the window when a drag reaches the edge. */
  followEdge: (clientX: number) => void
}

export function useTimelineView(duration: number): TimelineView {
  const [view, setViewState] = useState<View>({ start: 0, end: duration })

  /**
   * Whether a gesture is under way that changes the length of the timeline.
   *
   * Trimming a clip shortens the timeline, and the axis measures the timeline,
   * so without this the ruler rescales between one pointer move and the next —
   * the edge being dragged slides out from under the pointer, and the trim
   * compounds. On a long clip that runs away to nothing in a few moves.
   */
  const holding = useRef(false)
  const durationRef = useRef(duration)
  durationRef.current = duration

  useEffect(() => {
    if (holding.current) return
    setViewState({ start: 0, end: duration })
  }, [duration])

  const hold = useCallback(() => {
    holding.current = true
  }, [])

  const release = useCallback(() => {
    if (!holding.current) return
    holding.current = false
    // Take in whatever the gesture did, keeping where the window was looking.
    setViewState((current) => clampView(current.start, current.end, durationRef.current))
  }, [])

  const axisRef = useRef<HTMLDivElement>(null)
  // Read inside pointer handlers, which are set up once per drag and would
  // otherwise capture a stale window.
  const viewRef = useRef(view)
  viewRef.current = view

  const viewLength = Math.max(MIN_VIEW, view.end - view.start)
  const zoomed = viewLength < duration - 0.001
  const zoomedRef = useRef(zoomed)
  zoomedRef.current = zoomed

  const setView = useCallback(
    (start: number, end: number) => setViewState(clampView(start, end, duration)),
    [duration],
  )

  const zoomAround = useCallback(
    (anchor: number, factor: number) =>
      setViewState(zoomView(viewRef.current, anchor, factor, duration)),
    [duration],
  )

  const secondsAt = useCallback(
    (clientX: number) => {
      const rect = axisRef.current?.getBoundingClientRect()
      if (!rect || duration <= 0) return 0
      return secondsAtFraction((clientX - rect.left) / rect.width, viewRef.current)
    },
    [duration],
  )

  const fraction = useCallback((seconds: number) => fractionOf(seconds, view), [view])
  const percent = useCallback((seconds: number) => `${fraction(seconds) * 100}%`, [fraction])

  const secondsPerPixel = useCallback(() => {
    const rect = axisRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return viewLength / rect.width
  }, [viewLength])

  const followEdge = useCallback(
    (clientX: number) => {
      if (!zoomedRef.current) return
      const rect = axisRef.current?.getBoundingClientRect()
      if (!rect) return
      // Zoomed in, the moment you want is often just past the edge of the
      // window. Dragging into the margin scrolls it along instead of pinning
      // the block to whatever happens to be visible.
      const past =
        clientX < rect.left + SCROLL_MARGIN
          ? clientX - (rect.left + SCROLL_MARGIN)
          : clientX > rect.right - SCROLL_MARGIN
            ? clientX - (rect.right - SCROLL_MARGIN)
            : 0
      if (past === 0) return
      const shift = (past / rect.width) * viewLength
      setView(viewRef.current.start + shift, viewRef.current.end + shift)
    },
    [setView, viewLength],
  )

  // Frames are twelve ffmpeg processes per window, so they follow a settled
  // view: a few quick zoom clicks would otherwise queue a hundred extractions
  // for ranges nobody is looking at any more.
  const [settledView, setSettledView] = useState(view)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledView(view), 180)
    return () => window.clearTimeout(timer)
  }, [view])

  // React registers `onWheel` as a passive listener, where `preventDefault` is
  // ignored — the zoom would work but the page would scroll away underneath it.
  // The listener is therefore attached by hand, non-passive.
  const onWheel = useRef<(event: WheelEvent) => void>(() => {})
  onWheel.current = (event: WheelEvent) => {
    if (duration <= 0) return
    // A modifier zooms, matching every map and editing timeline; a plain wheel
    // pans, but only when there is somewhere to pan to.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      zoomAround(secondsAt(event.clientX), event.deltaY > 0 ? 1.25 : 0.8)
    } else if (zoomed) {
      const direction = Math.sign(event.deltaX || event.deltaY)
      if (!direction) return
      const step = viewLength * 0.15 * direction
      setView(view.start + step, view.end + step)
    } else {
      return
    }
    event.preventDefault()
  }

  useEffect(() => {
    // Keyed on `duration` because the axis is not rendered until the file has
    // been probed; without it the listener would attach to nothing and the
    // wheel would be dead for the rest of the session.
    const element = axisRef.current
    if (!element) return
    const listener = (event: WheelEvent) => onWheel.current(event)
    element.addEventListener('wheel', listener, { passive: false })
    return () => element.removeEventListener('wheel', listener)
  }, [duration])

  return useMemo(
    () => ({
      view,
      settledView,
      viewLength,
      zoomed,
      duration,
      axisRef,
      setView,
      zoomAround,
      secondsAt,
      fraction,
      percent,
      secondsPerPixel,
      followEdge,
      hold,
      release,
    }),
    [
      view,
      settledView,
      viewLength,
      zoomed,
      duration,
      setView,
      zoomAround,
      secondsAt,
      fraction,
      percent,
      secondsPerPixel,
      followEdge,
      hold,
      release,
    ],
  )
}

export { useDrag } from '../usePointerDrag'
