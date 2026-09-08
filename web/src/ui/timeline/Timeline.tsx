/**
 * The timeline: what the result is made of, laid out in time.
 *
 * This is the centre of the application now. The older interface had a list of
 * twenty-eight operations and a separate stack of filters, and the two could
 * disagree about what would happen; here the tracks *are* the answer, and every
 * question about joining, sound and overlays is asked in the place where it can
 * be seen.
 *
 * All tracks share one axis, so the gutter of labels and the strips live in two
 * columns of one flex row and the strips share a single measured element.
 */

import { useEffect, useState } from 'react'

import { useT } from '../../i18n'
import { formatDuration } from '../../core/format'
import { contentEnd, timelineDuration } from '../../core/project'
import type { MediaFile } from '../../core/types'
import { tickMarks } from '../../core/timeline'
import { useStore } from '../../store'
import { Icon } from '../controls'
import { Overview } from '../trim/Overview'
import { audioRows, AudioTrack, ROW } from './AudioTrack'
import { LANE, OverlayTrack } from './OverlayTrack'
import { VideoTrack } from './VideoTrack'
import { useTimelineView, type TimelineView } from './useTimelineView'

/** Width of the label column, in pixels. */
const GUTTER = 84

export function Timeline() {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const playhead = useStore((state) => state.playhead)
  const setPlayhead = useStore((state) => state.setPlayhead)

  // The result is as long as the picture, but the axis has to reach whatever
  // was laid down past it — a soundtrack that outlasts the footage is on the
  // timeline, and a track that stopped at the end of the picture hid it.
  const duration = timelineDuration(project)
  const reach = Math.max(duration, contentEnd(project))
  const axis = useTimelineView(reach)

  if (project.clips.length === 0) return null

  if (duration <= 0) {
    // Without a duration there is no axis to lay anything out on. That happens
    // on a machine with no ffprobe, so it says which of the two is missing
    // rather than rendering an empty strip.
    return (
      <section className="border-t border-line px-3 py-3">
        <p className="text-[12px] text-faint">{t('timeline.noDuration')}</p>
      </section>
    )
  }

  return (
    <section className="border-t border-line px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="section-title">{t('timeline.title')}</h2>
        <span className="font-mono text-[11px] text-faint">
          {formatDuration(playhead, 1)} / {formatDuration(duration, 1)}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('trim.zoomOut')}
          onClick={() => axis.zoomAround(playhead, 1.5)}
        >
          <Icon name="ZoomOut" size={13} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('trim.zoomIn')}
          onClick={() => axis.zoomAround(playhead, 0.66)}
        >
          <Icon name="ZoomIn" size={13} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('trim.reset')}
          disabled={!axis.zoomed}
          onClick={() => axis.setView(0, reach)}
        >
          <Icon name="Maximize2" size={13} />
        </button>
      </div>

      <div className="flex select-none">
        <div className="shrink-0" style={{ width: GUTTER }}>
          <Label height={16} />
          <Label height={52}>{t('timeline.video')}</Label>
          <Label height={ROW * audioRows(project.sounds.length)}>{t('timeline.audio')}</Label>
          <Label height={LANE * Math.max(1, project.overlays.length)}>
            {t('timeline.overlays')}
          </Label>
        </div>

        <div ref={axis.axisRef} className="relative min-w-0 flex-1">
          <Ruler axis={axis} onSeek={setPlayhead} />
          <VideoTrack axis={axis} />
          <AudioTrack axis={axis} />
          <OverlayTrack axis={axis} />
          {reach > duration + 0.01 && <ResultEnd axis={axis} at={duration} />}
          <Playhead axis={axis} at={playhead} />
          <SeekLayer axis={axis} onSeek={setPlayhead} />
        </div>
      </div>

      <TimelineTools />

      {axis.zoomed && (
        <div style={{ marginLeft: GUTTER }}>
          <Overview
            duration={reach}
            view={axis.view}
            onChange={(start, end) => axis.setView(start, end)}
          />
        </div>
      )}
    </section>
  )
}

/**
 * How anything gets onto a track.
 *
 * Each button asks which file, rather than using whatever happens to be ticked
 * in the strip above. It used to take the selection, so pressing *Picture*
 * while the footage was ticked laid the footage over itself — the button did
 * something reasonable and something nobody asked for at the same time.
 */
