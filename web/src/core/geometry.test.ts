/** The arithmetic behind dragging a crop, zooming a timeline, sizing a column. */

import { describe, expect, it } from 'vitest'

import {
  clamp,
  clampView,
  fractionOf,
  letterbox,
  MIN_CROP,
  MIN_VIEW,
  resizeRect,
  secondsAt,
  slideSelection,
  zoomAround,
  type Rect,
} from './geometry'

describe('placing a picture inside its box', () => {
  it('fills a box of the same shape exactly', () => {
    const stage = letterbox({ width: 640, height: 360 }, 1920, 1080)
    expect(stage).toEqual({ left: 0, top: 0, width: 640, height: 360 })
  })

  it('leaves bars at the sides when the box is too wide', () => {
    // This is the case that misplaced the crop rectangle: the box kept its
    // width while the picture shrank to fit the height.
    const stage = letterbox({ width: 1000, height: 360 }, 1920, 1080)
    expect(stage.width).toBe(640)
    expect(stage.height).toBe(360)
    expect(stage.left).toBe(180)
    expect(stage.top).toBe(0)
  })

  it('leaves bars above and below when the box is too tall', () => {
    const stage = letterbox({ width: 640, height: 600 }, 1920, 1080)
    expect(stage.height).toBe(360)
    expect(stage.top).toBe(120)
    expect(stage.left).toBe(0)
  })

  it('keeps the picture centred, whatever the shape', () => {
    for (const box of [{ width: 800, height: 200 }, { width: 200, height: 800 }]) {
      const stage = letterbox(box, 1280, 720)
      expect(stage.left * 2 + stage.width).toBeCloseTo(box.width, 6)
      expect(stage.top * 2 + stage.height).toBeCloseTo(box.height, 6)
    }
  })

  it('reports nothing before the box has been measured', () => {
    expect(letterbox({ width: 0, height: 0 }, 1920, 1080).width).toBe(0)
    expect(letterbox({ width: 100, height: 100 }, 0, 0).width).toBe(0)
  })
})

describe('dragging a crop rectangle', () => {
  const full = (): Rect => ({ x: 0, y: 0, w: 1920, h: 1080 })
  const inner = (): Rect => ({ x: 400, y: 200, w: 800, h: 500 })

  it('moves without changing size', () => {
    const moved = resizeRect(inner(), 'move', 100, -50, 1920, 1080)
    expect(moved).toEqual({ x: 500, y: 150, w: 800, h: 500 })
  })

  it('stops at the edge instead of being squashed against it', () => {
    const moved = resizeRect(inner(), 'move', -10_000, -10_000, 1920, 1080)
    expect(moved).toEqual({ x: 0, y: 0, w: 800, h: 500 })

    const other = resizeRect(inner(), 'move', 10_000, 10_000, 1920, 1080)
    expect(other).toEqual({ x: 1120, y: 580, w: 800, h: 500 })
  })

  it('moves the origin when a left or top edge is dragged', () => {
    // The two change together; treating them separately drifts the rectangle.
    const left = resizeRect(inner(), 'w', 100, 0, 1920, 1080)
    expect(left.x).toBe(500)
    expect(left.w).toBe(700)
    expect(left.x + left.w).toBe(1200)

    const top = resizeRect(inner(), 'n', 0, 50, 1920, 1080)
    expect(top.y).toBe(250)
    expect(top.h).toBe(450)
  })

  it('leaves the origin alone when a right or bottom edge is dragged', () => {
    const right = resizeRect(inner(), 'e', 200, 0, 1920, 1080)
    expect(right.x).toBe(400)
    expect(right.w).toBe(1000)

    const bottom = resizeRect(inner(), 's', 0, 100, 1920, 1080)
    expect(bottom.h).toBe(600)
  })

  it('moves both sides at once from a corner', () => {
    const corner = resizeRect(inner(), 'se', 100, 100, 1920, 1080)
    expect(corner.w).toBe(900)
    expect(corner.h).toBe(600)

    const opposite = resizeRect(inner(), 'nw', 100, 100, 1920, 1080)
    expect(opposite).toMatchObject({ x: 500, y: 300, w: 700, h: 400 })
  })

  it('will not shrink below a size that can still be grabbed', () => {
    const tiny = resizeRect(inner(), 'e', -10_000, 0, 1920, 1080)
    expect(tiny.w).toBe(MIN_CROP)

    const fromLeft = resizeRect(inner(), 'w', 10_000, 0, 1920, 1080)
    expect(fromLeft.w).toBe(MIN_CROP)
    expect(fromLeft.x).toBe(1176)
  })

  it('will not grow past the frame', () => {
    const wide = resizeRect(inner(), 'e', 10_000, 0, 1920, 1080)
    expect(wide.x + wide.w).toBe(1920)

    const tall = resizeRect(inner(), 's', 0, 10_000, 1920, 1080)
    expect(tall.y + tall.h).toBe(1080)

    const up = resizeRect(inner(), 'n', -10_000, -10_000, 1920, 1080)
    expect(up.y).toBe(0)
  })

  it('never leaves the frame, whatever the drag', () => {
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move'] as const
    for (const handle of handles) {
      for (const [dx, dy] of [[-5000, -5000], [5000, 5000], [-5000, 5000], [5000, -5000]]) {
        const next = resizeRect(full(), handle, dx, dy, 1920, 1080)
        expect(next.x, `${handle}`).toBeGreaterThanOrEqual(0)
        expect(next.y, `${handle}`).toBeGreaterThanOrEqual(0)
        expect(next.x + next.w, `${handle}`).toBeLessThanOrEqual(1920)
        expect(next.y + next.h, `${handle}`).toBeLessThanOrEqual(1080)
        expect(next.w, `${handle}`).toBeGreaterThanOrEqual(MIN_CROP)
        expect(next.h, `${handle}`).toBeGreaterThanOrEqual(MIN_CROP)
      }
    }
  })
})

