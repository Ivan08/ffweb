/** Reading a slice of a file's loudness into the columns of a drawn track. */

import { describe, expect, it } from 'vitest'

import { bestFor, columns, covers, detailRange, wantsDetail } from './waveform'
import type { Peaks } from './types'

/** Peaks covering a whole file, one value per second unless told otherwise. */
const measured = (values: number[], duration = values.length, from = 0): Peaks => ({
  duration,
  from,
  peaks: values,
})

describe('reading peaks into columns', () => {
  it('gives back exactly the number of columns asked for', () => {
    expect(columns(measured([0.5, 0.5, 0.5, 0.5]), 0, 4, 7)).toHaveLength(7)
    expect(columns(measured([0.5]), 0, 1, 1)).toHaveLength(1)
    expect(columns(measured([]), 0, 1, 3)).toEqual([0, 0, 0])
  })

  it('shows the part of the file the range covers, not the whole of it', () => {
    // A trimmed clip draws the sound it actually uses. Drawing the whole file
    // across a trimmed block is the mistake that would look almost right.
    const peaks = measured([0, 0, 1, 0])
    expect(columns(peaks, 2, 3, 1)[0]).toBe(1)
    expect(columns(peaks, 0, 2, 1)[0]).toBe(0)
  })

  it('keeps the loudest moment in a column rather than the last one', () => {
    // The peak sits at the start of its column and silence follows it, so a
    // reading that simply kept the last value would report nothing.
    expect(columns(measured([1, 0, 0, 0, 0, 0, 0, 0]), 0, 8, 2)).toEqual([1, 0])

    // And at the end of the second column, for the same reason the other way.
    expect(columns(measured([0, 0, 0, 0, 0, 0, 0, 1]), 0, 8, 2)).toEqual([0, 1])
  })

  it('still shows a slice too narrow to hold one measurement', () => {
    // Zoomed right in, a column can be a fraction of a measured slice. It has
    // to show the slice it sits inside, not a gap.
    const peaks = measured([0.7, 0.7])
    expect(columns(peaks, 0.1, 0.2, 1)).toEqual([0.7])
  })

  it('reads silence outside what was measured', () => {
    // Peaks measured over the first two seconds say nothing about the fifth,
    // and a waveform that carries on drawing is claiming otherwise.
    expect(columns(measured([1, 1], 2), 4, 6, 2)).toEqual([0, 0])

    // The same before the start, which is the direction that would otherwise
    // wrap round and draw the beginning of a detail range at time zero.
    expect(columns(measured([1, 1], 2, 10), 0, 2, 2)).toEqual([0, 0])
  })

  it('lines up with peaks that begin partway into the file', () => {
    // A detail request covers a range, and its own `from` is where it starts.
    const peaks = measured([0, 1], 2, 10)
    expect(columns(peaks, 11, 12, 1)).toEqual([1])
    expect(columns(peaks, 10, 11, 1)).toEqual([0])
  })

  it('says nothing at all about a range of no length', () => {
    expect(columns(measured([1, 1]), 3, 3, 2)).toEqual([0, 0])
  })
})

describe('deciding when the whole-file peaks are too coarse', () => {
  it('is content when the window holds plenty of measurements', () => {
    // Two thousand over ten minutes, looked at whole.
    expect(wantsDetail(measured(new Array(2000).fill(0.5), 600), 0, 600)).toBe(false)
  })

  it('asks for more when the window is a sliver of a long file', () => {
    // The same file, ten seconds of it: three measurements across the screen.
    expect(wantsDetail(measured(new Array(2000).fill(0.5), 7200), 0, 10)).toBe(true)
  })

  it('asks for nothing when there is nothing measured', () => {
    expect(wantsDetail(measured([], 0), 0, 10)).toBe(false)
  })
})

describe('choosing between the whole file and a closer look at part of it', () => {
  const whole = measured(new Array(100).fill(0.4), 600)
  const detail = measured(new Array(100).fill(0.9), 16, 8)

  it('reads the closer look while the window is inside it', () => {
    expect(bestFor(whole, detail, 10, 20)).toBe(detail)
  })

  it('goes back to the whole file once the window leaves it', () => {
    // The bug this exists for: zooming in fetched a closer look and put it
    // where the whole-file measurement had been, so zooming back out drew a
    // wide view as a sliver of sound with silence on either side.
    expect(bestFor(whole, detail, 0, 600)).toBe(whole)
    expect(bestFor(whole, detail, 0, 12)).toBe(whole)
    expect(bestFor(whole, detail, 20, 40)).toBe(whole)
  })

  it('takes the whole file when there is no closer look yet', () => {
    expect(bestFor(whole, null, 10, 20)).toBe(whole)
  })

  it('says nothing at all before anything has been measured', () => {
    expect(bestFor(null, null, 0, 10)).toBeNull()
  })

  it('accepts a window that reaches exactly to the edges', () => {
    // Both ends have been through rounding, so an exact fit must not read as
    // a miss and throw away the detail on every other frame.
    expect(covers(detail, 8, 24)).toBe(true)
    expect(covers(detail, 7.9, 24)).toBe(false)
    expect(covers(detail, 8, 24.1)).toBe(false)
  })
})

describe('snapping a detail request to stable edges', () => {
  it('covers the window asked for', () => {
    const range = detailRange(9, 17, 600)
    expect(range.from).toBeLessThanOrEqual(9)
    expect(range.to).toBeGreaterThanOrEqual(17)
  })

  it('gives the same answer for two nearly identical windows', () => {
    // Panning by a pixel must not decode the file again.
    expect(detailRange(9.0, 17.0, 600)).toEqual(detailRange(9.1, 17.1, 600))
  })

  it('stays inside the file', () => {
    const range = detailRange(590, 610, 600)
    expect(range.from).toBeGreaterThanOrEqual(0)
    expect(range.to).toBeLessThanOrEqual(600)
  })

  it('never asks for a range of no length', () => {
    const range = detailRange(5, 5, 600)
    expect(range.to).toBeGreaterThan(range.from)
  })
})
