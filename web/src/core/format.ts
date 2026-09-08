/** Human-readable renderings used across the UI. */

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** `83.4` -> `1:23.4`; hours appear only when there are any. */
export function formatDuration(seconds: number | null | undefined, decimals = 1): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const sign = seconds < 0 ? '-' : ''
  const total = Math.abs(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const secsText = secs.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, '0')
  if (hours > 0) return `${sign}${hours}:${String(minutes).padStart(2, '0')}:${secsText}`
  return `${sign}${minutes}:${secsText}`
}

/** `00:01:23.400` — the form ffmpeg accepts for -ss and -to. */
export function toTimecode(seconds: number): string {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs
    .toFixed(3)
    .padStart(6, '0')}`
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
}

/** Difference against the source, e.g. `-63%`. */
export function formatDelta(from: number, to: number): string {
  if (!from) return ''
  const delta = (to - from) / from
  const sign = delta < 0 ? '−' : '+'
  return `${sign}${Math.abs(Math.round(delta * 100))}%`
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

export function stemOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(0, index) : base
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Accepts `12`, `1:23`, `1:23.4` and `00:01:23.400`. */
export function parseTimecode(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':')
  if (parts.length > 3) return null
  let seconds = 0
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value) || value < 0) return null
    seconds = seconds * 60 + value
  }
  return seconds
}
