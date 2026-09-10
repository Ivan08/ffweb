/** The centre column: preview, trimming, crop rectangle, and the filter stack. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import { api } from '../api/client'
import { extensionOf, formatBytes } from '../core/format'
import type { MediaFile } from '../core/types'
import { useT } from '../i18n'
import { clipAt, timelineAt } from '../core/timeline'
import { fileOf } from '../core/project'
import { useStore } from '../store'
import { CropEditor } from './CropEditor'
import { OverlayPreview } from './OverlayPreview'
import { Timeline } from './timeline/Timeline'
import { Empty, Icon } from './controls'
import { downloadJob } from '../core/download'

const PLAYABLE_VIDEO = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']
const PLAYABLE_AUDIO = ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac']
const IMAGES = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp']

export function PreviewPanel() {
  const { t } = useT()
  const files = useStore((state) => state.files)
  const project = useStore((state) => state.project)
  const jobs = useStore((state) => state.jobs)
  const activeJobId = useStore((state) => state.activeJobId)
  const playhead = useStore((state) => state.playhead)
  const setPlayhead = useStore((state) => state.setPlayhead)
  const autoDownload = useStore((state) => state.autoDownload)
  const setAutoDownload = useStore((state) => state.setAutoDownload)

  // The preview shows the footage the playhead is over, which on a joined
  // timeline is not necessarily the first clip.
  const at = clipAt(project.clips, playhead)
  const file = fileOf(files, at?.clip.fileId ?? project.clips[0]?.fileId) ?? files[0]
  const activeJob = jobs.find((job) => job.id === activeJobId && job.state === 'done')

  const videoRef = useRef<HTMLVideoElement>(null)
  // Read inside the callback, which is rebuilt only when the clips change and
  // would otherwise close over a stale playhead.
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  // Whatever is actually on the stage — a video or a still — so the overlay
  // layer can be measured against the picture rather than the box around it.
  const mediaRef = useRef<HTMLElement | null>(null)

  // The keyboard needs to start and stop the picture, and the element it acts
  // on lives here. Registered while this panel is mounted, and null while it
  // is not — the crop editor takes the <video> off the stage entirely, and the
  // space bar has to do nothing then rather than fail.
  const registerPlayer = useStore((state) => state.registerPlayer)
  useEffect(() => {
    registerPlayer({
      play: () => void videoRef.current?.play().catch(() => {}),
      pause: () => videoRef.current?.pause(),
      playing: () => Boolean(videoRef.current && !videoRef.current.paused),
    })
    return () => registerPlayer(null)
  }, [registerPlayer])

  const [copied, setCopied] = useState(false)
  // Staying on the source is deliberate. Finishing a job used to swap the view
  // out from under whatever was being set up; the result announces itself in
  // the bar instead, and is one click away.
  const [showing, setShowing] = useState<'source' | 'result'>('source')
  useEffect(() => {
    setShowing('source')
  }, [file?.id])

  const sourceTime = at?.sourceSeconds ?? playhead

  // The position is tracked whether or not a video element exists: while the
  // crop rectangle is on screen there is no <video>, and the crop frame still
  // has to follow the timeline.
  //
  // What the element reports is a position in *its own file*, which on a joined
  // timeline is not where the playhead is.
  const onTimeUpdate = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds)) return
      const playing = clipAt(project.clips, playheadRef.current)
      const mapped = playing ? timelineAt(project.clips, playing.uid, seconds) : null
      setPlayhead(mapped ?? seconds)
    },
    [project.clips, setPlayhead],
  )

  // And the other way: moving the playhead has to move the picture, or clicking
  // the timeline changed the marker and left the frame behind it.
  //
  // The tolerance is what keeps the two from fighting. While the clip plays,
  // every `timeupdate` sets the playhead, which lands back here — and seeking
  // to where it already is would stutter the playback.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !Number.isFinite(sourceTime)) return
    if (Math.abs(video.currentTime - sourceTime) > 0.2) video.currentTime = sourceTime
  }, [sourceTime])

  // The crop rectangle is only worth showing while a crop is being set up.
  const croppingNow = project.effects.some((item) => item.op === 'crop' && item.enabled)

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <Empty icon="FileVideo" title={t('preview.none')} hint={t('preview.noneHint')} />
      </div>
    )
  }

  const resultUrl = activeJob
    ? (activeJob.outputUrl ?? (activeJob.outputPath ? api.fileUrl(activeJob.outputPath) : null))
    : null
  const showResult = showing === 'result' && resultUrl

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeJob ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-3 py-2">
            <Icon name="CircleCheck" size={16} className="shrink-0 text-ok" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{activeJob.outputName}</span>
              <span className="block truncate font-mono text-[11px] text-dim">
                {formatBytes(activeJob.outputSize)}
                {activeJob.outputPath ? ` · ${activeJob.outputPath}` : ` · ${t('preview.inBrowser')}`}
              </span>
            </span>

            <div className="inline-flex shrink-0 rounded-lg border border-line bg-panel p-0.5">
              {(['source', 'result'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setShowing(mode)}
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium',
                    showing === mode ? 'bg-accent text-accent-fg' : 'text-dim hover:text-ink',
                  )}
                >
                  {t(`preview.${mode}`)}
                </button>
              ))}
            </div>

            {activeJob.outputPath && (
              <button
                type="button"
                className="btn !py-1"
                title={activeJob.outputPath}
                onClick={() => {
                  void navigator.clipboard?.writeText(activeJob.outputPath!).catch(() => {})
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                }}
              >
                <Icon name={copied ? 'Check' : 'Copy'} size={13} />
                {t('preview.copyPath')}
              </button>
            )}
            <button type="button" className="btn btn-primary !py-1" onClick={() => downloadJob(activeJob)}>
              <Icon name="Download" size={13} />
              {t('preview.save')}
            </button>
            <label
              className="flex cursor-pointer items-center gap-1.5 text-[11px] text-dim"
              title={t('preview.autoSaveHint')}
            >
              <input
                type="checkbox"
                checked={autoDownload}
                onChange={(event) => setAutoDownload(event.target.checked)}
                className="accent-[var(--accent)]"
              />
              {t('preview.autoSave')}
            </label>
          </div>
        ) : (
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <h2 className="section-title flex-1 truncate">
              {t('preview.title')}
              <span className="ml-2 font-mono text-[11px] normal-case tracking-normal text-faint">
                {file.name}
              </span>
            </h2>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/85 p-2">
          {showResult ? (
            <Media url={resultUrl} name={activeJob!.outputName} />
          ) : croppingNow ? (
            <CropEditor
              file={file}
              atTime={sourceTime}
              videoRef={videoRef}
              onTimeUpdate={onTimeUpdate}
            />
          ) : (
            <SourcePreview
              file={file}
              videoRef={videoRef}
              mediaRef={mediaRef}
              onTimeUpdate={onTimeUpdate}
            />
          )}

          {/* Not over the finished file — that already has them baked in — and
              not over the crop rectangle, which is busy enough. */}
          {!showResult && !croppingNow && project.overlays.length > 0 && (
            <OverlayPreview mediaRef={mediaRef} />
          )}
        </div>

        {!showResult && <Timeline />}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line px-3 py-1.5 font-mono text-[11px] text-faint">
          {file.info?.width && (
            <span>
              {file.info.width}×{file.info.height}
            </span>
          )}
          {file.info?.fps && <span>{file.info.fps.toFixed(2)} fps</span>}
          <span>{formatBytes(file.size)}</span>
          {file.info?.video_codec && <span>{file.info.video_codec}</span>}
          {file.info?.audio_codec && <span>{file.info.audio_codec}</span>}
          {file.infoError && <span className="text-warn">{file.infoError}</span>}
        </div>
      </section>
    </div>
  )
}

