/** The grab handle between two columns. */

import clsx from 'clsx'

import { useT } from '../i18n'
import type { Resizable } from './useResizable'

export function Splitter({ resizable }: { resizable: Resizable }) {
  const { t } = useT()

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={t('layout.resize')}
      onPointerDown={resizable.onPointerDown}
      onDoubleClick={resizable.reset}
      // The visible line is one pixel; the grab area is eleven, because a
      // one-pixel target is a fight.
      className={clsx(
        'group relative z-10 w-[11px] shrink-0 cursor-col-resize',
        '-mx-[5px]',
      )}
    >
      <span
        className={clsx(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          resizable.dragging ? 'bg-accent' : 'bg-line group-hover:bg-accent',
        )}
      />
    </div>
  )
}
