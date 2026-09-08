/**
 * The command line, always visible and always editable.
 *
 * In the tool this replaces, raw ffmpeg arguments were a separate mode you had
 * to opt into. Here the exact command is a first-class part of the interface:
 * it reflects the form as you change it, and editing it hands control over.
 */

import { useState } from 'react'
import clsx from 'clsx'

import { formatCommand } from '../core/shell'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon } from './controls'

export function CommandBar() {
  const { t } = useT()
  const commandOverride = useStore((state) => state.commandOverride)
  const setCommandOverride = useStore((state) => state.setCommandOverride)
  const currentCommand = useStore((state) => state.currentCommand)

  // Depend on everything the command is derived from, so it re-renders in step
  // with the timeline. The project is one object, which is most of the point:
  // it used to take six separate subscriptions to notice a change.
  useStore((state) => state.project)
  useStore((state) => state.files)
  useStore((state) => state.engine)

  const built = currentCommand()
  const generated = built ? formatCommand(built.display) : ''

  // Deliberately not held in local state as well. It was, and an override set
  // from anywhere but this textarea — a ready-made recipe, say — never reached
  // the field: the effect that copied it in only ran while there was no
  // override at all, which is exactly when there was nothing to copy.
  const text = commandOverride ?? generated
  const [copied, setCopied] = useState(false)

  const editing = commandOverride !== null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied; the text is selectable either way.
    }
  }

  return (
    <div className="border-t border-line bg-panel">
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-1.5 select-none font-mono text-[12px] text-faint">$</span>

        <textarea
          value={text}
          spellCheck={false}
          rows={1}
          onChange={(event) => setCommandOverride(event.target.value)}
          placeholder={t('op.needsFile')}
          className={clsx(
            'field max-h-28 min-h-[2rem] flex-1 resize-y border-transparent bg-transparent font-mono !text-[12px] leading-relaxed',
            editing && 'border-warn/50',
          )}
        />

        <div className="flex shrink-0 items-center gap-1">
          {editing && (
            <button
              type="button"
              className="btn btn-ghost !py-1 !text-[11px]"
              title={t('command.reset')}
              onClick={() => setCommandOverride(null)}
            >
              <Icon name="Undo2" size={13} />
              {t('command.reset')}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon" title={t('command.copy')} onClick={copy}>
            <Icon name={copied ? 'Check' : 'Copy'} size={14} />
          </button>
        </div>
      </div>

      {editing && (
        <p className="px-3 pb-1.5 text-[11px] text-warn">{t('command.edited')}</p>
      )}
      {built && built.missing.length > 0 && (
        <p className="px-3 pb-1.5 text-[11px] text-warn">
          {t('command.missing', { what: built.missing.join(', ') })}
        </p>
      )}
    </div>
  )
}
