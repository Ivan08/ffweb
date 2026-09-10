/**
 * What happens to the finished timeline as a whole.
 *
 * Fading in and out belongs to the result, not to any one clip: it is measured
 * from the start and the end of everything, and it moves when a clip is added.
 * That is why it is not an effect — effects are per-frame and leave the length
 * alone — and why it is here rather than in the inspector, which always shows
 * one selected thing.
 *
 * It is not in the export dialog either. A fade changes the picture, so it is
 * an edit, and an edit has to be visible while the timeline is being built
 * rather than asked about once at the end.
 */

import { timelineDuration } from '../core/project'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Icon, Slider } from './controls'

/** Longest fade offered, in seconds. Beyond this it is a transition, not a fade. */
const LONGEST = 10

export function ResultPanel() {
  const { t } = useT()
  const project = useStore((state) => state.project)
  const setFade = useStore((state) => state.setFade)

  if (project.clips.length === 0) return null

  const duration = timelineDuration(project)
  // A fade-out longer than the result is dropped by the builder rather than
  // guessed at, so the control says so instead of letting it look applied.
  const tooLong = project.fadeOut > 0 && duration > 0 && duration <= project.fadeOut

  return (
    <section className="panel mb-3">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Icon name="Blend" size={15} className="text-accent" />
        <h2 className="section-title">{t('result.title')}</h2>
      </div>

      <div className="grid gap-2.5 px-3 pb-3">
        <Slider
          label={t('result.fadeIn')}
          value={project.fadeIn}
          min={0}
          max={LONGEST}
          step={0.1}
          unit={t('unit.seconds')}
          onChange={(fadeIn) => setFade(fadeIn, project.fadeOut)}
        />
        <Slider
          label={t('result.fadeOut')}
          value={project.fadeOut}
          min={0}
          max={LONGEST}
          step={0.1}
          unit={t('unit.seconds')}
          onChange={(fadeOut) => setFade(project.fadeIn, fadeOut)}
        />
        <p className="text-[11px] text-faint">
          {tooLong ? t('result.fadeTooLong') : t('result.fadeHint')}
        </p>
      </div>
    </section>
  )
}
