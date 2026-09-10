/**
 * Turning a file's peaks into the columns of a drawn waveform.
 *
 * Kept apart from the canvas because it is arithmetic, and arithmetic that is
 * wrong by a fraction of a second looks like a waveform that is merely a bit
 * off — the least visible kind of mistake and the hardest to argue about by
 * eye. Here it is numbers instead.
 *
 * Peaks are fetched once per file and cover the whole of it. Zooming reads a
 * narrower slice of the same array rather than asking for anything, which is
 * why this takes a range and not a request.
 */

import type { Peaks } from './types'

/**
 * The loudest moment in each column of a range of a file.
 *
 * `from` and `to` are seconds into the *file*, not the timeline; a clip that
 * has been trimmed shows the part it uses. A column that falls outside what
 * was measured reads as silence rather than as the nearest thing measured,
 * because a waveform that keeps drawing past the end of the sound is claiming
 * something untrue.
 */
export function columns(peaks: Peaks, from: number, to: number, count: number): number[] {
  const wanted = Math.max(0, Math.floor(count))
  if (wanted === 0) return []
  if (peaks.peaks.length === 0 || peaks.duration <= 0) return new Array(wanted).fill(0)

  const span = to - from
  if (span <= 0) return new Array(wanted).fill(0)

  // What was measured may itself be a slice of the file, so a column is placed
  // relative to where the measurement starts rather than to zero.
  const start = peaks.from
  const perSecond = peaks.peaks.length / peaks.duration

  const drawn: number[] = []
  for (let index = 0; index < wanted; index += 1) {
    const columnStart = from + (span * index) / wanted
    const columnEnd = from + (span * (index + 1)) / wanted

    // Rounded outward, so a column narrower than a measured slice still covers
    // the slice it sits inside rather than falling between two.
    const first = Math.max(0, Math.floor((columnStart - start) * perSecond))
    const last = Math.min(peaks.peaks.length, Math.ceil((columnEnd - start) * perSecond))

    // A column outside what was measured covers nothing and reads as silence,
    // which is the honest answer: a waveform drawn past the end of the sound
    // would be claiming something nobody measured.
    let loudest = 0
    for (let at = first; at < last; at += 1) {
      const value = peaks.peaks[at]
      if (value > loudest) loudest = value
    }
    drawn.push(loudest)
  }
  return drawn
}

/**
 * Whether the window is narrow enough that the whole-file peaks are too coarse.
 *
 * Two thousand slices of a two-hour film is one every four seconds, and a
 * ten-second window drawn from that is two and a half slices stretched across
 * the screen. Past this point it is worth asking for the range on its own.
 */
export function wantsDetail(peaks: Peaks, from: number, to: number): boolean {
  const span = to - from
  if (span <= 0 || peaks.duration <= 0) return false
  const perSecond = peaks.peaks.length / peaks.duration
  // Fewer than this many measured slices across the window and the picture is
  // being invented rather than drawn.
  return span * perSecond < 200
}

/** Whether a measurement covers the whole of a window, with nothing missing. */
export function covers(peaks: Peaks | null, from: number, to: number): boolean {
  if (!peaks || peaks.duration <= 0) return false
  // A hair of slack, because both ends have been through rounding.
  const slack = 0.001
  return peaks.from <= from + slack && peaks.from + peaks.duration >= to - slack
}

/**
 * Which of the two measurements to draw a window from.
 *
 * The detailed one is finer but covers only the range it was asked for, so it
 * is right only while the window stays inside it. Zooming back out has to fall
 * back to the whole-file measurement rather than carry on reading a slice —
 * which is what a single slot for both did, drawing the wide view as a sliver
 * of sound with silence on either side of it.
 */
export function bestFor(
  whole: Peaks | null,
  detail: Peaks | null,
  from: number,
  to: number,
): Peaks | null {
  if (covers(detail, from, to)) return detail
  return whole
}

/**
 * Round a range outward to stable boundaries.
 *
 * Two nearly-identical windows would otherwise be two different requests and
 * two different cache entries, so panning by a pixel would decode the file
 * again. Snapping means a slow pan reuses what it already asked for.
 */
export function detailRange(
  from: number,
  to: number,
  duration: number,
): { from: number; to: number } {
  const span = Math.max(0.1, to - from)
  // A power of two seconds, so successive zoom levels nest inside each other.
  const step = Math.pow(2, Math.floor(Math.log2(span)))
  const start = Math.max(0, Math.floor(from / step) * step)
  const end = Math.min(duration || Infinity, Math.ceil(to / step) * step)
  return { from: start, to: end > start ? end : start + step }
}
