/**
 * The job queue.
 *
 * There is no separate "batch mode": one file or twenty, every run lands here
 * as its own job with its own progress and its own result.
 */

import { zipSync } from 'fflate'
import clsx from 'clsx'

import { download, downloadJob, resultUrl } from '../core/download'
import { formatBytes, formatDuration, formatPercent } from '../core/format'
import type { Job } from '../core/types'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Empty, Icon, ProgressBar } from './controls'

const STATE_COLOURS: Record<Job['state'], string> = {
  queued: 'text-faint',
  running: 'text-accent',
  done: 'text-ok',
  failed: 'text-err',
  canceled: 'text-warn',
}

const STATE_ICONS: Record<Job['state'], string> = {
  queued: 'Clock',
  running: 'Loader',
  done: 'Check',
  failed: 'TriangleAlert',
  canceled: 'Ban',
}

export function QueueList() {
  const { t } = useT()
  const jobs = useStore((state) => state.jobs)
  const activeJobId = useStore((state) => state.activeJobId)
  const setActiveJob = useStore((state) => state.setActiveJob)
  const cancelJob = useStore((state) => state.cancelJob)
  const clearFinished = useStore((state) => state.clearFinishedJobs)
  const setError = useStore((state) => state.setError)

  const finished = jobs.filter((job) => job.state === 'done')

  const downloadAllAsZip = async () => {
    try {
      const entries: Record<string, Uint8Array> = {}
      for (const job of finished) {
        const url = resultUrl(job)
        if (!url) continue
        const response = await fetch(url)
        entries[job.outputName] = new Uint8Array(await response.arrayBuffer())
      }
      if (Object.keys(entries).length === 0) return
      const zipped = zipSync(entries, { level: 0 })
      const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' })
      download(URL.createObjectURL(blob), 'ffweb-results.zip', true)
    } catch (error) {
      setError((error as Error).message)
    }
  }

  if (jobs.length === 0) {
    return <Empty icon="ListChecks" title={t('queue.empty')} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 py-1">
        <span className="flex-1" />
        {finished.length > 1 && (
          <button type="button" className="btn btn-ghost !py-0.5 !text-[11px]" onClick={downloadAllAsZip}>
            <Icon name="FileArchive" size={13} />
            {t('queue.zip')}
          </button>
        )}
        {jobs.some((job) => job.state !== 'running' && job.state !== 'queued') && (
          <button type="button" className="btn btn-ghost !py-0.5 !text-[11px]" onClick={clearFinished}>
            <Icon name="Trash2" size={13} />
            {t('queue.clear')}
          </button>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {jobs.map((job) => (
          <li key={job.id}>
            <div
              className={clsx(
                'group rounded-md px-2 py-1.5',
                job.id === activeJobId ? 'bg-accent-soft' : 'hover:bg-panel-2',
              )}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name={STATE_ICONS[job.state]}
                  size={14}
                  className={clsx(STATE_COLOURS[job.state], job.state === 'running' && 'animate-spin')}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setActiveJob(job.id)}
                >
                  <span className="block truncate text-[13px]">{job.outputName}</span>
                  <span className="block truncate font-mono text-[11px] text-faint">
                    {job.state === 'running'
                      ? [
                          formatPercent(job.progress),
                          job.speed ? `${job.speed.toFixed(1)}×` : null,
                          job.outTime ? formatDuration(job.outTime, 0) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : job.state === 'done'
                        ? `${formatBytes(job.outputSize)}${job.outputPath ? ` · ${job.outputPath}` : ''}`
                        : (job.error ?? t(`state.${job.state}`))}
                  </span>
                </button>

                {job.state === 'running' || job.state === 'queued' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={t('queue.cancel')}
                    onClick={() => cancelJob(job.id)}
                  >
                    <Icon name="Square" size={13} />
                  </button>
                ) : (
                  resultUrl(job) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      title={t('queue.download')}
                      onClick={() => downloadJob(job)}
                    >
                      <Icon name="Download" size={14} />
                    </button>
                  )
                )}
              </div>

              {job.state === 'running' && (
                <div className="mt-1.5">
                  <ProgressBar value={job.progress} indeterminate={!job.duration} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
