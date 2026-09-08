/**
 * Where the visible part of a zoomed timeline sits within the whole file.
 *
 * Zoomed in, the strip above shows a few seconds and gives no clue which few.
 * This is the map: a bar the width of the file with the visible window marked
 * on it, which can be dragged to move that window or clicked to jump.
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import type { View } from '../../core/geometry'
import { useT } from '../../i18n'

export function Overview({
  duration,
  view,
  onChange,
}: {
  duration: number
  view: View
  onChange: (start: number, end: number) => void
}) {
  const { t } = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const origin = useRef({ x: 0, start: 0, end: 0 })

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const delta = ((event.clientX - origin.current.x) / rect.width) * duration
      onChange(origin.current.start + delta, origin.current.end + delta)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, duration, onChange])

  const length = view.end - view.start

  return (
    <div
      ref={ref}
      title={t('trim.pan')}
      onPointerDown={(event) => {
        const rect = ref.current?.getBoundingClientRect()
        if (!rect) return
        const at = ((event.clientX - rect.left) / rect.width) * duration
        // Clicking outside the window jumps it there; dragging slides it.
        const outside = at < view.start || at > view.end
        if (outside) onChange(at - length / 2, at + length / 2)
        origin.current = {
          x: event.clientX,
          start: outside ? at - length / 2 : view.start,
          end: outside ? at + length / 2 : view.end,
        }
        setDragging(true)
      }}
      className="relative mt-1 h-2.5 cursor-grab overflow-hidden rounded-full bg-panel-2"
    >
      <span
        className={clsx('absolute inset-y-0 rounded-full', dragging ? 'bg-accent/80' : 'bg-accent/50')}
        style={{
          left: `${(view.start / duration) * 100}%`,
          width: `${(length / duration) * 100}%`,
        }}
      />
    </div>
  )
}
