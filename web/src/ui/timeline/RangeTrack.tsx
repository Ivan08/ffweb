/**
 * What of the workspace reaches the result.
 *
 * The track below is the footage, laid out at its full length whatever anyone
 * means to keep of it. This is what is kept: one or more windows drawn over
 * the top, joined in the order they lie.
 *
 * Trimming used to be done to the clip itself, so the timeline showed the
 * result and everything cut away left it. The block then filled the axis
 * again with nowhere to drag back to, and a trim could be made shorter but
 * never longer. A window has room on both sides because what it was cut from
 * is still drawn underneath it.
 */

import { useRef, useState } from 'react'
import clsx from 'clsx'

import { formatDuration } from '../../core/format'
import { clamp } from '../../core/geometry'
import { exportWindows, timelineDuration } from '../../core/project'
import { blockPlacement, MIN_SPAN, moveSpan, resizeSpan } from '../../core/timeline'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Icon } from '../controls'
import { useDrag, type TimelineView } from './useTimelineView'

/** Height of the track, in pixels. Read by the timeline's label column. */
export const RANGE_ROW = 30

type Drag = { kind: 'start' | 'end' | 'move'; uid: string; grabbedAt: number } | null

export function RangeTrack({ axis }: { axis: TimelineView }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const focus = useStore((state) => state.focus)
  const setFocus = useStore((state) => state.setFocus)
  const addRange = useStore((state) => state.addRange)
  const patchRange = useStore((state) => state.patchRange)
  const removeRange = useStore((state) => state.removeRange)

  const [drag, setDrag] = useState<Drag>(null)
  const grab = (next: Drag) => {
    axis.hold()
    setDrag(next)
  }

  const whole = timelineDuration(project)
  const bounds = { start: 0, end: whole }

  useDrag(
    drag
      ? (event) => {
          axis.followEdge(event.clientX)
          const at = axis.secondsAt(event.clientX)
          const range = project.ranges.find((candidate) => candidate.uid === drag.uid)
          if (!range) return

          const span = { start: range.from, end: range.to }
          const moved =
            drag.kind === 'move'
              ? moveSpan(span, at - drag.grabbedAt, bounds)
              : resizeSpan(span, drag.kind, at, bounds)
          patchRange(drag.uid, { from: moved.start, to: moved.end })
          if (drag.kind === 'move') setDrag({ ...drag, grabbedAt: at })
        }
      : null,
    () => {
      setDrag(null)
      axis.release()
    },
  )

  // What is actually kept, which is not quite what was drawn: windows that
  // touch describe one stretch, and are shown as one.
  const kept = exportWindows(project)
  const marked = project.ranges.length > 0

  return (
    <div className="relative border-b border-line" style={{ height: RANGE_ROW }}>
      {/* No window at all already means the whole of it, so there is nothing
          to draw and nothing to press — only something to say. */}
      {!marked && whole > 0 && (
        <span
          className="pointer-events-none absolute inset-x-0 z-[2] flex items-center justify-center rounded-md border border-dashed border-line text-[10px] text-faint"
          style={{ top: 2, height: RANGE_ROW - 4 }}
        >
          {t('range.whole')}
        </span>
      )}

      {marked &&
        kept.map((window, index) => {
          const place = blockPlacement(window.from, window.to, axis.view)
          if (!place) return null
          return (
            <span
              key={`kept${index}`}
              className="pointer-events-none absolute z-[1] rounded bg-accent/10"
              style={{ top: 2, height: RANGE_ROW - 4, left: `${place.left}%`, width: `${place.width}%` }}
            />
          )
        })}

      {project.ranges.map((range) => {
        const place = blockPlacement(range.from, range.to, axis.view)
        if (!place) return null
        const active = focus.kind === 'range' && focus.uid === range.uid
        const order = kept.findIndex((window) => range.from >= window.from - 0.001 && range.to <= window.to + 0.001)

        return (
          <div
            key={range.uid}
            className={clsx(
              'absolute z-10 flex cursor-grab items-center gap-1.5 overflow-hidden rounded-md border bg-accent-soft px-2',
              active ? 'border-accent ring-1 ring-accent' : 'border-accent/50 hover:border-accent',
            )}
            style={{ top: 2, height: RANGE_ROW - 4, left: `${place.left}%`, width: `${place.width}%` }}
            onPointerDown={(event) => {
              event.stopPropagation()
              setFocus({ kind: 'range', uid: range.uid })
              grab({ kind: 'move', uid: range.uid, grabbedAt: axis.secondsAt(event.clientX) })
            }}
          >
            {/* The order it is joined in, so several windows read as a sequence
                rather than as a set. */}
            <span className="shrink-0 rounded bg-accent px-1 text-[9px] font-semibold text-white">
              {order + 1}
            </span>
            <span className="truncate font-mono text-[10px]">
              {formatDuration(range.to - range.from, 1)}
            </span>

            {active && (
              <button
                type="button"
                className="ml-auto shrink-0 rounded bg-bg/80 p-0.5 text-faint hover:text-err"
                title={t('range.remove')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => removeRange(range.uid)}
              >
                <Icon name="X" size={11} />
              </button>
            )}

            <Edge
              side="start"
              label={t('range.startHandle')}
              onGrab={(at) => grab({ kind: 'start', uid: range.uid, grabbedAt: at })}
              axis={axis}
            />
            <Edge
              side="end"
              label={t('range.endHandle')}
              onGrab={(at) => grab({ kind: 'end', uid: range.uid, grabbedAt: at })}
              axis={axis}
            />
          </div>
        )
      })}

      {/* Dragging bare track marks a window: the first one, and every one
          after it. Windows themselves take the pointer first, so a drag that
          starts on one moves it instead. */}
      {whole > 0 && <NewRange axis={axis} whole={whole} onDraw={addRange} />}
    </div>
  )
}

