/**
 * The source strip: the files in play, and what to do with them.
 *
 * Selection used to be a ctrl-click with no visible consequence, which is why
 * joining was undiscoverable — the operation depended on a multi-selection that
 * nothing on screen mentioned. Now a tick is a tick, the order is numbered
 * because the order is what joining uses, and the actions that consume a
 * selection sit next to it.
 */

import clsx from 'clsx'

import { formatBytes, formatDuration } from '../core/format'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'

export function FileBar({ onOpen }: { onOpen: () => void }) {
  const { t } = useT()
  const files = useStore((state) => state.files)
  const selection = useStore((state) => state.selection)
  const project = useStore((state) => state.project)
  const selectFile = useStore((state) => state.selectFile)
  const removeFile = useStore((state) => state.removeFile)
  const addClips = useStore((state) => state.addClips)

  const chosen = selection.filter((id) => files.some((file) => file.id === id))
  const onTimeline = new Set(project.clips.map((clip) => clip.fileId))

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button type="button" className="btn shrink-0 !py-1" onClick={onOpen} title="Ctrl+O">
        <Icon name="FolderOpen" size={14} />
        {t('files.open')}
      </button>

      {files.length === 0 ? (
        <span className="truncate px-1 text-[12px] text-faint">{t('files.noneYet')}</span>
      ) : (
        files.map((file) => {
          const order = chosen.indexOf(file.id)
          const active = order >= 0
          return (
            <span
              key={file.id}
              className={clsx(
                'group flex shrink-0 items-center gap-1.5 rounded-lg border py-1 pl-1.5 pr-1 transition-colors',
                active ? 'border-accent bg-accent-soft' : 'border-line bg-panel-2 hover:border-line-strong',
              )}
            >
              <button
                type="button"
                className="flex items-center gap-1.5 text-left"
                aria-pressed={active}
                // The chip reads as a checkbox, so it behaves as one: a plain
                // click ticks and unticks. The old rule — plain click replaces
                // the selection unless a modifier is held — is what made
                // joining undiscoverable.
                onClick={() => selectFile(file.id, true)}
                title={file.path}
              >
                {/* The number, not just a highlight: joining plays the clips in
                    the order they were ticked, so that order has to be legible. */}
                <span
                  className={clsx(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] font-semibold',
                    active ? 'border-accent bg-accent text-accent-fg' : 'border-line text-faint',
                  )}
                >
                  {active ? order + 1 : ''}
                </span>
                <Icon
                  name={file.info?.has_video === false ? 'Music' : 'Video'}
                  size={13}
                  className={active ? 'text-accent' : 'text-faint'}
                />
                <span className="max-w-[14rem] truncate text-[12px]">{file.name}</span>
                <span className="font-mono text-[11px] text-faint">
                  {file.info?.duration ? formatDuration(file.info.duration, 0) : formatBytes(file.size, 0)}
                </span>
                {onTimeline.has(file.id) && (
                  <Icon name="Check" size={11} className="text-ok" />
                )}
              </button>
              <button
                type="button"
                className="rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-err group-hover:opacity-100 focus:opacity-100"
                title={t('files.remove')}
                onClick={() => removeFile(file.id)}
              >
                <Icon name="X" size={12} />
              </button>
            </span>
          )
        })
      )}

      {chosen.length > 0 && (
        <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-line pl-2">
          <span className="whitespace-nowrap text-[11px] text-faint">
            {t('files.selected', { n: chosen.length })}
          </span>
          <button
            type="button"
            className="btn !py-1 !text-[11px]"
            title={t('source.addHint')}
            onClick={() => addClips(chosen)}
          >
            <Icon name="Plus" size={12} />
            {chosen.length > 1 ? t('source.join', { n: chosen.length }) : t('source.add')}
          </button>
        </div>
      )}
    </div>
  )
}
