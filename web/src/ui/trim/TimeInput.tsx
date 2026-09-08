/** A timecode field that only commits when what was typed parses. */

import { useState } from 'react'

import { parseTimecode, toTimecode } from '../../core/format'

export function TimeInput({
  label,
  value,
  max,
  onCommit,
}: {
  label: string
  value: number
  max: number
  onCommit: (seconds: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? toTimecode(value)

  const commit = () => {
    if (draft === null) return
    const parsed = parseTimecode(draft)
    if (parsed !== null) onCommit(Math.min(parsed, max))
    setDraft(null)
  }

  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] text-faint">{label}</span>
      <input
        value={text}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(null)
        }}
        className="field w-[7.5rem] !py-0.5 text-center font-mono !text-[11px]"
      />
    </label>
  )
}
