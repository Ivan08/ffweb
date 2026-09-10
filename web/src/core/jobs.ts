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

/**
 * Whether a failure looks like the machine lacking the hardware it was asked
 * to encode with.
 *
 * `ffmpeg -encoders` lists an encoder if ffmpeg was *built* with it, which is
 * not the same as a driver being installed — so choosing one that is offered
 * can still fail at the moment it runs, with a message about a shared library
 * or a device rather than about the choice that caused it.
 */
export function looksLikeMissingHardware(command: string[], log: Pick<LogLine, 'text'>[]): boolean {
  const chosen = command.some((arg) => /_(nvenc|qsv|vaapi|videotoolbox)$/.test(arg))
  if (!chosen) return false

  const text = log.map((line) => line.text).join('\n').toLowerCase()
  // Taken from what these encoders actually say when the hardware is absent:
  // nvenc cannot load its library, QSV fails to open an MFX session, VAAPI
  // finds no device. None of them mentions the setting that caused it.
  return [
    'cannot load',
    'no capable devices',
    'device creation failed',
    'failed setting up',
    'error creating a mfx session',
    'function not implemented',
    'operation not permitted',
    'error initializing',
    'unknown encoder',
  ].some((clue) => text.includes(clue))
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
