/**
 * The right column: what is selected, and what is being done to it.
 *
 * Export is not here. It is one button at the bottom that opens the questions
 * that belong to it — what should come out, in what form — because those are
 * asked once, at the end, and not while the timeline is being built.
 */

import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'
import { EffectsPanel } from './EffectsPanel'
import { ExportDialog } from './ExportDialog'
import { Inspector } from './Inspector'
import { ResultPanel } from './ResultPanel'

export function SidePanel() {
  const { t } = useT()
  const clips = useStore((state) => state.project.clips)
  const dialog = useStore((state) => state.dialog)
  const openDialog = useStore((state) => state.openDialog)
  const closeDialog = useStore((state) => state.closeDialog)

  const empty = clips.length === 0

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Inspector />
        <ResultPanel />
        <EffectsPanel />
      </div>

      <div className="border-t border-line bg-panel px-3 py-2.5">
        <button
          type="button"
          className="btn btn-primary w-full !py-2"
          disabled={empty}
          onClick={() => openDialog('export')}
        >
          <Icon name="Download" size={14} />
          {t('export.open')}
        </button>
        {empty && <p className="mt-1.5 text-center text-[11px] text-faint">{t('op.needsFile')}</p>}
      </div>

      <ExportDialog open={dialog === 'export'} onClose={closeDialog} />
    </aside>
  )
}
