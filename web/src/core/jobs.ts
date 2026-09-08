/**
 * Pure job bookkeeping: naming a result and reading a log line.
 *
 * Neither has anything to do with application state, and living in the store
 * made them unreachable from a test.
 */

import { extensionOf } from './format'
import type { Job, LogLine } from './types'

/** ffmpeg prefixes its lines with a level when asked to; colour follows it. */
export function classifyLog(line: string): LogLine {
  const lower = line.toLowerCase()
  if (lower.includes('[error]') || lower.includes('[fatal]') || lower.includes('error')) {
    return { level: 'error', text: line }
  }
  if (lower.includes('[warning]') || lower.includes('warning') || lower.includes('deprecated')) {
    return { level: 'warn', text: line }
  }
  return { level: 'info', text: line }
}

/** Avoid overwriting the result of an earlier job in the same session. */
export function uniqueOutputName(jobs: Pick<Job, 'outputName'>[], name: string): string {
  const taken = new Set(jobs.map((job) => job.outputName))
  if (!taken.has(name)) return name
  const ext = extensionOf(name)
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name
  for (let i = 2; i < 1000; i += 1) {
    const candidate = ext ? `${stem}-${i}.${ext}` : `${stem}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return name
}
