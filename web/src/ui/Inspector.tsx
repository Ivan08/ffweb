/**
 * The inspector: settings for whatever is selected on the timeline.
 *
 * One panel that follows the selection, rather than a permanent form for every
 * operation at once. Clicking a clip and clicking a logo ask different
 * questions, and only one of them is on screen at a time.
 */

import { formatDuration } from '../core/format'
import { clamp } from '../core/geometry'
import { clipDuration, contentEnd, fileOf, sourceLength, timelineDuration } from '../core/project'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Field, Icon, Segmented, Slider, Toggle } from './controls'
import { TimeInput } from './trim/TimeInput'

export function Inspector() {
  const { t } = useT()
  const focus = useStore((state) => state.focus)

  if (focus.kind === 'clip') return <ClipInspector uid={focus.uid} />
  if (focus.kind === 'overlay') return <OverlayInspector uid={focus.uid} />
  if (focus.kind === 'sound') return <SoundInspector uid={focus.uid} />
  if (focus.kind === 'audio') return <AudioInspector />

  return (
    <section className="panel mb-3 px-3 py-2.5">
      <h2 className="section-title mb-1">{t('inspector.title')}</h2>
      <p className="text-[12px] text-faint">{t('inspector.empty')}</p>
    </section>
  )
}

function Shell({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <section className="panel mb-3">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon name={icon} size={15} className="text-accent" />
        <h2 className="flex-1 text-[13px] font-semibold">{title}</h2>
      </div>
      <div className="grid gap-2.5 px-3 pb-3">{children}</div>
    </section>
  )
}

function ClipInspector({ uid }: { uid: string }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const patchClip = useStore((state) => state.patchClip)

  const clip = project.clips.find((candidate) => candidate.uid === uid)
  if (!clip) return null
  const file = fileOf(files, clip.fileId)
  const full = file?.info?.duration ?? 0

  return (
    <Shell title={file?.name ?? t('timeline.missing')} icon="Film">
      <div className="grid grid-cols-2 gap-2">
        <TimeInput
            label={t('clip.in')}
            value={clip.in}
            max={full}
            onCommit={(value) => patchClip(uid, { in: clamp(value, 0, clip.out - 0.05) })}
          />
        <TimeInput
            label={t('clip.out')}
            value={clip.out}
            max={full}
            onCommit={(value) => patchClip(uid, { out: clamp(value, clip.in + 0.05, full || value) })}
          />
      </div>

      <Slider
        label={t('clip.speed')}
        value={clip.speed}
        min={0.1}
        max={10}
        step={0.1}
        unit="×"
        onChange={(speed) => patchClip(uid, { speed })}
      />
      <Slider
        label={t('clip.loop')}
        value={clip.loop}
        min={1}
        max={10}
        step={1}
        unit="×"
        onChange={(loop) => patchClip(uid, { loop })}
      />
      <Toggle
        label={t('clip.reverse')}
        checked={clip.reverse}
        onChange={(reverse) => patchClip(uid, { reverse })}
      />
      <Toggle
        label={t('clip.boomerang')}
        checked={clip.boomerang}
        onChange={(boomerang) => patchClip(uid, { boomerang })}
      />

      <p className="text-[11px] text-faint">
        {t('clip.length', {
          source: formatDuration(sourceLength(clip), 1),
          result: formatDuration(clipDuration(clip), 1),
        })}
      </p>
    </Shell>
  )
}

