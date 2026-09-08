/**
 * The overlay track: pictures and clips drawn on top, for part of the time.
 *
 * This track is the reason the model changed at all. "Put this logo on from the
 * third second to the seventh" could not be said in the old one — an overlay
 * was an operation that covered the entire clip, and ffmpeg's `enable=` was
 * never used anywhere in the codebase. Here the block on this track *is* the
 * window, and dragging its edges is how you say when.
 *
 * Each overlay gets a row of its own. Sharing one meant that two things on
 * screen at the same moment were also on top of each other here, which is
 * exactly when you most need to tell them apart.
 */

import { useState } from 'react'
import clsx from 'clsx'

import { formatDuration } from '../../core/format'
import { contentEnd, fileOf } from '../../core/project'
import { blockPlacement, moveSpan, resizeSpan } from '../../core/timeline'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Icon } from '../controls'
import { useDrag, type TimelineView } from './useTimelineView'

/** Height of one overlay's row, in pixels. */
export const LANE = 26

type Drag = { kind: 'start' | 'end' | 'move'; uid: string; grabbedAt: number } | null

export function OverlayTrack({ axis }: { axis: TimelineView }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const focus = useStore((state) => state.focus)
  const setFocus = useStore((state) => state.setFocus)
  const patchOverlay = useStore((state) => state.patchOverlay)
  const removeOverlay = useStore((state) => state.removeOverlay)

  const [drag, setDrag] = useState<Drag>(null)
  const bounds = { start: 0, end: contentEnd(project) }

  useDrag(
    drag
      ? (event) => {
          axis.followEdge(event.clientX)
          const overlay = project.overlays.find((candidate) => candidate.uid === drag.uid)
          if (!overlay) return
          const at = axis.secondsAt(event.clientX)
          const span = { start: overlay.from, end: overlay.to }

          const next =
            drag.kind === 'move'
              ? moveSpan(span, at - drag.grabbedAt, bounds)
              : resizeSpan(span, drag.kind, at, bounds)

          patchOverlay(drag.uid, { from: next.start, to: next.end })
          if (drag.kind === 'move') setDrag({ ...drag, grabbedAt: at })
        }
      : null,
    () => setDrag(null),
  )

  if (project.overlays.length === 0) {
    return (
      <div className="relative border-b border-line" style={{ height: LANE }}>
        <p className="absolute inset-y-0 left-1 flex items-center text-[10px] text-faint">
          {t('overlay.empty')}
        </p>
      </div>
    )
  }

  return (
    <div
      className="relative border-b border-line"
      style={{ height: LANE * project.overlays.length }}
    >
      {project.overlays.map((overlay, lane) => {
        const file = fileOf(files, overlay.fileId)
        const place = blockPlacement(overlay.from, overlay.to, axis.view)
        if (!place) return null
        const active = focus.kind === 'overlay' && focus.uid === overlay.uid
        const caption = overlay.text !== undefined

        return (
          <div
            key={overlay.uid}
            className={clsx(
              'absolute z-10 flex items-center gap-1 overflow-hidden rounded-md border px-1.5',
              active ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:border-accent/60',
              'cursor-grab bg-panel-2',
            )}
            style={{
              top: lane * LANE + 2,
              height: LANE - 4,
              left: `${place.left}%`,
              width: `${place.width}%`,
            }}
            onPointerDown={(event) => {
              event.stopPropagation()
              setFocus({ kind: 'overlay', uid: overlay.uid })
              setDrag({ kind: 'move', uid: overlay.uid, grabbedAt: axis.secondsAt(event.clientX) })
            }}
          >
            <Icon name={caption ? 'Type' : 'Image'} size={10} className="shrink-0 text-faint" />
            <span className="truncate text-[10px]">
              {caption ? overlay.text || t('overlay.untitled') : (file?.name ?? t('timeline.missing'))}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[9px] text-faint">
              {formatDuration(overlay.from, 0)}–{formatDuration(overlay.to, 0)}
            </span>

            {active && (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-faint hover:text-err"
                title={t('overlay.remove')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => removeOverlay(overlay.uid)}
              >
                <Icon name="X" size={10} />
              </button>
            )}

            <Edge
              side="start"
              label={t('overlay.startHandle')}
              onGrab={(at) => setDrag({ kind: 'start', uid: overlay.uid, grabbedAt: at })}
              axis={axis}
            />
            <Edge
              side="end"
              label={t('overlay.endHandle')}
              onGrab={(at) => setDrag({ kind: 'end', uid: overlay.uid, grabbedAt: at })}
              axis={axis}
            />
          </div>
        )
      })}
    </div>
  )
}

function Edge({
  side,
  label,
  onGrab,
  axis,
}: {
  side: 'start' | 'end'
  label: string
  onGrab: (at: number) => void
  axis: TimelineView
}) {
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={0}
      className={clsx(
        'absolute inset-y-0 z-20 w-2 cursor-ew-resize hover:bg-accent/50',
        side === 'start' ? 'left-0' : 'right-0',
      )}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onGrab(axis.secondsAt(event.clientX))
      }}
    />
  )
}
