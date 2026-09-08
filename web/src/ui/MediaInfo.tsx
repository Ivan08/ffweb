/** What ffprobe had to say about the selected file. */

import { formatBytes } from '../core/format'
import { useT } from '../i18n'
import { useStore } from '../store'

export function MediaInfo() {
  const { t } = useT()
  const files = useStore((state) => state.files)
  const selection = useStore((state) => state.selection)
  const file = files.find((candidate) => candidate.id === selection[0]) ?? files[0]

  if (!file) return <p className="px-3 pb-3 text-[12px] text-faint">{t('info.none')}</p>
  if (file.infoError) {
    return (
      <p className="px-3 pb-3 text-[12px] text-err">
        {t('info.unavailable', { error: file.infoError })}
      </p>
    )
  }

  const info = file.info
  const rows: Array<[string, string]> = [
    [t('info.duration'), info?.duration ? `${info.duration.toFixed(2)} s` : '—'],
    [t('info.size'), formatBytes(file.size)],
    [t('info.resolution'), info?.width ? `${info.width}×${info.height}` : '—'],
    [t('info.fps'), info?.fps ? info.fps.toFixed(3) : '—'],
    [t('info.video'), info?.video_codec ?? '—'],
    [t('info.audio'), info?.audio_codec ?? '—'],
    [t('info.bitrate'), info?.bit_rate ? `${Math.round(info.bit_rate / 1000)} kbit/s` : '—'],
    [t('info.format'), info?.format_name ?? '—'],
  ]

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 pb-3 text-[12px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-faint">{label}</dt>
          <dd className="truncate text-right font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
