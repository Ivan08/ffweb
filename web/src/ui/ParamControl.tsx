/**
 * One operation parameter, rendered from its declaration.
 *
 * Keeping this generic is what lets an operation be defined purely as data:
 * adding one needs no interface work at all.
 */

import type { ParamSpec, Params } from '../core/ops'
import { useT } from '../i18n'
import { Field, Slider, Toggle } from './controls'

export function ParamControl({
  opId,
  spec,
  params,
  onChange,
  inputOptions,
  disabledOptions,
}: {
  opId: string
  spec: ParamSpec
  params: Params
  onChange: (key: string, value: Params[string]) => void
  /** Files available for `input` parameters. */
  inputOptions?: Array<{ value: string; label: string }>
  /** Option values to disable, with the reason as the title. */
  disabledOptions?: Record<string, string>
}) {
  const { t, tOr } = useT()
  const label = tOr(`p.${opId}.${spec.key}`, spec.key)
  const value = params[spec.key]

  switch (spec.kind) {
    case 'toggle':
      return (
        <Toggle
          label={label}
          checked={typeof value === 'boolean' ? value : spec.default}
          onChange={(next) => onChange(spec.key, next)}
        />
      )

    case 'slider':
      return (
        <Slider
          label={label}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          unit={spec.unit}
          value={typeof value === 'number' ? value : spec.default}
          onChange={(next) => onChange(spec.key, next)}
        />
      )

    case 'select':
      return (
        <Field label={label}>
          <select
            className="field"
            value={String(value ?? spec.default)}
            onChange={(event) => onChange(spec.key, event.target.value)}
          >
            {spec.options.map((option) => {
              const disabledReason = disabledOptions?.[option.value]
              const optionLabel =
                option.label ??
                // Positions are shared between operations, so they live under a
                // common key rather than being repeated per operation.
                (spec.key === 'position'
                  ? tOr(`o.position.${option.value}`, option.value)
                  : tOr(`o.${opId}.${spec.key}.${option.value}`, option.value))
              return (
                <option key={option.value} value={option.value} disabled={Boolean(disabledReason)}>
                  {optionLabel}
                  {disabledReason ? ` — ${disabledReason}` : ''}
                </option>
              )
            })}
          </select>
        </Field>
      )

    case 'number':
      return (
        <Field label={spec.unit ? `${label}, ${spec.unit}` : label}>
          <input
            type="number"
            className="field font-mono"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            placeholder={spec.placeholder}
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
            onChange={(event) =>
              onChange(spec.key, event.target.value === '' ? '' : Number(event.target.value))
            }
          />
        </Field>
      )

    case 'text':
      return (
        <Field label={label}>
          {spec.multiline ? (
            <textarea
              className="field min-h-[5.5rem] resize-y font-mono leading-relaxed"
              spellCheck={false}
              placeholder={spec.placeholder}
              value={String(value ?? '')}
              onChange={(event) => onChange(spec.key, event.target.value)}
            />
          ) : (
            <input
              type="text"
              className="field font-mono"
              spellCheck={false}
              placeholder={spec.placeholder}
              value={String(value ?? '')}
              onChange={(event) => onChange(spec.key, event.target.value)}
            />
          )}
        </Field>
      )

    case 'input':
      return (
        <Field label={label} hint={inputOptions?.length ? undefined : t('op.needsSecond')}>
          <select
            className="field"
            value={String(value ?? '')}
            onChange={(event) => onChange(spec.key, event.target.value)}
          >
            <option value="">—</option>
            {(inputOptions ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      )
  }
}