function SourcePreview({
  file,
  videoRef,
  mediaRef,
  onTimeUpdate,
}: {
  file: MediaFile
  videoRef: React.RefObject<HTMLVideoElement | null>
  mediaRef?: React.RefObject<HTMLElement | null>
  onTimeUpdate: (seconds: number) => void
}) {
  const url = useMemo(
    () => (file.blob ? URL.createObjectURL(file.blob) : api.fileUrl(file.path)),
    [file],
  )
  useEffect(() => {
    // Object URLs for dropped files hold the whole file in memory until revoked.
    return () => {
      if (file.blob) URL.revokeObjectURL(url)
    }
  }, [file.blob, url])

  return (
    <Media
      url={url}
      name={file.name}
      videoRef={videoRef}
      mediaRef={mediaRef}
      onTimeUpdate={onTimeUpdate}
    />
  )
}

function Media({
  url,
  name,
  videoRef,
  mediaRef,
  onTimeUpdate,
}: {
  url: string
  name: string
  videoRef?: React.RefObject<HTMLVideoElement | null>
  /** Set to whichever element ends up carrying the picture. */
  mediaRef?: React.RefObject<HTMLElement | null>
  onTimeUpdate?: (seconds: number) => void
}) {
  const { t } = useT()
  const ext = extensionOf(name)

  if (IMAGES.includes(ext)) {
    return (
      <img
        ref={(element) => {
          if (mediaRef) mediaRef.current = element
        }}
        src={url}
        alt={name}
        className="max-h-full max-w-full object-contain"
      />
    )
  }
  if (PLAYABLE_AUDIO.includes(ext)) {
    return <audio src={url} controls className="w-full max-w-lg" />
  }
  if (PLAYABLE_VIDEO.includes(ext)) {
    return (
      <video
        ref={(element) => {
          if (videoRef) videoRef.current = element
          if (mediaRef) mediaRef.current = element
        }}
        src={url}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={(event) => onTimeUpdate?.(event.currentTarget.currentTime)}
        className="max-h-full max-w-full object-contain"
      />
    )
  }
  return (
    <div className="text-center">
      <Icon name="FileQuestion" size={22} className="mx-auto mb-2 text-faint" />
      <p className="text-[12px] text-faint">{t('preview.noPreview')}</p>
    </div>
  )
}
