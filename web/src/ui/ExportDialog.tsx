/**
 * Export: one button, then the questions that go with it.
 *
 * These used to be two things side by side — a panel of output settings and a
 * Run button underneath — which read as though the settings were part of the
 * editing and Run was something else. They are one act. Pressing Export asks
 * what should come out and starts it, and until you press it the panel is not
 * taking up room in a column that is about the timeline.
 */

import { useEffect } from 'react'

import { containerFor, estimateSize } from '../core/build'
import { AUDIO_BITRATES, CONTAINERS, findContainer, PRESETS, VIDEO_ENCODERS } from '../core/containers'
import { formatBytes, formatDelta } from '../core/format'
import { num, type Params } from '../core/ops'
import { exportDuration, fileOf, type ExportTarget } from '../core/project'
import { useT } from '../i18n'
import { projectAvailability } from '../ops'
import { useStore } from '../store'
import { Field, Icon, Slider, Toggle } from './controls'

/** Which containers make sense for each target. */
const KIND_OF: Record<ExportTarget, 'video' | 'audio' | 'image'> = {
  video: 'video',
  gif: 'image',
  audio: 'audio',
  still: 'image',
}

const TARGETS: ExportTarget[] = ['video', 'gif', 'audio', 'still']

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, tOr } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const engine = useStore((state) => state.engine)
  const capabilities = useStore((state) => state.capabilities)
  const selection = useStore((state) => state.selection)
  const setTarget = useStore((state) => state.setTarget)
  const setContainer = useStore((state) => state.setContainer)
  const setQuality = useStore((state) => state.setQuality)
  const setStripMeta = useStore((state) => state.setStripMeta)
  const setOutputName = useStore((state) => state.setOutputName)
  const currentCommand = useStore((state) => state.currentCommand)
  const run = useStore((state) => state.run)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const native = capabilities?.native
  const status = native
    ? projectAvailability(project, files, engine, native)
    : { available: true, missing: [] }

  const first = project.clips[0]
  const file = first ? fileOf(files, first.fileId) : undefined
  const encoders = engine === 'wasm' ? null : native?.encoders
  const kind = KIND_OF[project.target]
  const container = findContainer(containerFor(project.target, project.container))
  const batch = project.clips.length === 1 && selection.length > 1 ? selection.length : 0

  const scaleItem = project.effects.find((item) => item.op === 'resizecompress' && item.enabled)
  const scale = scaleItem
    ? estimateScale(scaleItem.params, file?.info?.width ?? 0, file?.info?.height ?? 0)
    : 1
  // The estimate is built on x264's quality curve, which says nothing about
  // `-cq` and nothing at all about `-q:v`. A confidently wrong number is worse
  // than none, so a hardware encoder gets none.
  const estimate =
    project.target === 'video' && project.quality.encoder === 'auto'
      ? estimateSize(file?.info ?? undefined, {
          // What comes out, not what is laid out: only the marked
          // windows are encoded.
          duration: exportDuration(project),
          crf: project.quality.crf,
          scale,
          container: project.container,
        })
      : null

  const built = currentCommand()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('export.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="panel flex max-h-[min(85vh,44rem)] w-[min(92vw,32rem)] flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Icon name="Download" size={16} className="text-accent" />
          <h2 className="flex-1 text-[13px] font-semibold">{t('export.title')}</h2>
          <button type="button" className="btn btn-ghost btn-icon" title={t('export.cancel')} onClick={onClose}>
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="label mb-1.5">{t('export.what')}</p>
          <div className="mb-1 grid grid-cols-2 gap-1.5">
            {TARGETS.map((target) => (
              <button
                key={target}
                type="button"
                onClick={() => setTarget(target)}
                className={
                  project.target === target
                    ? 'rounded-lg border border-accent bg-accent px-3 py-2 text-left text-[13px] text-accent-fg'
                    : 'rounded-lg border border-line px-3 py-2 text-left text-[13px] text-dim hover:border-line-strong hover:text-ink'
                }
              >
                {t(`target.${target}`)}
              </button>
            ))}
          </div>
          <p className="mb-4 text-[11px] leading-snug text-faint">{t(`target.${project.target}.hint`)}</p>

          <div className="grid gap-2.5">
            {project.target !== 'gif' && (
              <Field label={t('output.container')}>
                <select
                  className="field"
                  value={project.container}
                  onChange={(event) => setContainer(event.target.value)}
                >
                  {CONTAINERS.filter((def) => def.kind === kind).map((def) => {
                    const supported =
                      !encoders || def.requires.every((encoder) => encoders.includes(encoder))
                    return (
                      <option key={def.ext} value={def.ext} disabled={!supported}>
                        {def.ext.toUpperCase()}
                        {supported ? '' : ` — ${def.requires.join(', ')}`}
                      </option>
                    )
                  })}
                </select>
              </Field>
            )}

            {project.target === 'video' && container && (
              <Field label={t('output.encoder')} hint={t('output.encoderHint')}>
                <select
                  className="field"
                  value={project.quality.encoder}
                  onChange={(event) => setQuality({ encoder: event.target.value })}
                >
                  <option value="auto">{t('output.encoderAuto')}</option>
                  {VIDEO_ENCODERS.filter((def) => container.codecs?.includes(def.codec)).map(
                    (def) => {
                      // Listed if ffmpeg was built with it, which is not the
                      // same as the machine having a driver — so an unavailable
                      // one is shown disabled rather than hidden, and the run
                      // that fails says why in the log.
                      const found = !encoders || encoders.includes(def.id)
                      return (
                        <option key={def.id} value={def.id} disabled={!found}>
                          {def.id}
                          {found ? '' : ` — ${t('output.encoderMissing')}`}
                        </option>
                      )
                    },
                  )}
                </select>
              </Field>
            )}

            {project.target === 'video' && (
              <>
                <Slider
                  label={t('output.quality')}
                  min={14}
                  max={40}
                  step={1}
                  value={project.quality.crf}
                  onChange={(crf) => setQuality({ crf })}
                />
                <p className="-mt-1 text-[11px] leading-snug text-faint">{t('output.qualityHint')}</p>

                {project.quality.encoder !== 'h264_videotoolbox' &&
                  project.quality.encoder !== 'hevc_videotoolbox' && (
                    <Field label={t('output.preset')}>
                      <select
                        className="field"
                        value={project.quality.preset}
                        onChange={(event) => setQuality({ preset: event.target.value })}
                      >
                        {PRESETS.map((preset) => (
                          <option key={preset} value={preset}>
                            {tOr(`o.preset.${preset}`, preset)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
              </>
            )}

            {(project.target === 'video' || project.target === 'audio') && (
              <Field label={t('output.audioBitrate')}>
                <select
                  className="field"
                  value={project.quality.audioBitrate}
                  onChange={(event) => setQuality({ audioBitrate: event.target.value })}
                >
                  {AUDIO_BITRATES.map((bitrate) => (
                    <option key={bitrate} value={bitrate}>
                      {bitrate}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label={t('export.name')} hint={t('export.nameHint')}>
              <input
                className="field"
                spellCheck={false}
                value={project.name ?? built?.outputName ?? ''}
                onChange={(event) => setOutputName(event.target.value || undefined)}
              />
            </Field>

            <Toggle label={t('export.stripMeta')} checked={project.stripMeta} onChange={setStripMeta} />

            {estimate !== null && file && (
              <div className="flex items-baseline justify-between rounded-md bg-panel-2 px-2.5 py-2">
                <span className="label">{t('output.estimate')}</span>
                <span className="font-mono text-[12px]">
                  ~{formatBytes(estimate)}
                  {file.size > 0 && (
                    <span className="ml-1.5 text-faint">{formatDelta(file.size, estimate)}</span>
                  )}
                </span>
              </div>
            )}

            {!status.available && (
              <p className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
                {t('op.unavailable', { what: status.missing.join(', ') })}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" onClick={onClose}>
            {t('export.cancel')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="btn btn-primary !py-2"
            disabled={!status.available}
            onClick={() => {
              void run()
              onClose()
            }}
          >
            <Icon name="Play" size={14} />
            {batch > 1 ? t('op.runBatch', { n: batch }) : t('export.start')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** How much of the original frame area survives the resize, for the estimate. */
function estimateScale(params: Params, width: number, height: number): number {
  if (!width || !height) return 1
  const mode = String(params.mode ?? 'height')
  if (mode === 'percent') return Math.pow(num(params, 'percent', 100) / 100, 2)
  if (mode === 'width') return Math.pow(num(params, 'width', width) / width, 2)
  if (mode === 'height') return Math.pow(num(params, 'height', height) / height, 2)
  return (num(params, 'width', width) * num(params, 'height', height)) / (width * height)
}
