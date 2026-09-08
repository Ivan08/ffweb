/**
 * The effect chain.
 *
 * There used to be two places an effect could live — "selected" in a grid on
 * the right, and "stacked" in a list in the centre — and the same effect could
 * be in both at once, with a rule buried in the builder deciding which won.
 * There is one list now. Adding is explicit, and what you see is what runs.
 *
 * Everything here composes into a single filter chain, so seven adjustments
 * still cost one re-encode.
 */

import { useState } from 'react'
import clsx from 'clsx'

import { hasPicture, type EffectId } from '../core/project'
import { useT } from '../i18n'
import { availability, EFFECTS, getOp } from '../ops'
import { useStore } from '../store'
import { Icon } from './controls'
import { ParamControl } from './ParamControl'

export function EffectsPanel() {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const files = useStore((state) => state.files)
  const engine = useStore((state) => state.engine)
  const capabilities = useStore((state) => state.capabilities)
  const addEffect = useStore((state) => state.addEffect)
  const removeEffect = useStore((state) => state.removeEffect)
  const moveEffect = useStore((state) => state.moveEffect)
  const toggleEffect = useStore((state) => state.toggleEffect)
  const setEffectParam = useStore((state) => state.setEffectParam)

  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const native = capabilities?.native

  // Every effect works on the picture — the soundtrack has its own level and
  // levelling on its own track. Offering them over an audio-only timeline, or
  // when the export is sound alone, was the interface saying that processing
  // is the same for both when it is not: the filters would simply be dropped.
  const picture = hasPicture(project, files)
  const applies = picture && project.target !== 'audio'

  return (
    <section className="panel mb-3">
      <div className="flex items-center gap-2 px-3 py-2">
        <h2 className="section-title flex-1">{t('effects.title')}</h2>
        <button
          type="button"
          className="btn !py-1 !text-[11px]"
          disabled={!applies}
          onClick={() => setAdding((open) => !open)}
        >
          <Icon name={adding ? 'X' : 'Plus'} size={12} />
          {adding ? t('effects.cancel') : t('effects.add')}
        </button>
      </div>

      {!applies && (
        <p className="mx-3 mb-2 rounded-md border border-line bg-panel-2 px-2.5 py-2 text-[11px] leading-snug text-dim">
          {picture ? t('effects.audioTarget') : t('effects.noPicture')}
        </p>
      )}

      {adding && applies && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-1 px-2 pb-2">
          {EFFECTS.map((def) => {
            const status = native ? availability(def, engine, native) : { available: true, missing: [] }
            return (
              <button
                key={def.id}
                type="button"
                disabled={!status.available}
                title={
                  status.available ? undefined : t('op.unavailable', { what: status.missing.join(', ') })
                }
                onClick={() => {
                  addEffect(def.id as EffectId)
                  setAdding(false)
                }}
                className={clsx(
                  'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                  status.available
                    ? 'text-dim hover:bg-panel-2 hover:text-ink'
                    : 'cursor-not-allowed text-faint opacity-45',
                )}
              >
                <Icon name={def.icon} size={13} />
                <span className="truncate">{t(`op.${def.id}`)}</span>
              </button>
            )
          })}
        </div>
      )}

      {project.effects.length === 0 ? (
        applies && <p className="px-3 pb-3 text-[12px] text-faint">{t('effects.empty')}</p>
      ) : (
        <ul className="px-1.5 pb-2">
          {project.effects.map((item, index) => {
            const def = getOp(item.op)
            const open = expanded === item.uid
            return (
              <li key={item.uid} className="mb-1 rounded-md border border-line bg-panel-2">
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <Icon
                    name={def.icon}
                    size={14}
                    className={item.enabled ? 'text-accent' : 'text-faint'}
                  />
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : item.uid)}
                    className={clsx(
                      'flex-1 text-left text-[13px]',
                      item.enabled && applies ? 'text-ink' : 'text-faint line-through',
                    )}
                    // An effect already in the chain is not deleted when the
                    // export turns to sound — it simply has nothing to act on,
                    // and says so rather than looking as though it applies.
                    title={applies ? undefined : t('effects.notApplied')}
                  >
                    {t(`op.${item.op}`)}
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={item.enabled ? t('stack.disable') : t('stack.enable')}
                    onClick={() => toggleEffect(item.uid)}
                  >
                    <Icon name={item.enabled ? 'Eye' : 'EyeOff'} size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={t('stack.up')}
                    disabled={index === 0}
                    onClick={() => moveEffect(item.uid, -1)}
                  >
                    <Icon name="ChevronUp" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={t('stack.down')}
                    disabled={index === project.effects.length - 1}
                    onClick={() => moveEffect(item.uid, 1)}
                  >
                    <Icon name="ChevronDown" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={t('stack.remove')}
                    onClick={() => removeEffect(item.uid)}
                  >
                    <Icon name="X" size={13} />
                  </button>
                </div>

                {open && def.params.length > 0 && (
                  <div className="grid gap-2.5 border-t border-line px-3 py-2.5 sm:grid-cols-2">
                    {def.params.map((spec) => (
                      <ParamControl
                        key={spec.key}
                        opId={def.id}
                        spec={spec}
                        params={item.params}
                        onChange={(key, value) => setEffectParam(item.uid, key, value)}
                      />
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
