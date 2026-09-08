/**
 * What the overlays will look like, drawn over the preview — and where you
 * move and size them.
 *
 * Entirely in the browser: this is CSS on top of the `<video>`, not a frame
 * rendered by ffmpeg. Encoding a still just to find out whether a caption is
 * the right size would cost seconds per keystroke, and it is not needed — a
 * position given as a fraction of the frame is the same arithmetic at any size,
 * so the rule that becomes `overlay=x=(W-w)*X` in the command is what places
 * things here:
 *
 *     overlay=x=(W-w)*X:y=(H-h)*Y      a fraction of the space left over
 *     drawtext=fontsize=h*S            a fraction of the frame's height
 *
 * That shared arithmetic is also why they can be dragged here rather than only
 * through the sliders in the inspector: the numbers mean the same thing on both
 * sides, so moving one on the picture is moving it in the command.
 *
 * The rectangle is taken from the media element itself rather than worked out
 * from the stage, because the two are not the same: `max-width`/`max-height`
 * only ever shrink a video, so a small clip in a large window keeps its own
 * size and sits centred, with the stage extending well past it.
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import { api } from '../api/client'
import { clamp } from '../core/geometry'
import { fileOf, isStill, type Overlay } from '../core/project'
import { useT } from '../i18n'
import { useStore } from '../store'
import type { MediaFile } from '../core/types'
import { useDrag } from './usePointerDrag'

/** Smallest an overlay may be dragged down to, as a fraction of the frame. */
const MIN_SCALE = 0.03
const MIN_TEXT = 0.02

interface Picture {
  left: number
  top: number
  width: number
  height: number
}

type Drag = {
  kind: 'move' | 'size'
  uid: string
  pointerX: number
  pointerY: number
  /** Where the picture's top-left was, in client coordinates. */
  originX: number
  originY: number
  /** The overlay as it was when the drag started. */
  from: Pick<Overlay, 'x' | 'y' | 'scale' | 'fontSize'>
  /** The element's own box then, relative to the picture. */
  left: number
  top: number
  width: number
  height: number
} | null

/**
 * Resizing holds the top-left corner still.
 *
 * The position is a fraction of the space left over — `(W-w)*x` — so widening
 * an overlay also slides it left, and the corner being dragged moves at only
 * `(1-x)` of the pointer's speed: barely at all for anything placed near the
 * right edge. Pinning the far corner and solving `x` back out of the new width
 * is what lets the grip stay under the cursor wherever the overlay sits, and
 * makes dragging back the exact inverse of dragging out.
 */
function anchoredX(left: number, frame: number, width: number): number | null {
  const room = frame - width
  return room > 0.5 ? clamp(left / room, 0, 1) : null
}

