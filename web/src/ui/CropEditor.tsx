/**
 * Interactive crop rectangle drawn over the video.
 *
 * Typing four numbers is how the crop filter works and not how anyone thinks,
 * so the numbers come from a rectangle you drag. They stay in source pixels;
 * only the display is scaled.
 *
 * The backdrop is the real video element, not a still, so it plays: a crop is
 * judged against motion at least as often as against one frame. The area
 * outside the rectangle is dimmed with four panels around it rather than by
 * drawing the picture twice, which is what makes a moving backdrop possible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api/client'
import { extensionOf, formatDuration } from '../core/format'
import { letterbox, resizeRect, type Handle, type Rect } from '../core/geometry'
import type { MediaFile } from '../core/types'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'

/** Containers a browser will actually play. */
const PLAYABLE = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']


const HANDLES: Array<{ id: Handle; style: React.CSSProperties; cursor: string }> = [
  { id: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize' },
  { id: 'n', style: { left: '50%', top: 0 }, cursor: 'ns-resize' },
  { id: 'ne', style: { left: '100%', top: 0 }, cursor: 'nesw-resize' },
  { id: 'e', style: { left: '100%', top: '50%' }, cursor: 'ew-resize' },
  { id: 'se', style: { left: '100%', top: '100%' }, cursor: 'nwse-resize' },
  { id: 's', style: { left: '50%', top: '100%' }, cursor: 'ns-resize' },
  { id: 'sw', style: { left: 0, top: '100%' }, cursor: 'nesw-resize' },
  { id: 'w', style: { left: 0, top: '50%' }, cursor: 'ew-resize' },
]

export function CropEditor({
  file,
  atTime,
  videoRef,
  onTimeUpdate,
}: {
  file: MediaFile
  atTime: number
  videoRef: React.RefObject<HTMLVideoElement | null>
  onTimeUpdate: (seconds: number) => void
}) {
  const { t } = useT()
  const effects = useStore((state) => state.project.effects)
  const patchEffect = useStore((state) => state.patchEffect)
  const removeEffect = useStore((state) => state.removeEffect)

  // There is exactly one place a crop can live now. It used to be able to be
  // both the selected operation and a stack entry at once, with a precedence
  // rule that decided which rectangle the command actually used.
  const item = effects.find((candidate) => candidate.op === 'crop' && candidate.enabled)
  const source = item?.params ?? {}
  // The four numbers go in together. They only mean anything together — half
  // of one rectangle and half of another is not a rectangle — and writing them
  // one at a time cost four store updates and four steps of history for every
  // pointer move of a drag.
  const uid = item?.uid
  const write = useCallback(
    (rect: Rect) => {
      if (!uid) return
      patchEffect(uid, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
      })
    },
    [uid, patchEffect],
  )

  const sourceWidth = file.info?.width ?? 1920
  const sourceHeight = file.info?.height ?? 1080

  const rect: Rect = useMemo(
    () => ({
      x: Number(source.x) || 0,
      y: Number(source.y) || 0,
      w: Number(source.w) || sourceWidth,
      h: Number(source.h) || sourceHeight,
    }),
    [source.x, source.y, source.w, source.h, sourceWidth, sourceHeight],
  )

  const cropped =
    rect.x > 0 || rect.y > 0 || rect.w < sourceWidth - 1 || rect.h < sourceHeight - 1

  const playable = PLAYABLE.includes(extensionOf(file.name))
  const mediaUrl = useMemo(
    () => (file.blob ? URL.createObjectURL(file.blob) : api.fileUrl(file.path)),
    [file],
  )
  useEffect(() => {
    return () => {
      if (file.blob) URL.revokeObjectURL(mediaUrl)
    }
  }, [file.blob, mediaUrl])

  // Only needed when the browser cannot play the container; then the backdrop
  // is a still and follows the timeline instead.
  const [frameAt, setFrameAt] = useState(atTime)
  useEffect(() => {
    if (playable) return
    const rounded = Math.round(atTime * 4) / 4
    if (rounded === frameAt) return
    const timer = window.setTimeout(() => setFrameAt(rounded), 120)
    return () => window.clearTimeout(timer)
  }, [atTime, frameAt, playable])

  const frameUrl = useMemo(
    () => (file.blob || playable ? null : api.thumbUrl(file.path, Math.max(0, frameAt), 960)),
    [file, frameAt, playable],
  )

  const [playing, setPlaying] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Where the picture actually is inside the box.
  //
  // Giving the box the source aspect ratio is not enough: when the available
  // height is the tighter constraint the box stays wide, the video letterboxes
  // inside it, and the rectangle then sits over black bars instead of over the
  // frame — so the crop the user drew is not the crop they get. Measuring the
  // box and doing the letterbox arithmetic makes the overlay land on the
  // picture whatever the layout does.
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = boxRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setBox({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const stage = useMemo(
    () => letterbox(box, sourceWidth, sourceHeight),
    [box, sourceWidth, sourceHeight],
  )
  const [drag, setDrag] = useState<{
    handle: Handle
    startX: number
    startY: number
    rect: Rect
    stageWidth: number
  } | null>(null)

  useEffect(() => {
    if (!drag) return

    const onMove = (event: PointerEvent) => {
      if (!drag.stageWidth) return
      // Work in source pixels throughout, so the numbers ffmpeg receives are
      // exactly what the user drew regardless of how large the preview is.
      const scale = sourceWidth / drag.stageWidth
      const dx = (event.clientX - drag.startX) * scale
      const dy = (event.clientY - drag.startY) * scale
      write(resizeRect(drag.rect, drag.handle, dx, dy, sourceWidth, sourceHeight))
    }
    const onUp = () => setDrag(null)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, sourceWidth, sourceHeight, write])

  const begin = (handle: Handle) => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDrag({ handle, startX: event.clientX, startY: event.clientY, rect, stageWidth: stage.width })
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const reset = () => write({ x: 0, y: 0, w: sourceWidth, h: sourceHeight })

  const percent = (value: number, total: number) => `${(value / total) * 100}%`
  const left = percent(rect.x, sourceWidth)
  const top = percent(rect.y, sourceHeight)
  const width = percent(rect.w, sourceWidth)
  const height = percent(rect.h, sourceHeight)

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
      <div ref={boxRef} className="relative min-h-0 w-full flex-1 select-none">
        <div
          className="absolute"
          style={{ left: stage.left, top: stage.top, width: stage.width, height: stage.height }}
        >
        {playable ? (
          <video
            ref={videoRef}
            src={mediaUrl}
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
            onClick={togglePlay}
            className="h-full w-full object-contain"
          />
        ) : frameUrl ? (
          <img src={frameUrl} alt="" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="h-full w-full bg-panel-2" />
        )}

        {/* Four panels around the selection rather than a second copy of the
            picture: the backdrop can then be a playing video. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/60" style={{ height: top }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/60" style={{ top: `calc(${top} + ${height})` }} />
        <div className="pointer-events-none absolute left-0 bg-black/60" style={{ top, height, width: left }} />
        <div className="pointer-events-none absolute right-0 bg-black/60" style={{ top, height, left: `calc(${left} + ${width})` }} />

        <div
          className="absolute cursor-move border-2 border-accent"
          onPointerDown={begin('move')}
          style={{ left, top, width, height }}
        >
          {HANDLES.map((handle) => (
            <span
              key={handle.id}
              onPointerDown={begin(handle.id)}
              className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white bg-accent"
              style={{ ...handle.style, cursor: handle.cursor }}
            />
          ))}
        </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {playable && (
          <button type="button" className="btn !py-1" onClick={togglePlay} title={t('crop.play')}>
            <Icon name={playing ? 'Pause' : 'Play'} size={13} />
            {formatDuration(atTime, 1)}
          </button>
        )}

        <span className="font-mono text-[11px] text-faint">
          {Math.round(rect.w)}×{Math.round(rect.h)} @ {Math.round(rect.x)},{Math.round(rect.y)}
        </span>

        <button
          type="button"
          className="btn btn-ghost !py-1 !text-[11px]"
          disabled={!cropped}
          onClick={reset}
        >
          <Icon name="Maximize2" size={12} />
          {t('crop.reset')}
        </button>

        {/* Getting rid of the crop entirely, not just widening it back out. */}
        <button
          type="button"
          className="btn btn-ghost !py-1 !text-[11px]"
          onClick={() => {
            reset()
            if (item) removeEffect(item.uid)
          }}
        >
          <Icon name="X" size={12} />
          {t('crop.remove')}
        </button>
      </div>

      <p className="text-[11px] text-faint">{t('crop.hint')}</p>
    </div>
  )
}

