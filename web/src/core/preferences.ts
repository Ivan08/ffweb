/**
 * The handful of choices remembered between sessions.
 *
 * Every read and write is guarded: a private window, a browser set to block
 * site data, or a viewer with storage disabled must still get a working
 * interface, just one that forgets.
 */

export type Theme = 'light' | 'dark'

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Remembering a preference is a convenience, not a requirement.
  }
}

export function readFlag(key: string, fallback: boolean): boolean {
  const saved = readString(key)
  if (saved === '1') return true
  if (saved === '0') return false
  return fallback
}

export function writeFlag(key: string, value: boolean): void {
  writeString(key, value ? '1' : '0')
}

/** The saved theme, or whatever the system is set to. */
export function initialTheme(): Theme {
  const saved = readString('ffweb.theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}
