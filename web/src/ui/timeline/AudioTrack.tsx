/**
 * The audio track: the footage's own sound, and whatever was laid over it.
 *
 * The soundtrack used to be scattered across the operation list: "extract
 * audio" sat among twenty-eight buttons, "replace audio" was a different one,
 * and the volume was a third in another group. Here the sound is a thing on the
 * timeline, and everything you can do to it is done to that thing — including
 * saving it on its own, which is what "extract" was.
 *
 * Added sounds get a row each, like overlays. There is no reason to be able to
 * lay down one and not two, and two at the same moment are exactly the two that
 * need telling apart. "Replace the soundtrack" is the footage's own row turned
 * off with one sound added, which is why neither needs a flag any more.
 */

import { useState } from 'react'
import clsx from 'clsx'

import { formatDuration } from '../../core/format'
import { clamp, type View } from '../../core/geometry'
import {
  contentEnd,
  fileOf,
  soundLength,
  timelineDuration,
  type Sound,
} from '../../core/project'
import { blockPlacement, layout, visibleSource } from '../../core/timeline'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Icon } from '../controls'
import { useDrag, type TimelineView } from './useTimelineView'
import { Waveform } from './Waveform'

/**
 * Height of one row on this track, in pixels.
 *
 * Read by the timeline's own label column, so a taller row is this constant
 * and nothing else. It grew to make room for a waveform: at twenty-six there
 * was no shape to see between the border and the text.
 */
export const ROW = 34

/** The footage's own sound takes a row, and so does each one laid on top. */
export function audioRows(sounds: number): number {
  return 1 + sounds
}

export function AudioTrack({ axis }: { axis: TimelineView }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const focus = useStore((state) => state.focus)
  const setFocus = useStore((state) => state.setFocus)
  const patchAudio = useStore((state) => state.patchAudio)
  const patchSound = useStore((state) => state.patchSound)

  const [dragging, setDragging] = useState<string | null>(null)
  const reach = contentEnd(project)

  useDrag(
    dragging
      ? (event) => {
          axis.followEdge(event.clientX)
          // A sound slides along the timeline; where it starts is the whole
          // point of putting it on a track rather than in a form.
          const at = clamp(axis.secondsAt(event.clientX), 0, Math.max(0, reach - 0.05))
          patchSound(dragging, { at })
        }
      : null,
    () => {
      setDragging(null)
      axis.release()
    },
  )

  const own = project.audio
  const level = own.gain !== 0 ? `${own.gain > 0 ? '+' : ''}${own.gain} dB` : ''

  return (
    <div className="relative border-b border-line" style={{ height: ROW * audioRows(project.sounds.length) }}>
      {own.source === 'clips' ? (
        <Row
          top={0}
          place={blockPlacement(0, timelineDuration(project), axis.view)}
          active={focus.kind === 'audio'}
          label={t('audio.fromClips')}
          detail={level}
          onGrab={() => setFocus({ kind: 'audio' })}
        >
          {/*
            One canvas per clip rather than one across the row: on a joined
            timeline each block is a different file, and stretching one file's
            waveform over the whole track would be a picture of the wrong sound.
          */}
          <ClipWaves axis={axis} />
        </Row>
      ) : (
        <button
          type="button"
          className="absolute inset-x-0 z-10 rounded-md border border-dashed border-line text-[10px] text-faint hover:border-accent/60 hover:text-dim"
          style={{ top: 2, height: ROW - 4 }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setFocus({ kind: 'audio' })
            patchAudio({ source: 'clips' })
          }}
        >
          {t('audio.muted')}
        </button>
      )}

      {project.sounds.map((sound, index) => {
        const file = fileOf(files, sound.fileId)
        const gain = sound.gain !== 0 ? `${sound.gain > 0 ? '+' : ''}${sound.gain} dB · ` : ''
        return (
          <Row
            key={sound.uid}
            top={(index + 1) * ROW}
            place={blockPlacement(sound.at, sound.at + soundLength(sound), axis.view)}
            active={focus.kind === 'sound' && focus.uid === sound.uid}
            label={file?.name ?? t('timeline.missing')}
            detail={`${gain}${formatDuration(soundLength(sound), 0)}`}
            draggable
            onGrab={() => {
              setFocus({ kind: 'sound', uid: sound.uid })
              // A sound can outlast the picture, so moving it changes how far
              // the axis reaches — hold it still for the gesture.
              axis.hold()
              setDragging(sound.uid)
            }}
          >
            {file && <Waveform file={file} {...soundShowing(sound, axis.view)} />}
          </Row>
        )
      })}
    </div>
  )
}

/**
 * The part of a laid sound that is on screen, in seconds of its own file.
 *
 * A sound sits at a moment on the timeline rather than in the run of clips, so
 * it does not go through `layout` — but it is drawn clipped to the window in
 * exactly the same way, and needs clipping to match.
 */
function soundShowing(sound: Sound, view: View): { from: number; to: number } {
  const start = Math.max(sound.at, view.start)
  const end = Math.min(sound.at + soundLength(sound), view.end)
  if (end <= start) return { from: sound.in, to: sound.in }
  return { from: sound.in + (start - sound.at), to: sound.in + (end - sound.at) }
}

/**
 * The footage's own sound, one waveform per clip on the video track.
 *
 * Placed inside the single row rather than as rows of its own, so the track
 * still draws one block per line and the timeline's measurements are unchanged.
 */
function ClipWaves({ axis }: { axis: TimelineView }) {
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)

  return (
    <>
      {layout(project.clips).map((block) => {
        const file = fileOf(files, block.clip.fileId)
        if (!file) return null
        const place = blockPlacement(block.start, block.end, axis.view)
        if (!place) return null
        // The part of the clip on screen, for the same reason the frame strip
        // needs it: the block is drawn clipped to the window, so drawing the
        // whole clip inside it makes zooming change nothing. No debounce here
        // — this reads an array already in hand rather than asking for one.
        const showing = visibleSource(block, axis.view)
        if (!showing) return null

        // Positioned against the row, which spans the whole timeline, so each
        // clip's sound sits under the picture it belongs to.
        const whole = blockPlacement(0, timelineDuration(project), axis.view)
        if (!whole || whole.width <= 0) return null
        const left = ((place.left - whole.left) / whole.width) * 100
        const width = (place.width / whole.width) * 100

        return (
          <div
            key={block.uid}
            className="pointer-events-none absolute inset-y-0"
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            <Waveform
              file={file}
              from={showing.start}
              to={showing.end}
              reversed={block.clip.reverse}
            />
          </div>
        )
      })}
    </>
  )
}

function Row({
  top,
  place,
  active,
  label,
  detail,
  draggable,
  onGrab,
  children,
}: {
  top: number
  place: { left: number; width: number } | null
  active: boolean
  label: string
  detail: string
  draggable?: boolean
  onGrab: () => void
  children?: React.ReactNode
}) {
  if (!place) return null
  return (
    <div
      className={clsx(
        'absolute z-10 flex items-center gap-1.5 overflow-hidden rounded-md border px-2',
        active ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:border-accent/60',
        draggable ? 'cursor-grab bg-accent-soft' : 'bg-panel-2',
      )}
      style={{ top: top + 2, height: ROW - 4, left: `${place.left}%`, width: `${place.width}%` }}
      onPointerDown={(event) => {
        event.stopPropagation()
        onGrab()
      }}
    >
      {children}
      <Icon name="Music" size={11} className="relative shrink-0 text-faint" />
      <span className="relative truncate text-[10px]">{label}</span>
      <span className="relative ml-auto shrink-0 font-mono text-[9px] text-faint">{detail}</span>
    </div>
  )
}
