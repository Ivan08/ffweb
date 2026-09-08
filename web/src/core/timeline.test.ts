/**
 * Arithmetic for a track of blocks.
 *
 * The interface for this is pixels and pointers, which makes it the part hardest
 * to check by looking. All of it is here as numbers instead.
 */

import { describe, expect, it } from 'vitest'

import { clipOf, type Clip } from './project'
import {
  blockPlacement,
  clipAt,
  timelineAt,
  landmarks,
  layout,
  MIN_SPAN,
  moveSpan,
  resizeSpan,
  snap,
  tickMarks,
} from './timeline'
import type { MediaFile } from './types'

const source = (duration: number): MediaFile => ({
  id: 'f',
  path: '/x.mp4',
  name: 'x.mp4',
  size: 1,
  info: {
    duration,
    size: 1,
    bit_rate: 1,
    format_name: 'mp4',
    width: 100,
    height: 100,
    fps: 25,
    video_codec: 'h264',
    audio_codec: 'aac',
    has_video: true,
    has_audio: true,
    raw: {},
  },
})

const clip = (uid: string, patch: Partial<Clip> = {}): Clip => ({
  ...clipOf(uid, source(10)),
  ...patch,
})

describe('laying clips out', () => {
  it('puts each one after the last', () => {
    const placed = layout([clip('a', { out: 6 }), clip('b', { out: 4 })])
    expect(placed.map((block) => [block.start, block.end])).toEqual([
      [0, 6],
      [6, 10],
    ])
  })

  it('accounts for speed, so the blocks match what plays', () => {
    const placed = layout([clip('a', { out: 10, speed: 2 }), clip('b', { out: 4 })])
    expect(placed[0].end).toBe(5)
    expect(placed[1].start).toBe(5)
  })

  it('is empty for an empty track', () => {
    expect(layout([])).toEqual([])
  })
})

describe('what is playing at a moment', () => {
  const clips = [clip('a', { in: 2, out: 8 }), clip('b', { in: 0, out: 4 })]

  it('finds the clip and where inside its source', () => {
    // Three seconds along the timeline is three seconds into the first clip,
    // and that clip itself begins two seconds into its file.
    expect(clipAt(clips, 3)).toMatchObject({ uid: 'a', sourceSeconds: 5 })
  })

  it('crosses into the next clip', () => {
    expect(clipAt(clips, 7)).toMatchObject({ uid: 'b', sourceSeconds: 1 })
  })

  it('scales by speed', () => {
    const fast = [clip('a', { in: 0, out: 10, speed: 2 })]
    // Two seconds of timeline is four seconds of a clip playing twice as fast.
    expect(clipAt(fast, 2)).toMatchObject({ sourceSeconds: 4 })
  })

  it('is nothing past the end', () => {
    expect(clipAt(clips, 99)).toBeNull()
  })
})

describe('going back from a clip to the timeline', () => {
  const clips = [clip('a', { in: 2, out: 8 }), clip('b', { in: 0, out: 4 })]

  it('is the exact inverse of finding what is playing', () => {
    for (const at of [0, 1.5, 3, 5.999, 7, 9.5]) {
      const found = clipAt(clips, at)!
      expect(timelineAt(clips, found.uid, found.sourceSeconds)).toBeCloseTo(at, 6)
    }
  })

  it('accounts for speed', () => {
    const fast = [clip('a', { in: 0, out: 10, speed: 2 })]
    // Four seconds into a clip playing twice as fast is two on the timeline.
    expect(timelineAt(fast, 'a', 4)).toBeCloseTo(2, 6)
  })

  it('is nothing for a clip that is not there', () => {
    expect(timelineAt(clips, 'zzz', 1)).toBeNull()
  })
})

describe('moving a span', () => {
  const bounds = { start: 0, end: 10 }

  it('keeps its length', () => {
    expect(moveSpan({ start: 2, end: 5 }, 3, bounds)).toEqual({ start: 5, end: 8 })
  })

  it('parks against the end rather than squashing itself', () => {
    // The alternative — clamping each edge on its own — silently shortens the
    // block, so a logo dragged off the end would also get briefer.
    expect(moveSpan({ start: 6, end: 9 }, 10, bounds)).toEqual({ start: 7, end: 10 })
  })

  it('parks against the start too', () => {
    expect(moveSpan({ start: 2, end: 5 }, -10, bounds)).toEqual({ start: 0, end: 3 })
  })
})