export function OverlayPreview({ mediaRef }: { mediaRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useT()
  const overlays = useStore((state) => state.project.overlays)
  const playhead = useStore((state) => state.playhead)
  const focus = useStore((state) => state.focus)
  const files = useStore((state) => state.files)
  const setFocus = useStore((state) => state.setFocus)
  const patchOverlay = useStore((state) => state.patchOverlay)

  const layerRef = useRef<HTMLDivElement>(null)
  const [picture, setPicture] = useState<Picture>({ left: 0, top: 0, width: 0, height: 0 })
  const [drag, setDrag] = useState<Drag>(null)

  useEffect(() => {
    const media = mediaRef.current
    const layer = layerRef.current
    if (!media || !layer) return

    const measure = () => {
      const box = media.getBoundingClientRect()
      const origin = layer.getBoundingClientRect()
      setPicture({
        left: box.left - origin.left,
        top: box.top - origin.top,
        width: box.width,
        height: box.height,
      })
    }

    measure()
    // The media element resizes with the window and again when its metadata
    // arrives, and the layer moves when panels either side of it do.
    const observer = new ResizeObserver(measure)
    observer.observe(media)
    observer.observe(layer)
    return () => observer.disconnect()
  }, [mediaRef])

  useDrag(
    drag
      ? (event) => {
          const dx = event.clientX - drag.pointerX
          const dy = event.clientY - drag.pointerY

          if (drag.kind === 'move') {
            // `x` is a fraction of the space left over, so a pixel of travel is
            // worth more the less room there is — and with none, the position
            // cannot move at all, which is what the filter does too.
            const roomX = picture.width - drag.width
            const roomY = picture.height - drag.height
            patchOverlay(drag.uid, {
              x: roomX > 1 ? clamp(drag.from.x + dx / roomX, 0, 1) : drag.from.x,
              y: roomY > 1 ? clamp(drag.from.y + dy / roomY, 0, 1) : drag.from.y,
            })
            return
          }

          const overlay = overlays.find((candidate) => candidate.uid === drag.uid)
          if (!overlay) return

          // Solved from where the pointer *is*, not accumulated from where it
          // started, so dragging back undoes exactly what dragging out did.
          if (overlay.text !== undefined) {
            // A caption's height is line height and padding, not the font size,
            // so the two are related through what the element measured when the
            // drag began.
            const perFont = drag.height / Math.max(MIN_TEXT, drag.from.fontSize)
            const height = clamp(event.clientY - drag.originY - drag.top, 1, picture.height)
            const y = anchoredX(drag.top, picture.height, height)
            patchOverlay(drag.uid, {
              fontSize: clamp(height / Math.max(1, perFont), MIN_TEXT, 0.5),
              ...(y === null ? {} : { y }),
            })
          } else {
            const width = clamp(
              event.clientX - drag.originX - drag.left,
              picture.width * MIN_SCALE,
              picture.width,
            )
            const x = anchoredX(drag.left, picture.width, width)
            patchOverlay(drag.uid, {
              scale: clamp(width / Math.max(1, picture.width), MIN_SCALE, 1),
              ...(x === null ? {} : { x }),
            })
          }
        }
      : null,
    () => setDrag(null),
  )

  const showing = overlays.filter(
    (overlay) => playhead >= overlay.from - 0.001 && playhead <= overlay.to + 0.001,
  )

  return (
    <div
      ref={layerRef}
      role="group"
      aria-label={t('timeline.overlays')}
      className="pointer-events-none absolute inset-0"
    >
      <div
        className="absolute"
        style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}
      >
        {showing.map((overlay) => (
          <Drawn
            key={overlay.uid}
            overlay={overlay}
            height={picture.height}
            file={fileOf(files, overlay.fileId)}
            playhead={playhead}
            selected={focus.kind === 'overlay' && focus.uid === overlay.uid}
            dragging={drag?.uid === overlay.uid}
            onGrab={(kind, event, element) => {
              setFocus({ kind: 'overlay', uid: overlay.uid })
              const box = element.getBoundingClientRect()
              const frame = layerRef.current?.getBoundingClientRect()
              setDrag({
                kind,
                uid: overlay.uid,
                pointerX: event.clientX,
                pointerY: event.clientY,
                originX: (frame?.left ?? 0) + picture.left,
                originY: (frame?.top ?? 0) + picture.top,
                left: box.left - (frame?.left ?? 0) - picture.left,
                top: box.top - (frame?.top ?? 0) - picture.top,
                from: {
                  x: overlay.x,
                  y: overlay.y,
                  scale: overlay.scale,
                  fontSize: overlay.fontSize,
                },
                width: box.width,
                height: box.height,
              })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function Drawn({
  overlay,
  height,
  file,
  playhead,
  selected,
  dragging,
  onGrab,
}: {
  overlay: Overlay
  height: number
  file: MediaFile | undefined
  playhead: number
  selected: boolean
  dragging: boolean
  onGrab: (kind: 'move' | 'size', event: React.PointerEvent, element: HTMLElement) => void
}) {
  const { t } = useT()
  const ref = useRef<HTMLDivElement>(null)

  // `left: X%` with `translateX(-X%)` puts the element's own X fraction on the
  // container's X fraction, which is `(W - w) * X` — the overlay filter's rule,
  // arrived at without knowing either width.
  const place = {
    left: `${overlay.x * 100}%`,
    top: `${overlay.y * 100}%`,
    transform: `translate(${-overlay.x * 100}%, ${-overlay.y * 100}%)`,
  } as const

  // Something is always drawn around it. A clip used to render as an `<img>`
  // pointing at an mp4, which shows nothing at all — not even where the thing
  // is or how big, which is most of what you want while placing it.
  // `touch-none` stops a touch drag from turning into a page scroll, which the
  // browser announces by cancelling the gesture halfway through.
  const frame = clsx(
    'pointer-events-auto absolute cursor-move touch-none outline outline-1 outline-offset-1',
    selected || dragging
      ? 'outline-accent'
      : 'outline-dashed outline-white/40 hover:outline-white/80',
  )

  const grab = (kind: 'move' | 'size') => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Keep the pointer stream on this element even when it leaves, so a release
    // outside the window is still delivered as a release.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (ref.current) onGrab(kind, event, ref.current)
  }

  const handle = (
    <span
      role="slider"
      tabIndex={0}
      aria-label={t('overlay.resize')}
      aria-valuenow={Math.round(
        (overlay.text === undefined ? overlay.scale : overlay.fontSize) * 100,
      )}
      className="pointer-events-auto absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize touch-none rounded-sm border border-bg bg-accent"
      onPointerDown={grab('size')}
    />
  )

  if (overlay.text !== undefined) {
    return (
      <div
        ref={ref}
        className={frame}
        style={{ ...place, opacity: overlay.opacity }}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={grab('move')}
      >
        <span
          className="block whitespace-pre leading-tight"
          style={{
            fontSize: Math.max(1, overlay.fontSize * height),
            color: overlay.colour,
            fontFamily: 'system-ui, sans-serif',
            // The plate's padding follows the frame's height, as `boxborderw` does.
            padding: overlay.box
              ? `${Math.max(1, height * 0.012)}px ${Math.max(2, height * 0.02)}px`
              : 0,
            background: overlay.box ? 'rgba(0,0,0,0.45)' : 'transparent',
          }}
        >
          {overlay.text}
        </span>
        {handle}
      </div>
    )
  }

  if (!file) return null

  // A still is itself; a clip is the frame it will be showing by then, counted
  // from where it appears, because that is when it starts playing.
  const source = isStill(file)
    ? api.fileUrl(file.path)
    : api.thumbUrl(file.path, Math.max(0, playhead - overlay.from), 320)

  // The box keeps the file's shape, so there is something to see and to grab
  // even before the frame arrives.
  const shape = file.info?.width && file.info?.height ? file.info.width / file.info.height : 16 / 9

  return (
    <div
      ref={ref}
      className={frame}
      style={{
        ...place,
        width: `${overlay.scale * 100}%`,
        aspectRatio: shape,
        opacity: overlay.opacity,
      }}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={grab('move')}
    >
      <img
        src={source}
        alt=""
        draggable={false}
        className="h-full w-full object-cover"
        onError={(event) => {
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
      {handle}
    </div>
  )
}
