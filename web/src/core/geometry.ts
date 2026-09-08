/**
 * The arithmetic behind the direct-manipulation controls.
 *
 * Dragging a crop corner, zooming a timeline and sizing a column are all
 * geometry, not interface: they are the parts that can be wrong in ways a
 * screenshot will not show, and the parts worth testing. Keeping them here
 * means the components are left with layout and event plumbing.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

/** Below this a crop rectangle's handles overlap into something undraggable. */
export const MIN_CROP = 24

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Where a picture sits inside a box that does not share its aspect ratio.
 *
 * `object-contain` centres the picture and leaves bars on two sides. An overlay
 * positioned against the box rather than the picture lands on those bars, so a
 * crop drawn there is not the crop that gets applied.
 */
export function letterbox(
  box: { width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
): { left: number; top: number; width: number; height: number } {
  if (box.width <= 0 || box.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }
}

/**
 * Apply a drag to one edge, one corner, or the whole rectangle.
 *
 * Dragging a left or top edge moves the origin and changes the size together,
 * which is why the two cannot be handled independently.
 */
export function resizeRect(
  rect: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  maxWidth: number,
  maxHeight: number,
): Rect {
  let { x, y, w, h } = rect

  if (handle === 'move') {
    // Moving never resizes: the rectangle stops at the edge instead of being
    // squashed against it.
    return { x: clamp(x + dx, 0, maxWidth - w), y: clamp(y + dy, 0, maxHeight - h), w, h }
  }

  if (handle.includes('w')) {
    const nextX = clamp(x + dx, 0, x + w - MIN_CROP)
    w += x - nextX
    x = nextX
  }
  if (handle.includes('e')) {
    w = clamp(w + dx, MIN_CROP, maxWidth - x)
  }
  if (handle.includes('n')) {
    const nextY = clamp(y + dy, 0, y + h - MIN_CROP)
    h += y - nextY
    y = nextY
  }
  if (handle.includes('s')) {
    h = clamp(h + dy, MIN_CROP, maxHeight - y)
  }

  return { x, y, w, h }
}

export interface View {
  start: number
  end: number
}

/** Never zoom in past this, or the two trim boundaries land on the same pixel. */
export const MIN_VIEW = 0.5

/**
 * Fit a proposed view inside the file, keeping its length.
 *
 * Panning past either end should stop, not shrink the window — otherwise
 * scrolling to the end quietly zooms in.
 */
export function clampView(start: number, end: number, duration: number): View {
  const length = Math.max(MIN_VIEW, Math.min(end - start, duration))
  const clampedStart = clamp(start, 0, Math.max(0, duration - length))
  return { start: clampedStart, end: clampedStart + length }
}

/**
 * Zoom about a fixed point, so whatever is under the cursor stays under it.
 */
export function zoomAround(view: View, anchor: number, factor: number, duration: number): View {
  const currentLength = Math.max(MIN_VIEW, view.end - view.start)
  const length = Math.max(MIN_VIEW, Math.min(currentLength * factor, duration))
  const ratio = currentLength > 0 ? (anchor - view.start) / currentLength : 0.5
  const start = anchor - ratio * length
  return clampView(start, start + length, duration)
}

/** Position of a moment across the visible window, 0..1 and unclamped. */
export function fractionOf(seconds: number, view: View): number {
  const length = Math.max(MIN_VIEW, view.end - view.start)
  return (seconds - view.start) / length
}

/** The moment at a fraction across the visible window. */
export function secondsAt(fraction: number, view: View): number {
  const length = Math.max(MIN_VIEW, view.end - view.start)
  return view.start + clamp(fraction, 0, 1) * length
}

/**
 * Slide a trim selection without changing its length, stopping at both ends.
 */
export function slideSelection(
  selection: View,
  delta: number,
  duration: number,
): View {
  const length = selection.end - selection.start
  const start = clamp(selection.start + delta, 0, Math.max(0, duration - length))
  return { start, end: start + length }
}
