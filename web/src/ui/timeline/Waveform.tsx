/**
 * The sound of a file, drawn inside the block that plays it.
 *
 * An audio track drawn as a plain rectangle says only that there is sound
 * somewhere in it. Laying music under a video meant guessing where the loud
 * parts were and running the export to find out.
 *
 * Peaks are fetched once per file and cover the whole of it, so zooming reads
 * a narrower slice of an array already in hand instead of asking again. The
 * exception is zooming a long file right in, where the whole-file measurement
 * is too coarse to be worth drawing — that asks for the range on its own, and
 * only once the view has stopped moving.
 */

import { useEffect, useRef, useState } from 'react'

import { api } from '../../api/client'
import { bestFor, columns, detailRange, wantsDetail } from '../../core/waveform'
import { useStore } from '../../store'
import type { MediaFile, Peaks } from '../../core/types'

/**
 * Peaks already measured, by file and range.
 *
 * At module scope because they outlive any one block: trimming a clip, moving
 * it or splitting it in two must not re-measure a file that has not changed.
 */
const measured = new Map<string, Peaks>()
const pending = new Map<string, Promise<Peaks | null>>()

function load(path: string, from?: number, to?: number): Promise<Peaks | null> {
  const key = from === undefined ? path : `${path}@${from}:${to}`
  const cached = measured.get(key)
  if (cached) return Promise.resolve(cached)

  const already = pending.get(key)
  if (already) return already

  const request = api
    .peaks(path, 2000, from, to)
    .then((peaks) => {
      measured.set(key, peaks)
      return peaks
    })
    // A file with no sound answers with an error, and that is an answer: the
    // block simply has no waveform. Retrying on every redraw would be a
    // request per frame for as long as it stayed on screen.
    .catch(() => null)
    .finally(() => pending.delete(key))

  pending.set(key, request)
  return request
}

export function Waveform({
  file,
  from,
  to,
  reversed,
}: {
  file: MediaFile
  /** Seconds into the file, not the timeline. */
  from: number
  to: number
  /** Drawn back to front, like the clip it belongs to. */
  reversed?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Two slots, not one. The closer look covers only the range it was asked
  // for, so it can be drawn from while the window stays inside it and has to
  // be set aside — not thrown away — as soon as the window leaves it.
  const [whole, setWhole] = useState<Peaks | null>(null)
  const [detail, setDetail] = useState<Peaks | null>(null)
  const theme = useStore((state) => state.theme)
  const nativeAvailable = useStore((state) => state.capabilities?.native.available ?? false)

  // A file held in the browser has no path for the server to read, and without
  // a system ffmpeg there is nothing to read it with.
  const readable = nativeAvailable && !file.blob && file.info?.has_audio !== false

  useEffect(() => {
    if (!readable) return
    let current = true
    // A closer look at the file before this one describes nothing here.
    setDetail(null)
    void load(file.path).then((result) => {
      if (current) setWhole(result)
    })
    return () => {
      current = false
    }
  }, [readable, file.path])

  // A closer look is only ever drawn from while it covers what is on screen.
  const peaks = bestFor(whole, detail, from, to)

  // Zoomed far into a long file, the whole-file measurement is a handful of
  // numbers stretched across the screen. Asking for the range on its own is
  // worth a request — but only once the view has settled, or a wheel gesture
  // would ask a dozen times on the way.
  useEffect(() => {
    if (!readable || !whole || !wantsDetail(peaks ?? whole, from, to)) return
    let current = true
    const range = detailRange(from, to, file.info?.duration ?? 0)
    const timer = window.setTimeout(() => {
      void load(file.path, range.from, range.to).then((result) => {
        if (current && result) setDetail(result)
      })
    }, 180)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [readable, whole, peaks, from, to, file.path, file.info?.duration])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return

    const draw = () => {
      const box = canvas.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) return

      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(box.width * ratio)
      canvas.height = Math.round(box.height * ratio)

      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, box.width, box.height)

      // The colour comes from the element's own computed style, so the
      // waveform follows the palette and the theme without a second copy of
      // either living in here.
      context.fillStyle = getComputedStyle(canvas).color

      // One column every two device pixels: finer than the eye reads at this
      // height, and coarse enough that a wide block is not thousands of rects.
      const step = 2
      const count = Math.max(1, Math.floor(box.width / step))
      const values = columns(peaks, from, to, count)
      const middle = box.height / 2

      values.forEach((value, index) => {
        // Always at least a hairline, so a quiet passage reads as quiet rather
        // than as a gap where the track stopped.
        const height = Math.max(1, value * (box.height - 2))
        const x = reversed ? box.width - (index + 1) * step : index * step
        context.fillRect(x, middle - height / 2, step - 0.5, height)
      })
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [peaks, from, to, reversed, theme])

  if (!readable) return null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full text-accent/45"
    />
  )
}
