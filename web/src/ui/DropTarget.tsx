/**
 * Files can be dropped anywhere in the window.
 *
 * A dropped file arrives without a path — browsers will not tell a page where a
 * file lives — so its bytes are copied to a scratch directory the server
 * deletes when it exits. Opening the same file through the file browser reads
 * it in place instead, which is why that is the primary way in.
 *
 * Drag tracking is counted rather than toggled, because `dragleave` fires every
 * time the pointer crosses into a child element and a boolean flag flickers off
 * while the pointer is still inside the window.
 */

import { useCallback, useState } from 'react'

import { api } from '../api/client'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'

export function DropTarget({ children }: { children: React.ReactNode }) {
  const { t } = useT()
  const addFiles = useStore((state) => state.addFiles)
  const setError = useStore((state) => state.setError)
  const setNotice = useStore((state) => state.setNotice)

  const setBusy = useStore((state) => state.setBusy)

  const [depth, setDepth] = useState(0)

  const hasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      setDepth(0)
      const dropped = Array.from(event.dataTransfer.files)
      if (dropped.length === 0) return

      try {
        setBusy({
          kind: 'copying',
          count: dropped.length,
          done: 0,
          name: dropped[0]?.name,
        })
        const uploaded = await api.upload(dropped)
        // `addFiles` puts up its own message while it reads them.
        setBusy(null)
        await addFiles(uploaded.files)
        setNotice(t('files.copied', { n: dropped.length }))
      } catch (error) {
        setError((error as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [addFiles, setBusy, setError, setNotice, t],
  )


  return (
    <div
      className="h-full"
      onDragEnter={(event) => {
        if (hasFiles(event)) setDepth((current) => current + 1)
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        // Without this the browser navigates to the dropped file instead.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => setDepth((current) => Math.max(0, current - 1))}
      onDrop={onDrop}
    >
      {children}

      {depth > 0 && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-panel px-10 py-8 text-center shadow-xl">
            <Icon name="FilePlus2" size={30} className="mx-auto mb-3 text-accent" />
            <p className="text-[15px] font-semibold">{t('files.dropAnywhere')}</p>
          </div>
        </div>
      )}

    </div>
  )
}