/**
 * Dragging across bare track marks another window.
 *
 * Underneath everything, so it only catches what no window already has.
 */
function NewRange({
  axis,
  whole,
  onDraw,
}: {
  axis: TimelineView
  whole: number
  onDraw: (from: number, to: number) => void
}) {
  // The two ends are kept in a ref as well as in state. State is what draws the
  // band being dragged; the ref is what decides whether there is a window at
  // the end of it, because that must not depend on a re-render having caught
  // up with the pointer before it was let go.
  const span = useRef<{ from: number; to: number } | null>(null)
  const [drawn, setDrawn] = useState<{ from: number; to: number } | null>(null)

  useDrag(
    drawn
      ? (event) => {
          axis.followEdge(event.clientX)
          const to = clamp(axis.secondsAt(event.clientX), 0, whole)
          if (span.current) span.current = { ...span.current, to }
          setDrawn(span.current)
        }
      : null,
    () => {
      const marked = span.current
      span.current = null
      setDrawn(null)
      axis.release()
      if (marked && Math.abs(marked.to - marked.from) > MIN_SPAN) onDraw(marked.from, marked.to)
    },
  )

  const from = drawn?.from ?? null
  const to = drawn?.to ?? null

  return (
    <>
      {/*
        Above the seek layer, which covers the whole axis at z-0 and comes
        after every track, and below the windows themselves at z-10. Left at
        z-0 this caught nothing at all: pressing bare track moved the playhead.
      */}
      <div
        className="absolute inset-0 z-[5]"
        onPointerDown={(event) => {
          event.stopPropagation()
          axis.hold()
          const at = clamp(axis.secondsAt(event.clientX), 0, whole)
          span.current = { from: at, to: at }
          setDrawn(span.current)
        }}
      />
      {from !== null && to !== null && Math.abs(to - from) > 0.001 && (
        <span
          className="pointer-events-none absolute z-20 rounded border border-accent bg-accent/25"
          style={{
            top: 2,
            height: RANGE_ROW - 4,
            left: `${blockPlacement(Math.min(from, to), Math.max(from, to), axis.view)?.left ?? 0}%`,
            width: `${blockPlacement(Math.min(from, to), Math.max(from, to), axis.view)?.width ?? 0}%`,
          }}
        />
      )}
    </>
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
      aria-label={label}
      aria-valuenow={0}
      tabIndex={0}
      className={clsx(
        'absolute inset-y-0 z-20 w-2 cursor-ew-resize hover:bg-accent/50',
        side === 'start' ? 'left-0' : 'right-0',
      )}
      onPointerDown={(event) => {
        event.stopPropagation()
        onGrab(axis.secondsAt(event.clientX))
      }}
    />
  )
}
