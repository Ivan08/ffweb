/**
 * What is happening while nothing can be done.
 *
 * A pill in the corner was not enough. Opening a long file off a slow disk, or
 * dropping a large one, leaves the interface looking idle for several seconds —
 * which invites a second click and says nothing about why the wait exists. This
 * takes the screen and says which of the two is going on, because they are
 * genuinely different: copying writes bytes into a scratch folder and its cost
 * is the file's size, while reading only inspects files where they already lie.
 */

import { useEffect, useState } from 'react'

import { formatPercent } from '../core/format'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'

/**
 * How long a wait has to last before it is worth interrupting for.
 *
 * A local probe of a small file answers in tens of milliseconds, and a screen
 * that flashes on and off in that time is worse than one that never appeared.
 */
const PATIENCE = 250

export function BusyOverlay() {
  const { t } = useT()
  const busy = useStore((state) => state.busy)
  const [showing, setShowing] = useState(false)

  useEffect(() => {
    if (!busy) {
      setShowing(false)
      return
    }
    const timer = window.setTimeout(() => setShowing(true), PATIENCE)
    return () => window.clearTimeout(timer)
    // Keyed on the kind rather than the whole object: the progress count
    // changes on every file and would otherwise restart the wait each time.
  }, [busy?.kind])

  if (!busy || !showing) return null

  const many = busy.count > 1
  const fraction = busy.count > 0 ? busy.done / busy.count : 0

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/80 backdrop-blur-sm"
    >
      <div className="w-[min(90vw,26rem)] rounded-2xl border border-line bg-panel p-6 text-center shadow-xl">
        <Icon
          name={busy.kind === 'copying' ? 'Copy' : 'FileSearch'}
          size={26}
          className="mx-auto mb-3 text-accent"
        />

        <p className="text-[15px] font-semibold">
          {many
            ? t(`busy.${busy.kind}.many`, { n: busy.count })
            : t(`busy.${busy.kind}.one`, { name: busy.name ?? '' })}
        </p>

        <p className="mx-auto mt-1.5 max-w-[34ch] text-[12px] leading-snug text-faint">
          {t(`busy.${busy.kind}.hint`)}
        </p>

        {many && (
          <>
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-panel-2">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${Math.max(4, fraction * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-faint">
              {busy.done} / {busy.count} · {formatPercent(fraction)}
            </p>
          </>
        )}

        {!many && (
          <Icon name="Loader" size={16} className="mx-auto mt-4 animate-spin text-faint" />
        )}
      </div>
    </div>
  )
}