describe('resizing a span', () => {
  const bounds = { start: 0, end: 10 }

  it('drags one edge and leaves the other', () => {
    expect(resizeSpan({ start: 2, end: 8 }, 'start', 4, bounds)).toEqual({ start: 4, end: 8 })
    expect(resizeSpan({ start: 2, end: 8 }, 'end', 6, bounds)).toEqual({ start: 2, end: 6 })
  })

  it('will not let the edges cross', () => {
    const collapsed = resizeSpan({ start: 2, end: 8 }, 'start', 99, bounds)
    expect(collapsed.start).toBeCloseTo(8 - MIN_SPAN)
    expect(collapsed.end).toBe(8)
  })

  it('stays inside the bounds', () => {
    expect(resizeSpan({ start: 2, end: 8 }, 'end', 99, bounds).end).toBe(10)
    expect(resizeSpan({ start: 2, end: 8 }, 'start', -99, bounds).start).toBe(0)
  })
})

describe('snapping', () => {
  it('pulls onto a nearby landmark', () => {
    expect(snap(4.03, [0, 4, 10], 0.1)).toBe(4)
  })

  it('leaves a value that is not near anything', () => {
    expect(snap(4.5, [0, 4, 10], 0.1)).toBe(4.5)
  })

  it('picks the closest of two', () => {
    expect(snap(4.4, [4, 4.5], 1)).toBe(4.5)
  })

  it('offers the clip edges and the playhead', () => {
    const marks = landmarks([clip('a', { out: 6 })], 6, 2.5)
    expect(marks).toContain(0)
    expect(marks).toContain(6)
    expect(marks).toContain(2.5)
  })
})

describe('the ruler', () => {
  it('keeps the labels roughly a hundred pixels apart at any zoom', () => {
    for (const length of [3, 30, 300, 3600]) {
      const marks = tickMarks({ start: 0, end: length }, 900)
      const majors = marks.filter((mark) => mark.major)
      expect(majors.length, `${length}s`).toBeGreaterThan(2)
      expect(majors.length, `${length}s`).toBeLessThan(30)
    }
  })

  it('starts inside the window rather than before it', () => {
    const marks = tickMarks({ start: 7.3, end: 12.3 }, 900)
    expect(marks[0].at).toBeGreaterThanOrEqual(7.3)
    expect(marks[marks.length - 1].at).toBeLessThanOrEqual(12.3)
  })

  it('produces nothing without a width to fill', () => {
    expect(tickMarks({ start: 0, end: 10 }, 0)).toEqual([])
  })
})

describe('placing a block on the axis', () => {
  const view = { start: 0, end: 25 }

  const at = (from: number, to: number) => {
    const place = blockPlacement(from, to, view)!
    return [Number(place.left.toFixed(3)), Number(place.width.toFixed(3))]
  }

  it('puts it exactly where its seconds fall', () => {
    expect(at(0, 8)).toEqual([0, 32])
    expect(at(8, 12)).toEqual([32, 16])
    expect(at(2, 9)).toEqual([8, 28])
  })

  it('keeps a block of no length findable without inflating a short one', () => {
    // The floor is a fraction of the window, like everything else on the axis.
    // Read as a percentage it stretched a six-second caption across half a
    // twenty-five-second timeline — which is what this is here to prevent.
    const nothing = blockPlacement(4, 4, view)!
    expect(nothing.width).toBeGreaterThan(0)
    expect(nothing.width).toBeLessThan(1)
    expect(at(0, 6)[1]).toBe(24)
  })

  it('clips a block that runs off the end of the window', () => {
    expect(at(20, 40)).toEqual([80, 20])
    expect(at(-5, 5)).toEqual([0, 20])
  })

  it('is nothing at all when the block is out of sight', () => {
    expect(blockPlacement(30, 40, view)).toBeNull()
    expect(blockPlacement(-20, -10, view)).toBeNull()
  })
})
