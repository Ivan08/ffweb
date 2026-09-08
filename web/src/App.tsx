/** The workspace: the file being worked on, and what to do with it. */

import { useEffect, useState } from 'react'

import { useT } from './i18n'
import { useStore } from './store'
import { BottomDock } from './ui/BottomDock'
import { BusyOverlay } from './ui/BusyOverlay'
import { CommandBar } from './ui/CommandBar'
import { DropTarget } from './ui/DropTarget'
import { FileBar } from './ui/FileBar'
import { FileDialog } from './ui/FileDialog'
import { Header } from './ui/Header'
import { SidePanel } from './ui/SidePanel'
import { PreviewPanel } from './ui/PreviewPanel'
import { Splitter } from './ui/Splitter'
import { Icon } from './ui/controls'
import { useResizable } from './ui/useResizable'

export function App() {
  const { t, language } = useT()
  const init = useStore((state) => state.init)
  const error = useStore((state) => state.error)
  const notice = useStore((state) => state.notice)
  const setError = useStore((state) => state.setError)
  const capabilitiesError = useStore((state) => state.capabilitiesError)
  const wasmMessage = useStore((state) => state.wasmMessage)
  const files = useStore((state) => state.files)

  const right = useResizable('right', 400, 300, 640, 'end')
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'o' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setPicking(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (capabilitiesError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel max-w-md p-5">
          <h1 className="mb-2 flex items-center gap-2 text-[15px] font-semibold">
            <Icon name="TriangleAlert" className="text-err" />
            {t('error.title')}
          </h1>
          <p className="font-mono text-[12px] text-dim">{capabilitiesError}</p>
        </div>
      </div>
    )
  }

  return (
    <DropTarget>
      <div className="flex h-full flex-col overflow-hidden">
        <Header onOpenFiles={() => setPicking(true)} />

        <div className="border-b border-line bg-panel">
          <FileBar onOpen={() => setPicking(true)} />
        </div>

        <main className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1">
            {files.length === 0 ? (
              <EmptyState onOpen={() => setPicking(true)} />
            ) : (
              <PreviewPanel />
            )}
          </div>
          <Splitter resizable={right} />
          <div className="min-h-0 shrink-0" style={{ width: right.width }}>
            <SidePanel />
          </div>
        </main>

        <CommandBar />
        <BottomDock />

        <FileDialog open={picking} onClose={() => setPicking(false)} />
        <BusyOverlay />

        {wasmMessage && (
          <div className="pointer-events-none fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-line bg-panel px-4 py-2 shadow-lg">
            <p className="flex items-center gap-2 text-[12px]">
              <Icon name="Loader" size={14} className="animate-spin text-accent" />
              {t('wasm.loading')}
            </p>
          </div>
        )}

        {notice && (
          <div className="pointer-events-none fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-line bg-panel px-4 py-2 shadow-lg">
            <p className="flex items-center gap-2 text-[12px]">
              <Icon name="Check" size={14} className="text-ok" />
              {notice}
            </p>
          </div>
        )}

        {error && (
          <div className="fixed bottom-16 right-4 z-50 max-w-md rounded-lg border border-err/40 bg-panel p-3 shadow-lg">
            <div className="flex items-start gap-2">
              <Icon name="TriangleAlert" size={15} className="mt-0.5 shrink-0 text-err" />
              <p className="min-w-0 flex-1 break-words font-mono text-[11px] leading-relaxed text-dim">
                {error}
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title={t('error.dismiss')}
                onClick={() => setError(null)}
              >
                <Icon name="X" size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </DropTarget>
  )
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  const { t } = useT()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="FileVideo" size={32} className="text-faint" />
      <p className="text-[14px] text-dim">{t('preview.none')}</p>
      <p className="max-w-[36ch] text-[12px] text-faint">{t('preview.noneHint')}</p>
      <button type="button" className="btn btn-primary mt-1" onClick={onOpen}>
        <Icon name="FolderOpen" size={14} />
        {t('files.open')}
      </button>
    </div>
  )
}
