/**
 * The video track: the clips, in the order they play.
 *
 * More than one block on this track *is* the join. That is the whole answer to
 * "it wasn't obvious I had to tick the files at the top": joining is no longer
 * an operation with a hidden prerequisite, it is what a second block means.
 */

import { useState } from 'react'
import clsx from 'clsx'

import { api } from '../../api/client'
import { formatDuration } from '../../core/format'
import { clamp } from '../../core/geometry'
import {
  canSplit,
  fileOf,
  MIN_SOURCE_SPAN,
  overlaps,
  type Clip,
} from '../../core/project'
import {
  blockPlacement,
  layout,
  sourceAt,
  visibleSource,
  type Placed,
} from '../../core/timeline'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Icon } from '../controls'
import { useDrag, type TimelineView } from './useTimelineView'

/**
 * A block is moved, never trimmed.
 *
 * What reaches the result is marked on the track below rather than cut out of
 * the clip, so the footage stays on screen whatever is kept of it — and a
 * window can be adjusted in both directions instead of only inwards.
 */
type Drag = { kind: 'move'; uid: string; from: number } | null

export function VideoTrack({ axis }: { axis: TimelineView }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const focus = useStore((state) => state.focus)
  const setFocus = useStore((state) => state.setFocus)
  const moveClipBy = useStore((state) => state.moveClipBy)
  const removeClip = useStore((state) => state.removeClip)
  const splitClip = useStore((state) => state.splitClip)
  const playhead = useStore((state) => state.playhead)
  const nativeAvailable = useStore((state) => state.capabilities?.native.available ?? false)

  const [drag, setDrag] = useState<Drag>(null)
  // Trimming changes how long the timeline is, and the axis measures the
  // timeline. Held still for the gesture, so the edge stays under the pointer.
  const grab = (next: Drag) => {
    axis.hold()
    setDrag(next)
  }
  const placed = layout(project.clips)

  useDrag(
    drag
      ? (event) => {
          axis.followEdge(event.clientX)
          const at = axis.secondsAt(event.clientX)

          // Reordering is a swap as the pointer crosses a neighbour, which
          // needs no ghost element and cannot leave the list inconsistent.
          const target = placed.findIndex((block) => at >= block.start && at <= block.end)
          const current = placed.findIndex((block) => block.uid === drag.uid)
          if (target >= 0 && current >= 0 && target !== current) {
            moveClipBy(drag.uid, target > current ? 1 : -1)
          }
        }
      : null,
    () => {
      setDrag(null)
      axis.release()
    },
  )

  return (
    <div className="relative h-[52px] border-b border-line">
      {placed.map((block, index) => {
        const clip = block.clip
        const file = fileOf(files, clip.fileId)
        const place = blockPlacement(block.start, block.end, axis.view)
        if (!place) return null

        const active = focus.kind === 'clip' && focus.uid === clip.uid
        // Enough frames to read the block, and no more: each one is an ffmpeg
        // run, so a sliver of a clip gets one and a wide one gets ten.
        const frames = Math.round(clamp((place.width / 100) * 14, 1, 10))
        // What the strip shows is the part of the clip on screen, not the
        // whole of it: the block is drawn clipped to the window, so filling it
        // with the entire clip made zooming magnify the block and change
        // nothing inside it.
        //
        // Measured against the window once it has stopped moving. Every frame
        // is a process, and a wheel gesture passes through a dozen zoom levels
        // on the way to the one that was wanted.
        const showing = visibleSource(block, axis.settledView)

        return (
          <div
            key={clip.uid}
            className={clsx(
              'absolute inset-y-1 z-10 overflow-hidden rounded-md border transition-colors',
              active ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:border-accent/60',
            )}
            style={{
              left: `${place.left}%`,
              width: `${place.width}%`,
            }}
            onPointerDown={(event) => {
              event.stopPropagation()
              setFocus({ kind: 'clip', uid: clip.uid })
              if (project.clips.length > 1) grab({ kind: 'move', uid: clip.uid, from: block.start })
            }}
          >
            <div className="absolute inset-0 flex bg-panel-2">
              {nativeAvailable &&
                file &&
                !file.blob &&
                showing &&
                Array.from({ length: frames }, (_, index) => (
                  <img
                    key={index}
                    src={api.thumbUrl(
                      file.path,
                      showing.start + ((showing.end - showing.start) * (index + 0.5)) / frames,
                      160,
                    )}
                    alt=""
                    draggable={false}
                    className="h-full min-w-0 flex-1 object-cover opacity-70"
                  />
                ))}
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-bg/70 px-1.5 py-0.5">
              <span className="truncate text-[10px]">{file?.name ?? t('timeline.missing')}</span>
              <span className="ml-auto shrink-0 font-mono text-[9px] text-faint">
                {formatDuration(block.end - block.start, 1)}
              </span>
            </div>

            {active && (
              <div className="absolute right-0.5 top-0.5 z-20 flex gap-0.5">
                <button
                  type="button"
                  className="rounded bg-bg/80 p-0.5 text-faint enabled:hover:text-accent disabled:opacity-40"
                  title={splitTitle(clip, block, playhead, t)}
                  aria-label={t('timeline.splitClip')}
                  disabled={!splittable(clip, block, playhead)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => splitClip(clip.uid, playhead)}
                >
                  <Icon name="Scissors" size={11} />
                </button>
                <button
                  type="button"
                  className="rounded bg-bg/80 p-0.5 text-faint hover:text-err"
                  title={t('timeline.removeClip')}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => removeClip(clip.uid)}
                >
                  <Icon name="X" size={11} />
                </button>
              </div>
            )}

            {/*
              The overlap, drawn on the arriving clip: the seconds it and the
              one before are both on screen. A hatch rather than a solid, so
              the frames underneath still read.
            */}
            {overlapOf(project.clips, index) > 0 && (
              <div
                className="pointer-events-none absolute inset-y-0 left-0 border-r border-accent/70 bg-accent/25"
                style={{
                  width: `${(overlapOf(project.clips, index) / Math.max(0.001, block.end - block.start)) * 100}%`,
                }}
              />
            )}

          </div>
        )
      })}
    </div>
  )
}

/** How long this clip overlaps the one before it, in seconds. */
function overlapOf(clips: Clip[], index: number): number {
  return overlaps(clips)[index] ?? 0
}

/**
 * Whether the cut the scissors would make is one the model will accept.
 *
 * Asked here as well as in `splitAt` so the button can be visibly unavailable
 * rather than doing nothing when pressed.
 */
function splittable(clip: Clip, block: Placed, playhead: number): boolean {
  if (!canSplit(clip)) return false
  if (playhead <= block.start || playhead >= block.end) return false
  const at = sourceAt(clip, playhead - block.start)
  return at > clip.in + MIN_SOURCE_SPAN && at < clip.out - MIN_SOURCE_SPAN
}

/** Say why the scissors are unavailable, rather than leaving it a mystery. */
function splitTitle(
  clip: Clip,
  block: Placed,
  playhead: number,
  t: (key: string) => string,
): string {
  if (!canSplit(clip)) return t('timeline.splitWhole')
  if (playhead <= block.start || playhead >= block.end) return t('timeline.splitNeedsPlayhead')
  return t('timeline.splitClip')
}

