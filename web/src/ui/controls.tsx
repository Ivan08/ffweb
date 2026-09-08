/** Small building blocks shared by every panel. */

import type { ReactNode } from 'react'
import clsx from 'clsx'

import { ICONS } from './icons'

/** Look a lucide icon up by name, so operations can name theirs as a string. */
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  const Component = ICONS[name]
  if (!Component) return null
  return <Component size={size} className={className} />
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-faint">{hint}</span>}
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-[13px]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-panel-2',
        )}
      >
        <span
          className={clsx(
            'absolute top-[2px] h-3 w-3 rounded-full bg-panel transition-[left]',
            checked ? 'left-[16px]' : 'left-[2px]',
          )}
        />
      </button>
      <span className="text-ink">{label}</span>
    </label>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className="font-mono text-[12px] text-dim">
          {Number.isInteger(value) ? value : value.toFixed(2)}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range"
        // The name sits in a sibling span rather than a `<label>`, so without
        // this the control has no accessible name at all.
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={clsx(
            'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
            option.value === value
              ? 'bg-accent text-accent-fg'
              : 'text-dim hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ProgressBar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-panel-2">
      <div
        className={clsx('h-full rounded-full bg-accent transition-[width] duration-200', {
          'animate-pulse w-1/3': indeterminate,
        })}
        style={indeterminate ? undefined : { width: `${Math.round(value * 100)}%` }}
      />
    </div>
  )
}

export function Empty({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Icon name={icon} size={22} className="text-faint" />
      <p className="text-[13px] text-dim">{title}</p>
      {hint && <p className="max-w-[28ch] text-[12px] text-faint">{hint}</p>}
    </div>
  )
}
