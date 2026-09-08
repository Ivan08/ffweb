/**
 * The file browser, as a dialog.
 *
 * It used to occupy a permanent column, which is a lot of screen for something
 * you use for a few seconds at the start of a job. Opening a file is a moment,
 * not a mode, so it is a dialog now: pick a file and it gets out of the way.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import { api } from '../api/client'
import { formatBytes } from '../core/format'
import type { FsEntry, FsListing } from '../core/types'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Empty, Icon } from './controls'

export function FileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT()
  const addFiles = useStore((state) => state.addFiles)
  const capabilities = useStore((state) => state.capabilities)
  const setError = useStore((state) => state.setError)

  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [path, setPath] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const load = useCallback(
    async (next?: string) => {
      setLoading(true)
      try {
        const result = await api.browse(next)
        setListing(result)
        setPath(result.path)
        listRef.current?.scrollTo({ top: 0 })
      } catch (error) {
        setError((error as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [setError],
  )

  useEffect(() => {
    if (open && capabilities) {
      void load(path)
      // Typing should filter immediately, without aiming at the field first.
      window.setTimeout(() => filterRef.current?.focus(), 50)
    }
    // Re-listing on every path change would fight the navigation below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, capabilities])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const needle = filter.trim().toLowerCase()
  const entries = (listing?.entries ?? []).filter(
    (entry) => !needle || entry.name.toLowerCase().includes(needle),
  )
  const media = entries.filter((entry) => entry.is_media)

  const openEntry = async (entry: FsEntry, additive: boolean) => {
    if (entry.is_dir) {
      setFilter('')
      setPicked(new Set())
      await load(entry.path)
      return
    }
    if (additive) {
      // Several files at once, for joining or for a batch.
      setPicked((current) => {
        const next = new Set(current)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      return
    }
    await addFiles([{ path: entry.path, name: entry.name, size: entry.size }])
    onClose()
  }

  const confirmPicked = async () => {
    const chosen = media.filter((entry) => picked.has(entry.path))
    if (chosen.length === 0) return
    await addFiles(chosen.map((e) => ({ path: e.path, name: e.name, size: e.size })))
    setPicked(new Set())
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('files.open')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="panel flex h-[min(70vh,640px)] w-[min(92vw,820px)] flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Icon name="FolderOpen" size={16} className="text-accent" />
          <h2 className="flex-1 text-[13px] font-semibold">{t('files.openTitle')}</h2>
          <button type="button" className="btn btn-ghost btn-icon" title={t('error.dismiss')} onClick={onClose}>
            <Icon name="X" size={15} />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            disabled={!listing?.parent}
            title={t('files.parent')}
            onClick={() => listing?.parent && load(listing.parent)}
          >
            <Icon name="ChevronUp" size={15} />
          </button>
          <Breadcrumbs path={path} root={capabilities?.roots.browse} onNavigate={load} />
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            title={t('files.reload')}
            onClick={() => load(path)}
          >
            <Icon name="RotateCw" size={14} />
          </button>
        </div>

        <div className="px-3 py-2">
          <div className="relative">
            <Icon
              name="Search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              ref={filterRef}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('files.filter')}
              className="field pl-8"
            />
          </div>
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading && <li className="px-2 py-3 text-[12px] text-faint">{t('files.loading')}</li>}
          {!loading && entries.length === 0 && (
            <li>
              <Empty icon="FolderOpen" title={needle ? t('files.noMatches') : t('files.empty')} />
            </li>
          )}
          {!loading &&
            entries.map((entry) => {
              const selectable = entry.is_dir || entry.is_media
              const chosen = picked.has(entry.path)
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={!selectable}
                    title={entry.path}
                    onDoubleClick={() => selectable && openEntry(entry, false)}
                    onClick={(event) => selectable && openEntry(entry, event.ctrlKey || event.metaKey)}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                      chosen ? 'bg-accent-soft' : selectable ? 'hover:bg-panel-2' : 'cursor-default opacity-40',
                    )}
                  >
                    <Icon
                      name={entry.is_dir ? 'Folder' : entry.is_media ? 'FileVideo' : 'File'}
                      size={15}
                      className={entry.is_dir ? 'text-accent' : chosen ? 'text-accent' : 'text-faint'}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                    {!entry.is_dir && (
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        {formatBytes(entry.size, 0)}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
        </ul>

        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <p className="flex-1 text-[11px] text-faint">{t('files.openHint')}</p>
          {picked.size > 0 && (
            <button type="button" className="btn btn-primary !py-1" onClick={confirmPicked}>
              {t('files.openSelected', { n: picked.size })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The path as clickable segments.
 *
 * A truncated absolute path told you neither where you were nor how to get back
 * up; segments do both, and the row scrolls rather than eliding the end, which
 * is the part that matters.
 */
function Breadcrumbs({
  path,
  root,
  onNavigate,
}: {
  path?: string
  root?: string
  onNavigate: (path: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Keep the deepest segment visible as you descend.
    ref.current?.scrollTo({ left: ref.current.scrollWidth })
  }, [path])

  if (!path) return <span className="min-w-0 flex-1" />

  const segments = path.split('/').filter(Boolean)
  const rootDepth = root ? root.split('/').filter(Boolean).length : 0

  return (
    <div
      ref={ref}
      dir="ltr"
      className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      title={path}
    >
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join('/')}`
        const last = index === segments.length - 1
        // Anything above the browse root cannot be opened, so it is not a link.
        const reachable = index + 1 >= rootDepth
        return (
          <span key={target}>
            <span className="text-faint">/</span>
            <button
              type="button"
              disabled={!reachable || last}
              onClick={() => onNavigate(target)}
              className={clsx(
                'rounded px-0.5',
                last ? 'font-semibold text-ink' : reachable ? 'text-dim hover:text-accent' : 'text-faint',
              )}
            >
              {segment}
            </button>
          </span>
        )
      })}
    </div>
  )
}