function TimelineTools() {
  const { t } = useT()
  const files = useStore((state) => state.files)
  const playhead = useStore((state) => state.playhead)
  const addOverlay = useStore((state) => state.addOverlay)
  const addCaption = useStore((state) => state.addCaption)
  const addSound = useStore((state) => state.addSound)

  const withPicture = files.filter((file) => file.info?.has_video !== false)
  const withSound = files.filter((file) => file.info?.has_audio !== false)

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5" style={{ marginLeft: GUTTER }}>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-faint">{t('timeline.overlays')}</span>
        <FileMenu
          label={t('overlay.addPicture')}
          icon="Image"
          title={t('overlay.addHint')}
          files={withPicture}
          empty={t('overlay.needsPicture')}
          onPick={(id) => addOverlay(id)}
        />
        <button
          type="button"
          className="btn !py-1 !text-[11px]"
          title={t('overlay.addHint')}
          onClick={() => addCaption()}
        >
          <Icon name="Type" size={12} />
          {t('overlay.addText')}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-faint">{t('timeline.audio')}</span>
        <FileMenu
          label={t('audio.add')}
          icon="Music"
          // A sound lands where the playhead is, which is both the obvious
          // place and the one the user just chose by looking at it.
          title={t('audio.addHint')}
          files={withSound}
          empty={t('audio.needsSound')}
          onPick={(id) => addSound(id, playhead)}
        />
      </div>
    </div>
  )
}

/** A button that asks which of the open files to use. */
function FileMenu({
  label,
  icon,
  title,
  files,
  empty,
  onPick,
}: {
  label: string
  icon: string
  title: string
  files: MediaFile[]
  empty: string
  onPick: (fileId: string) => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    // A click anywhere else closes it, which is what every other menu does.
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <span className="relative">
      <button
        type="button"
        className="btn !py-1 !text-[11px]"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={icon} size={12} />
        {label}
        <Icon name="ChevronDown" size={11} className="text-faint" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1 min-w-[13rem] rounded-lg border border-line bg-panel p-1 shadow-xl"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {files.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-faint">{empty}</p>
          ) : (
            files.map((file) => (
              <button
                key={file.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-dim hover:bg-panel-2 hover:text-ink"
                onClick={() => {
                  onPick(file.id)
                  setOpen(false)
                }}
              >
                <Icon name={file.info?.has_video === false ? 'Music' : 'Video'} size={12} />
                <span className="truncate">{file.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </span>
  )
}

function Label({ children, height }: { children?: React.ReactNode; height: number }) {
  return (
    <div
      className="flex items-center pr-2 text-[10px] font-semibold uppercase tracking-wider text-faint"
      style={{ height }}
    >
      {children}
    </div>
  )
}

function Ruler({ axis, onSeek }: { axis: TimelineView; onSeek: (seconds: number) => void }) {
  const width = axis.axisRef.current?.getBoundingClientRect().width ?? 800
  const marks = tickMarks(axis.view, width)

  return (
    // Scrubbing has to work somewhere the blocks do not cover, and the ruler is
    // where anyone would try first. Clicking a block selects it instead, which
    // left nowhere to move the playhead on a full track.
    <div
      className="relative h-4 cursor-ew-resize border-b border-line"
      onPointerDown={(event) => onSeek(axis.secondsAt(event.clientX))}
    >
      {marks.map((mark) => (
        <span
          key={mark.at}
          className="pointer-events-none absolute bottom-0"
          style={{ left: axis.percent(mark.at) }}
        >
          {mark.major ? (
            <span className="absolute bottom-0 left-0 flex flex-col items-start">
              <span className="whitespace-nowrap pl-0.5 font-mono text-[9px] leading-none text-faint">
                {formatDuration(mark.at, 0)}
              </span>
              <span className="mt-0.5 block h-1.5 w-px bg-line-strong" />
            </span>
          ) : (
            <span className="block h-1 w-px bg-line" />
          )}
        </span>
      ))}
    </div>
  )
}

/**
 * Where the result stops.
 *
 * Anything past this line is on the timeline but will not be in the file: the
 * picture decides the length and the rest is cut. Saying so on the track is
 * cheaper than explaining it afterwards.
 */
function ResultEnd({ axis, at }: { axis: TimelineView; at: number }) {
  const { t } = useT()
  return (
    <span
      className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-warn/70"
      style={{ left: axis.percent(at) }}
      title={t('timeline.resultEnds')}
    >
      <span className="absolute left-1 top-4 whitespace-nowrap rounded bg-bg/80 px-1 text-[9px] text-warn">
        {t('timeline.resultEnds')}
      </span>
    </span>
  )
}

function Playhead({ axis, at }: { axis: TimelineView; at: number }) {
  const fraction = axis.fraction(at)
  if (fraction < -0.02 || fraction > 1.02) return null
  return (
    <span
      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent"
      style={{ left: axis.percent(at) }}
    >
      <span className="absolute -left-1 top-0 h-1.5 w-[9px] rounded-sm bg-accent" />
    </span>
  )
}

/**
 * Clicking anywhere on the tracks moves the playhead.
 *
 * It sits under the blocks rather than over them, so dragging a clip still
 * drags the clip; only the gaps and the ruler seek.
 */
function SeekLayer({ axis, onSeek }: { axis: TimelineView; onSeek: (seconds: number) => void }) {
  return (
    <div
      className="absolute inset-0 z-0"
      onPointerDown={(event) => onSeek(axis.secondsAt(event.clientX))}
    />
  )
}
