/**
 * Arithmetic for a track of blocks.
 *
 * The interface for this is pixels and pointers, which makes it the part hardest
 * to check by looking. All of it is here as numbers instead.
 */

import { describe, expect, it } from 'vitest'

import {
  clipOf,
  clipStart,
  emptyProject,
  overlaps,
  timelineDuration,
  type Clip,
  type Project,
} from './project'
import {
  blockPlacement,
  clipAt,
  timelineAt,
  landmarks,
  visibleSource,
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

describe('agreeing with the project about where things are', () => {
  const asProject = (clips: Clip[]): Project => ({ ...emptyProject(), clips })

  it('lays the track out to exactly the length the project claims', () => {
    // Two walks of the same sum lived apart for a while, and adding overlaps
    // to one and not the other would put every block on screen somewhere the
    // command was not built for. This is what stops them drifting again.
    const shapes: Clip[][] = [
      [clip('a', { in: 0, out: 6 })],
      [clip('a', { in: 0, out: 6 }), clip('b', { in: 0, out: 4 })],
      [
        clip('a', { in: 0, out: 6 }),
        clip('b', { in: 0, out: 4, transition: { duration: 1.5, kind: 'fade' } }),
      ],
      [
        clip('a', { in: 0, out: 6, speed: 2 }),
        clip('b', { in: 0, out: 4, loop: 2, transition: { duration: 1, kind: 'wipeleft' } }),
        clip('c', { in: 0, out: 3, transition: { duration: 0.5, kind: 'fade' } }),
      ],
    ]

    for (const clips of shapes) {
      const placed = layout(clips)
      expect(placed[placed.length - 1].end).toBeCloseTo(timelineDuration(asProject(clips)), 6)
    }
  })

  it('starts each clip where the project says it starts', () => {
    const clips = [
      clip('a', { in: 0, out: 6 }),
      clip('b', { in: 0, out: 4, transition: { duration: 1.5, kind: 'fade' } }),
      clip('c', { in: 0, out: 4, transition: { duration: 1, kind: 'fade' } }),
    ]
    for (const block of layout(clips)) {
      expect(clipStart(asProject(clips), block.uid)).toBeCloseTo(block.start, 6)
    }
  })
})

describe('clips that dissolve into one another', () => {
  const asProject = (clips: Clip[]): Project => ({ ...emptyProject(), clips })

  it('shortens the result by the overlap', () => {
    const clips = [
      clip('a', { in: 0, out: 6 }),
      clip('b', { in: 0, out: 4, transition: { duration: 1.5, kind: 'fade' } }),
    ]
    expect(timelineDuration(asProject(clips))).toBeCloseTo(8.5, 6)
  })

  it('starts the arriving clip while the one before is still playing', () => {
    const clips = [
      clip('a', { in: 0, out: 6 }),
      clip('b', { in: 0, out: 4, transition: { duration: 1.5, kind: 'fade' } }),
    ]
    const [first, second] = layout(clips)
    expect(first.end).toBeCloseTo(6, 6)
    expect(second.start).toBeCloseTo(4.5, 6)
  })

  it('ignores a transition on the first clip, which follows nothing', () => {
    const clips = [clip('a', { in: 0, out: 6, transition: { duration: 2, kind: 'fade' } })]
    expect(timelineDuration(asProject(clips))).toBeCloseTo(6, 6)
    expect(layout(clips)[0].start).toBe(0)
  })

  it('never lets a transition eat more than either side has', () => {
    // Two seconds of clip cannot give three seconds of dissolve, and asking
    // would put the transition before the clip it comes out of.
    const clips = [
      clip('a', { in: 0, out: 2 }),
      clip('b', { in: 0, out: 2, transition: { duration: 3, kind: 'fade' } }),
    ]
    const placed = layout(clips)
    expect(placed[1].start).toBeGreaterThanOrEqual(0)
    expect(timelineDuration(asProject(clips))).toBeGreaterThan(0)
  })

  it('leaves nothing for the third clip when the second is used up', () => {
    // A run of dissolves cannot borrow the same seconds twice.
    const clips = [
      clip('a', { in: 0, out: 4 }),
      clip('b', { in: 0, out: 2, transition: { duration: 2, kind: 'fade' } }),
      clip('c', { in: 0, out: 4, transition: { duration: 2, kind: 'fade' } }),
    ]
    const gaps = overlaps(clips)
    expect(gaps[1]).toBeCloseTo(2, 6)
    expect(gaps[2]).toBe(0)
  })

  it('still knows which clip is playing at a moment inside an overlap', () => {
    // Both are on screen; the one leaving is the one the preview shows, so the
    // picture does not jump forward before the dissolve has begun.
    const clips = [
      clip('a', { in: 0, out: 6 }),
      clip('b', { in: 0, out: 4, transition: { duration: 1.5, kind: 'fade' } }),
    ]
    expect(clipAt(clips, 5)?.uid).toBe('a')
    expect(clipAt(clips, 7)?.uid).toBe('b')
  })
})

describe('which part of a clip is on screen', () => {
  const block = (clips: Clip[], uid: string) => layout(clips).find((b) => b.uid === uid)!

  it('is the whole clip when the whole clip is showing', () => {
    const clips = [clip('a', { in: 0, out: 10 })]
    expect(visibleSource(block(clips, 'a'), { start: 0, end: 10 })).toEqual({ start: 0, end: 10 })
  })

  it('narrows to the window when zoomed in', () => {
    // The bug this exists for: the strip of frames and the waveform were both
    // drawn from the whole clip while the block was clipped to the window, so
    // zooming in magnified the block and changed nothing inside it.
    const clips = [clip('a', { in: 0, out: 10 })]
    expect(visibleSource(block(clips, 'a'), { start: 2, end: 4 })).toEqual({ start: 2, end: 4 })
  })

  it('counts from the trim the clip already has, not from zero', () => {
    // A clip trimmed to start at second 5 shows second 6 of the file one
    // second in, not second 1.
    const clips = [clip('a', { in: 5, out: 15 })]
    expect(visibleSource(block(clips, 'a'), { start: 1, end: 3 })).toEqual({ start: 6, end: 8 })
  })

  it('accounts for speed', () => {
    // Two seconds of a doubled clip is four seconds of the file.
    const clips = [clip('a', { in: 0, out: 10, speed: 2 })]
    expect(visibleSource(block(clips, 'a'), { start: 0, end: 2 })).toEqual({ start: 0, end: 4 })
  })

  it('reads a reversed clip from the end, and still returns a range', () => {
    // The source runs backwards, so the window maps to a range that starts
    // later in the file than it ends — handed back the right way round,
    // because a caller wants something to read.
    const clips = [clip('a', { in: 0, out: 10, reverse: true })]
    expect(visibleSource(block(clips, 'a'), { start: 0, end: 2 })).toEqual({ start: 8, end: 10 })
  })

  it('follows a clip that starts partway along the timeline', () => {
    const clips = [clip('a', { in: 0, out: 6 }), clip('b', { in: 0, out: 6 })]
    expect(visibleSource(block(clips, 'b'), { start: 7, end: 9 })).toEqual({ start: 1, end: 3 })
  })

  it('is nothing when the block is off screen', () => {
    const clips = [clip('a', { in: 0, out: 4 })]
    expect(visibleSource(block(clips, 'a'), { start: 6, end: 8 })).toBeNull()
    expect(visibleSource(block(clips, 'a'), { start: 4, end: 8 })).toBeNull()
  })

  it('clips to the block, not just to the window', () => {
    // Zoomed out past the end of everything, a clip still only offers itself.
    const clips = [clip('a', { in: 0, out: 4 })]
    expect(visibleSource(block(clips, 'a'), { start: -5, end: 20 })).toEqual({ start: 0, end: 4 })
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

  it('is the exact inverse for a reversed clip too', () => {
    // The case that was wrong: a reversed clip was mapped as though it played
    // forwards, so the preview showed a frame from the far end of the source.
    const reversed = [clip('a', { in: 0, out: 10, reverse: true })]
    for (const at of [0, 2.5, 5, 9.5]) {
      const found = clipAt(reversed, at)!
      expect(timelineAt(reversed, 'a', found.sourceSeconds)).toBeCloseTo(at, 6)
    }
  })

  it('starts a reversed clip at the end of its source', () => {
    const reversed = [clip('a', { in: 2, out: 8, reverse: true })]
    // The first frame shown is the last one of the trimmed part, and the last
    // frame shown is the first.
    expect(clipAt(reversed, 0)!.sourceSeconds).toBeCloseTo(8, 6)
    expect(clipAt(reversed, 6)!.sourceSeconds).toBeCloseTo(2, 6)
    expect(clipAt(reversed, 3)!.sourceSeconds).toBeCloseTo(5, 6)
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
