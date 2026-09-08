/**
 * The queue and the log, together at the bottom.
 *
 * Both are things you consult rather than work in, so they share one collapsed
 * strip instead of each taking a slice of a column. The strip always shows the
 * current job and the last log line, which is usually all that is needed.
 */

import { useState } from 'react'
import clsx from 'clsx'

import { formatPercent } from '../core/format'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'
import { LogView } from './LogView'
import { QueueList } from './QueueList'

type Tab = 'log' | 'queue'

export function BottomDock() {
  const { t } = useT()
  const jobs = useStore((state) => state.jobs)
  const activeJobId = useStore((state) => state.activeJobId)

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('queue')

  const running = jobs.filter((job) => job.state === 'running' || job.state === 'queued').length
  const job = jobs.find((candidate) => candidate.id === activeJobId) ?? jobs[0]
  const lastLine = job?.log.at(-1)

  return (
    <div className="border-t border-line bg-panel">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="btn btn-ghost btn-icon"
          title={open ? t('log.hide') : t('log.show')}
        >
          <Icon name={open ? 'ChevronDown' : 'ChevronUp'} size={14} />
        </button>

        {(['queue', 'log'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id)
              setOpen(true)
            }}
            className={clsx(
              'rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors',
              open && tab === id ? 'bg-panel-2 text-ink' : 'text-faint hover:text-ink',
            )}
          >
            {t(id === 'queue' ? 'queue.title' : 'log.title')}
            {id === 'queue' && jobs.length > 0 && (
              <span className={clsx('ml-1.5 font-mono', running > 0 ? 'text-accent' : 'text-faint')}>
                {running > 0 ? `${running}/${jobs.length}` : jobs.length}
              </span>
            )}
          </button>
        ))}

        {/* Whatever is happening, in one line, without opening anything. */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-faint"
        >
          {running > 0 && job
            ? `${job.outputName} · ${formatPercent(job.progress)}`
            : (lastLine?.text ?? t('log.empty'))}
        </button>
      </div>

      {open && (
        <div className="h-56 border-t border-line">
          {tab === 'queue' ? <QueueList /> : <LogView />}
        </div>
      )}
    </div>
  )
}
