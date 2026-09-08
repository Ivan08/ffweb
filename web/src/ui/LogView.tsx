/** ffmpeg's own output for the job in focus. */

import { useEffect, useRef } from 'react'

import type { LogLevel } from '../core/types'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Empty } from './controls'

const LEVEL_COLOURS: Record<LogLevel, string> = {
  info: 'text-dim',
  warn: 'text-warn',
  error: 'text-err',
}

export function LogView() {
  const { t } = useT()
  const jobs = useStore((state) => state.jobs)
  const activeJobId = useStore((state) => state.activeJobId)
  const job = jobs.find((candidate) => candidate.id === activeJobId) ?? jobs[0]
  const lines = job?.log ?? []

  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])

  if (lines.length === 0) {
    return <Empty icon="Terminal" title={t('log.empty')} />
  }

  return (
    <div className="h-full overflow-y-auto bg-panel-2 px-3 py-2">
      <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => (
          <div key={index} className={LEVEL_COLOURS[line.level]}>
            {line.text}
          </div>
        ))}
      </pre>
      <div ref={endRef} />
    </div>
  )
}