describe('the visible part of a timeline', () => {
  const duration = 60

  it('keeps a window inside the file', () => {
    expect(clampView(10, 20, duration)).toEqual({ start: 10, end: 20 })
    expect(clampView(-10, 0, duration)).toEqual({ start: 0, end: 10 })
    expect(clampView(55, 65, duration)).toEqual({ start: 50, end: 60 })
  })

  it('keeps the length of the window when it runs off the end', () => {
    // Panning past the end must stop, not zoom in.
    const panned = clampView(120, 130, duration)
    expect(panned.end - panned.start).toBe(10)
    expect(panned.end).toBe(60)
  })

  it('never zooms in past the point where the two ends collide', () => {
    const tiny = clampView(10, 10.01, duration)
    expect(tiny.end - tiny.start).toBe(MIN_VIEW)
  })

  it('never zooms out past the whole file', () => {
    const whole = clampView(-100, 500, duration)
    expect(whole).toEqual({ start: 0, end: duration })
  })

  it('keeps the anchor under the cursor when zooming', () => {
    const view = { start: 0, end: 60 }
    const anchor = 45
    const zoomed = zoomAround(view, anchor, 0.5, duration)
    // The same moment must sit at the same fraction across the strip.
    expect(fractionOf(anchor, zoomed)).toBeCloseTo(fractionOf(anchor, view), 6)
    expect(zoomed.end - zoomed.start).toBeCloseTo(30, 6)
  })

  it('zooms out symmetrically about the middle', () => {
    const zoomed = zoomAround({ start: 20, end: 30 }, 25, 2, duration)
    expect(zoomed).toEqual({ start: 15, end: 35 })
  })

  it('stops zooming out at the ends of the file', () => {
    const zoomed = zoomAround({ start: 0, end: 10 }, 0, 4, duration)
    expect(zoomed.start).toBe(0)
    expect(zoomed.end).toBe(40)
  })

  it('converts between a moment and a position across the strip', () => {
    const view = { start: 10, end: 30 }
    expect(fractionOf(10, view)).toBe(0)
    expect(fractionOf(20, view)).toBe(0.5)
    expect(fractionOf(30, view)).toBe(1)
    expect(secondsAt(0.5, view)).toBe(20)
    // A pointer outside the strip still lands inside the window.
    expect(secondsAt(-2, view)).toBe(10)
    expect(secondsAt(9, view)).toBe(30)
  })

  it('reports a moment outside the window without clamping it', () => {
    // The trim bar uses this to park an off-screen boundary at the edge.
    expect(fractionOf(5, { start: 10, end: 30 })).toBeLessThan(0)
    expect(fractionOf(40, { start: 10, end: 30 })).toBeGreaterThan(1)
  })
})

describe('sliding a trim selection', () => {
  it('keeps its length exactly', () => {
    const slid = slideSelection({ start: 10, end: 25 }, 7, 60)
    expect(slid).toEqual({ start: 17, end: 32 })
    expect(slid.end - slid.start).toBe(15)
  })

  it('stops at both ends rather than shrinking', () => {
    const left = slideSelection({ start: 10, end: 25 }, -100, 60)
    expect(left).toEqual({ start: 0, end: 15 })

    const right = slideSelection({ start: 10, end: 25 }, 100, 60)
    expect(right).toEqual({ start: 45, end: 60 })
    expect(right.end - right.start).toBe(15)
  })

  it('cannot move a selection that already fills the file', () => {
    expect(slideSelection({ start: 0, end: 60 }, 20, 60)).toEqual({ start: 0, end: 60 })
  })
})

describe('clamping a column width', () => {
  it('holds a value between its bounds', () => {
    expect(clamp(400, 300, 640)).toBe(400)
    expect(clamp(100, 300, 640)).toBe(300)
    expect(clamp(9000, 300, 640)).toBe(640)
  })
})
