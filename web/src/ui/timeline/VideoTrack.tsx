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
import { fileOf, sourceLength } from '../../core/project'
import { blockPlacement, layout, MIN_SPAN } from '../../core/timeline'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Icon } from '../controls'
import { useDrag, type TimelineView } from './useTimelineView'

type Drag =
  | { kind: 'start' | 'end'; uid: string; blockStart: number }
  | { kind: 'move'; uid: string; from: number }
  | null

export function VideoTrack({ axis }: { axis: TimelineView }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const focus = useStore((state) => state.focus)
  const setFocus = useStore((state) => state.setFocus)
  const patchClip = useStore((state) => state.patchClip)
  const moveClipBy = useStore((state) => state.moveClipBy)
  const removeClip = useStore((state) => state.removeClip)
  const nativeAvailable = useStore((state) => state.capabilities?.native.available ?? false)

  const [drag, setDrag] = useState<Drag>(null)
  const placed = layout(project.clips)

  useDrag(
    drag
      ? (event) => {
          axis.followEdge(event.clientX)
          const at = axis.secondsAt(event.clientX)

          if (drag.kind === 'move') {
            // Reordering is a swap as the pointer crosses a neighbour, which
            // needs no ghost element and cannot leave the list inconsistent.
            const target = placed.findIndex((block) => at >= block.start && at <= block.end)
            const current = placed.findIndex((block) => block.uid === drag.uid)
            if (target >= 0 && current >= 0 && target !== current) {
              moveClipBy(drag.uid, target > current ? 1 : -1)
            }
            return
          }

          const clip = project.clips.find((candidate) => candidate.uid === drag.uid)
          if (!clip) return
          const file = fileOf(files, clip.fileId)
          const full = file?.info?.duration ?? 0
          const speed = clip.speed > 0 ? clip.speed : 1
          // The pointer is on the timeline; the trim is in the source, and the
          // two differ by where the block starts and how fast it plays.
          const inSource = clip.in + (at - drag.blockStart) * speed

          if (drag.kind === 'start') {
            patchClip(drag.uid, { in: clamp(inSource, 0, clip.out - MIN_SPAN) })
          } else {
            patchClip(drag.uid, { out: clamp(inSource, clip.in + MIN_SPAN, full || inSource) })
          }
        }
      : null,
    () => setDrag(null),
  )

  return (
    <div className="relative h-[52px] border-b border-line">
      {placed.map((block) => {
        const clip = block.clip
        const file = fileOf(files, clip.fileId)
        const place = blockPlacement(block.start, block.end, axis.view)
        if (!place) return null

        const active = focus.kind === 'clip' && focus.uid === clip.uid
        // Enough frames to read the block, and no more: each one is an ffmpeg
        // run, so a sliver of a clip gets one and a wide one gets ten.
        const frames = Math.round(clamp((place.width / 100) * 14, 1, 10))

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
              if (project.clips.length > 1) setDrag({ kind: 'move', uid: clip.uid, from: block.start })
            }}
          >
            <div className="absolute inset-0 flex bg-panel-2">
              {nativeAvailable &&
                file &&
                !file.blob &&
                Array.from({ length: frames }, (_, index) => (
                  <img
                    key={index}
                    // Frames come from the clip's own trimmed range, so trimming
                    // the head changes what the block shows.
                    src={api.thumbUrl(
                      file.path,
                      clip.in + (sourceLength(clip) * (index + 0.5)) / frames,
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
              <button
                type="button"
                className="absolute right-0.5 top-0.5 z-20 rounded bg-bg/80 p-0.5 text-faint hover:text-err"
                title={t('timeline.removeClip')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => removeClip(clip.uid)}
              >
                <Icon name="X" size={11} />
              </button>
            )}

            <Handle
              side="start"
              label={t('clip.trimStart')}
              onGrab={() => setDrag({ kind: 'start', uid: clip.uid, blockStart: block.start })}
            />
            <Handle
              side="end"
              label={t('clip.trimEnd')}
              onGrab={() => setDrag({ kind: 'end', uid: clip.uid, blockStart: block.start })}
            />
          </div>
        )
      })}
    </div>
  )
}

function Handle({
  side,
  label,
  onGrab,
}: {
  side: 'start' | 'end'
  label: string
  onGrab: () => void
}) {
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={0}
      className={clsx(
        'absolute inset-y-0 z-20 w-2 cursor-ew-resize bg-accent/0 hover:bg-accent/50',
        side === 'start' ? 'left-0' : 'right-0',
      )}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onGrab()
      }}
    />
  )
}