function OverlayInspector({ uid }: { uid: string }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const patchOverlay = useStore((state) => state.patchOverlay)

  const overlay = project.overlays.find((candidate) => candidate.uid === uid)
  if (!overlay) return null
  const file = fileOf(files, overlay.fileId)
  const duration = timelineDuration(project)

  const caption = overlay.text !== undefined

  return (
    <Shell
      title={caption ? overlay.text || t('overlay.untitled') : (file?.name ?? t('timeline.missing'))}
      icon={caption ? 'Type' : 'Image'}
    >
      {caption && (
        <>
          <Field label={t('overlay.text')}>
            <input
              className="field"
              value={overlay.text ?? ''}
              placeholder={t('overlay.textPlaceholder')}
              onChange={(event) => patchOverlay(uid, { text: event.target.value })}
            />
          </Field>
          <Slider
            label={t('overlay.fontSize')}
            value={Math.round(overlay.fontSize * 100)}
            min={2}
            max={30}
            step={1}
            unit="%"
            onChange={(value) => patchOverlay(uid, { fontSize: value / 100 })}
          />
          <Field label={t('overlay.colour')}>
            <input
              type="color"
              className="field h-8 p-1"
              value={overlay.colour}
              onChange={(event) => patchOverlay(uid, { colour: event.target.value })}
            />
          </Field>
          <Toggle
            label={t('overlay.box')}
            checked={overlay.box}
            onChange={(box) => patchOverlay(uid, { box })}
          />
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <TimeInput
            label={t('overlay.from')}
            value={overlay.from}
            max={duration}
            onCommit={(from) => patchOverlay(uid, { from: clamp(from, 0, overlay.to) })}
          />
        <TimeInput
            label={t('overlay.to')}
            value={overlay.to}
            max={duration}
            onCommit={(to) => patchOverlay(uid, { to: clamp(to, overlay.from, duration) })}
          />
      </div>

      {!caption && (
        <Slider
          label={t('overlay.size')}
          value={Math.round(overlay.scale * 100)}
          min={5}
          max={100}
          step={1}
          unit="%"
          onChange={(value) => patchOverlay(uid, { scale: value / 100 })}
        />
      )}
      <Slider
        label={t('overlay.opacity')}
        value={Math.round(overlay.opacity * 100)}
        min={5}
        max={100}
        step={1}
        unit="%"
        onChange={(value) => patchOverlay(uid, { opacity: value / 100 })}
      />
      <Slider
        label={t('overlay.x')}
        value={Math.round(overlay.x * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        onChange={(value) => patchOverlay(uid, { x: value / 100 })}
      />
      <Slider
        label={t('overlay.y')}
        value={Math.round(overlay.y * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        onChange={(value) => patchOverlay(uid, { y: value / 100 })}
      />
    </Shell>
  )
}

function AudioInspector() {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const patchAudio = useStore((state) => state.patchAudio)
  const setTarget = useStore((state) => state.setTarget)
  const run = useStore((state) => state.run)

  const track = project.audio

  return (
    <Shell title={t('timeline.audio')} icon="Music">
      <Segmented
        value={track.source}
        options={[
          { value: 'clips' as const, label: t('audio.fromClips') },
          { value: 'none' as const, label: t('audio.none') },
        ]}
        onChange={(source) => patchAudio({ source })}
      />
      <p className="-mt-1 text-[11px] leading-snug text-faint">{t('audio.sourceHint')}</p>

      <Slider
        label={t('audio.gain')}
        value={track.gain}
        min={-30}
        max={30}
        step={1}
        unit="dB"
        onChange={(gain) => patchAudio({ gain })}
      />
      <Toggle
        label={t('audio.normalize')}
        checked={track.normalize}
        onChange={(normalize) => patchAudio({ normalize })}
      />

      {/* This is what "extract audio" was, in the one place where somebody
          looking for the soundtrack would actually look for it. */}
      <button
        type="button"
        className="btn !py-1.5"
        onClick={() => {
          // A shortcut past the export dialog, not a change of mind about it:
          // the target goes back to whatever it was, so saving the sound once
          // does not turn the project into an audio project.
          const previous = project.target
          setTarget('audio')
          void run().finally(() => setTarget(previous))
        }}
      >
        <Icon name="Download" size={13} />
        {t('audio.save')}
      </button>
    </Shell>
  )
}

function SoundInspector({ uid }: { uid: string }) {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const patchSound = useStore((state) => state.patchSound)
  const removeSound = useStore((state) => state.removeSound)

  const sound = project.sounds.find((candidate) => candidate.uid === uid)
  if (!sound) return null
  const file = fileOf(files, sound.fileId)
  const full = file?.info?.duration ?? 0
  const reach = contentEnd(project)

  return (
    <Shell title={file?.name ?? t('timeline.missing')} icon="Music">
      <TimeInput
        label={t('audio.at')}
        value={sound.at}
        max={reach}
        onCommit={(at) => patchSound(uid, { at: clamp(at, 0, reach) })}
      />

      <div className="grid grid-cols-2 gap-2">
        <TimeInput
          label={t('clip.in')}
          value={sound.in}
          max={full}
          onCommit={(value) => patchSound(uid, { in: clamp(value, 0, sound.out - 0.05) })}
        />
        <TimeInput
          label={t('clip.out')}
          value={sound.out}
          max={full}
          onCommit={(value) => patchSound(uid, { out: clamp(value, sound.in + 0.05, full || value) })}
        />
      </div>

      <Slider
        label={t('audio.gain')}
        value={sound.gain}
        min={-30}
        max={30}
        step={1}
        unit="dB"
        onChange={(gain) => patchSound(uid, { gain })}
      />

      <button type="button" className="btn !py-1.5" onClick={() => removeSound(uid)}>
        <Icon name="X" size={13} />
        {t('audio.remove')}
      </button>
    </Shell>
  )
}
