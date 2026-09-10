/** Title bar: what is running, on which engine, and the display preferences. */

import { useEffect, useState } from 'react'
import clsx from 'clsx'

import { formatBytes } from '../core/format'
import { useT } from '../i18n'
import { useLanguage } from '../i18n'
import { useStore } from '../store'
import { labelFor, onApple } from '../core/shortcuts'
import { Icon, Segmented } from './controls'

export function Header({ onOpenFiles }: { onOpenFiles: () => void }) {
  const { t } = useT()
  const { language, setLanguage } = useLanguage()
  const apple = onApple()
  const capabilities = useStore((state) => state.capabilities)
  const engine = useStore((state) => state.engine)
  const setEngine = useStore((state) => state.setEngine)
  const theme = useStore((state) => state.theme)
  const toggleTheme = useStore((state) => state.toggleTheme)
  const clearWorkspace = useStore((state) => state.clearWorkspace)
  const files = useStore((state) => state.files)
  const jobs = useStore((state) => state.jobs)
  const undo = useStore((state) => state.undo)
  const redo = useStore((state) => state.redo)
  const canUndo = useStore((state) => state.history.past.length > 0)
  const canRedo = useStore((state) => state.history.future.length > 0)

  const nativeAvailable = capabilities?.native.available ?? false
  const cache = capabilities?.wasm.cache

  return (
    <header className="flex items-center gap-4 border-b border-line bg-panel px-4 py-2.5">
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        title={`${t('files.open')} · ${labelFor('open', apple)}`}
        onClick={onOpenFiles}
      >
        <Icon name="FolderOpen" size={16} />
      </button>

      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-tight">ffweb</span>
        <span className="hidden text-[12px] text-faint sm:inline">{t('app.tagline')}</span>
      </div>

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={`${t('history.undo')} · ${labelFor('undo', apple)}`}
          aria-label={t('history.undo')}
          disabled={!canUndo}
          onClick={undo}
        >
          <Icon name="Undo2" size={15} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={`${t('history.redo')} · ${labelFor('redo', apple)}`}
          aria-label={t('history.redo')}
          disabled={!canRedo}
          onClick={redo}
        >
          <Icon name="Redo2" size={15} />
        </button>
      </div>

      <ClearButton
        disabled={files.length === 0 && jobs.length === 0}
        busy={jobs.some((job) => job.state === 'running' || job.state === 'queued')}
        onClear={clearWorkspace}
      />

      <div className="flex min-w-0 items-center gap-2">
        <span
          className={clsx(
            'h-2 w-2 shrink-0 rounded-full',
            nativeAvailable ? 'bg-ok' : 'bg-warn',
          )}
          aria-hidden
        />
        <span className="truncate font-mono text-[12px] text-dim">
          {nativeAvailable
            ? `ffmpeg ${capabilities?.native.versionNumber ?? ''}`
            : t('engine.missing')}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="label hidden md:inline">{t('engine.label')}</span>
        <Segmented
          value={engine}
          onChange={setEngine}
          options={[
            {
              value: 'native' as const,
              label: t('engine.native'),
              title: nativeAvailable ? t('engine.native.hint') : t('engine.missing.hint'),
            },
            { value: 'wasm' as const, label: t('engine.wasm'), title: t('engine.wasm.hint') },
          ].filter((option) => option.value !== 'native' || nativeAvailable)}
        />

        {engine === 'wasm' && cache && (
          <span
            className="hidden font-mono text-[11px] text-faint lg:inline"
            title={cache.dir}
          >
            {cache.mt_ready || cache.st_ready
              ? `${t('wasm.ready')} · ${formatBytes(cache.bytes)}`
              : t('wasm.missing')}
          </span>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('lang.toggle')}
          onClick={() => setLanguage(language === 'ru' ? 'en' : 'ru')}
        >
          <span className="text-[12px] font-semibold uppercase">{language}</span>
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('theme.toggle')}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'Sun' : 'Moon'} />
        </button>
      </div>
    </header>
  )
}

/**
 * Emptying the workspace.
 *
 * It asks first only when something is still running, because that is the one
 * case where the button throws away work in progress rather than a state that
 * can be rebuilt by opening the file again. Finished files on disk are never
 * touched.
 */
function ClearButton({
  disabled,
  busy,
  onClear,
}: {
  disabled: boolean
  busy: boolean
  onClear: () => void
}) {
  const { t } = useT()
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirming])

  return (
    <button
      type="button"
      className={clsx('btn !py-1 !text-[12px]', confirming && 'border-warn text-warn')}
      disabled={disabled}
      title={t('workspace.clearHint')}
      onClick={() => {
        if (busy && !confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        onClear()
      }}
    >
      <Icon name="Trash2" size={13} />
      {confirming ? t('workspace.clearConfirm') : t('workspace.clear')}
    </button>
  )
}
