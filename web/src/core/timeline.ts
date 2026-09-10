/**
 * Arithmetic for a track of blocks.
 *
 * `geometry.ts` already covers the one-dimensional window — zooming, panning,
 * turning a pixel into a second. What it does not cover is a *block* on that
 * window: where each clip lands once the ones before it have played, and how a
 * span behaves when it is dragged or resized. That is what lives here.
 *
 * All of it is arithmetic on numbers, which is the point: the timeline is the
 * part of the interface most likely to be subtly wrong, and none of this needs
 * a browser to check.
 */

import { clamp, fractionOf, type View } from './geometry'
import { laidOut, sourceAt, type Clip } from './project'

// Where a moment on a block falls in its source: the model's answer, re-exported
// so the tracks can ask the module they already talk to.
export { sourceAt }

export interface Span {
  start: number
  end: number
}

/** A clip and where it sits on the finished timeline. */
export interface Placed extends Span {
  uid: string
  clip: Clip
}

/** The shortest a block is allowed to become, in seconds. */
export const MIN_SPAN = 0.05

/**
 * The narrowest a block may be drawn, as a fraction of the visible window.
 *
 * A block of no length still has to be findable and grabbable. This is a
 * fraction, not a percentage — the same units as everything else on the axis —
 * because reading it as a percentage silently stretched every short block to
 * forty per cent of the timeline.
 */
export const MIN_BLOCK = 0.004

/**
 * The part of a clip's source that is actually on screen.
 *
 * A block is drawn clipped to the visible window, so what fills it has to be
 * clipped the same way. Sampling the whole clip instead — which is what the
 * frame strip and the waveform both used to do — draws the entire clip inside
 * whatever sliver of it is showing, so zooming in magnifies the block and
 * changes nothing inside it.
 *
 * Returned in ascending order even for a reversed clip, where the source runs
 * the other way: callers want a range to read, and which end of the file it
 * started from is `reverse`'s business, not theirs.
 */
export function visibleSource(block: Placed, view: View): Span | null {
  const start = Math.max(block.start, view.start)
  const end = Math.min(block.end, view.end)
  if (end <= start) return null

  const first = sourceAt(block.clip, start - block.start)
  const last = sourceAt(block.clip, end - block.start)
  return first <= last ? { start: first, end: last } : { start: last, end: first }
}

/**
 * Where a block sits on the axis, ready for CSS, in per cent.
 *
 * This is arithmetic, so it lives with the arithmetic rather than inside three
 * components that each got it slightly wrong. `null` means the block is off
 * screen and there is nothing to draw.
 */
export function blockPlacement(
  from: number,
  to: number,
  view: Span,
): { left: number; width: number } | null {
  const left = fractionOf(from, view)
  const right = fractionOf(to, view)
  if (right < 0 || left > 1) return null
  const visible = Math.min(1, right) - Math.max(0, left)
  return {
    left: Math.max(0, left) * 100,
    // Fractions throughout: reading the floor as a percentage is what stretched
    // every short block to nearly half the timeline.
    width: Math.max(MIN_BLOCK, visible) * 100,
  }
}

/**
 * Where every clip lands when they play one after another.
 *
 * Positions account for speed and repetition, because those change how long a
 * clip occupies — which is exactly why they are properties of a clip and not
 * effects.
 */
export function layout(clips: Clip[]): Placed[] {
  // The walk itself lives with the model, so the picture on screen and the
  // command being built cannot disagree about where a clip sits.
  return laidOut(clips).map((block) => ({ ...block, uid: block.clip.uid }))
}

/** Which clip is playing at a given moment, and where inside its source. */
export function clipAt(
  clips: Clip[],
  seconds: number,
): { uid: string; clip: Clip; sourceSeconds: number } | null {
  for (const placed of layout(clips)) {
    if (seconds < placed.start || seconds > placed.end) continue
    return {
      uid: placed.uid,
      clip: placed.clip,
      sourceSeconds: sourceAt(placed.clip, seconds - placed.start),
    }
  }
  return null
}

/**
 * The inverse of `clipAt`: where a moment inside a clip falls on the timeline.
 *
 * A `<video>` reports its own time, which is a position in one file. On a
 * joined timeline that is not where the playhead is, and taking one for the
 * other put the marker in the wrong place the moment a second clip existed.
 */
export function timelineAt(clips: Clip[], uid: string, sourceSeconds: number): number | null {
  for (const placed of layout(clips)) {
    if (placed.uid !== uid) continue
    const { clip } = placed
    const speed = clip.speed > 0 ? clip.speed : 1
    const travelled = clip.reverse ? clip.out - sourceSeconds : sourceSeconds - clip.in
    return placed.start + travelled / speed
  }
  return null
}

/**
 * Move a span without changing its length, stopping at the bounds.
 *
 * Sliding rather than squashing: pushing a block against the end of the
 * timeline should park it there, not shorten it.
 */
export function moveSpan(span: Span, delta: number, bounds: Span): Span {
  const length = span.end - span.start
  const start = clamp(span.start + delta, bounds.start, Math.max(bounds.start, bounds.end - length))
  return { start, end: start + length }
}

/** Drag one edge of a span, keeping it at least `MIN_SPAN` long. */
export function resizeSpan(
  span: Span,
  handle: 'start' | 'end',
  to: number,
  bounds: Span,
): Span {
  if (handle === 'start') {
    const start = clamp(to, bounds.start, span.end - MIN_SPAN)
    return { start, end: span.end }
  }
  const end = clamp(to, span.start + MIN_SPAN, bounds.end)
  return { start: span.start, end }
}

/**
 * Pull a value onto a nearby landmark.
 *
 * Clip boundaries and the ends of the timeline are where people mean to put
 * things, and hitting them exactly with a mouse over a zoomed-out hour is
 * otherwise luck.
 */
export function snap(value: number, candidates: number[], tolerance: number): number {
  let best = value
  let bestDistance = tolerance
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Every moment worth snapping to. */
export function landmarks(clips: Clip[], duration: number, playhead: number): number[] {
  const marks = [0, duration, playhead]
  for (const placed of layout(clips)) marks.push(placed.start, placed.end)
  return marks
}

/**
 * A readable ladder of tick marks for the visible window.
 *
 * The step is chosen so the ruler carries roughly one label every hundred
 * pixels at any zoom, which is what keeps an hour and three seconds both
 * legible without a special case for either.
 */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]

export function tickMarks(
  view: Span,
  pixelWidth: number,
): Array<{ at: number; major: boolean }> {
  const length = Math.max(0.001, view.end - view.start)
  if (pixelWidth <= 0) return []
  const wanted = length / Math.max(1, pixelWidth / 100)
  const step = STEPS.find((candidate) => candidate >= wanted) ?? STEPS[STEPS.length - 1]
  const minor = step / 5

  const marks: Array<{ at: number; major: boolean }> = []
  const first = Math.ceil(view.start / minor) * minor
  for (let at = first; at <= view.end; at += minor) {
    // Floating point drift makes an exact remainder test unreliable over a long
    // ladder, so the comparison has a tolerance.
    const remainder = Math.abs(at / step - Math.round(at / step))
    marks.push({ at, major: remainder < 0.001 })
    if (marks.length > 2000) break
  }
  return marks
}
