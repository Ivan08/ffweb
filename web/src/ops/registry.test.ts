/**
 * Invariants every effect has to satisfy.
 *
 * Effects are data, and the interface renders them generically, so a malformed
 * entry produces a broken panel rather than a compile error. These tests are
 * what turns that back into a build failure.
 */

import { describe, expect, it } from 'vitest'

import { availability, EFFECTS, getOp, OPS, projectFilters } from './index'
import { WASM_ENCODERS, WASM_FILTERS } from '../core/containers'
import { defaultParams } from '../core/ops'
import { emptyProject, type EffectId } from '../core/project'
import { en } from '../i18n/en'
import { ru } from '../i18n/ru'
import { ICONS } from '../ui/icons'
import type { NativeCapabilities } from '../core/types'
import { clip, effect, FILES, LOGO, MUSIC, overlay, PRIMARY, project, SECOND, SILENT, sound } from './fixtures'

/** A machine with a full ffmpeg build. */
const RICH_NATIVE: NativeCapabilities = {
  available: true,
  ffprobe: true,
  path: '/usr/bin/ffmpeg',
  version: 'ffmpeg version 8.0.1',
  versionNumber: '8.0.1',
  encoders: [
    'libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'mpeg4', 'gif', 'png', 'mjpeg', 'libwebp',
    'aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'pcm_s16le', 'mov_text', 'srt', 'webvtt',
  ],
  decoders: [],
  filters: [...WASM_FILTERS, 'subtitles', 'hqdn3d', 'unsharp', 'gblur', 'transpose', 'eq'],
  muxers: [],
  hwaccels: [],
}

describe('the effect registry', () => {
  it('has no duplicate ids', () => {
    const ids = OPS.map((op) => op.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('can look every effect up by id', () => {
    for (const op of OPS) expect(getOp(op.id)).toBe(op)
  })

  it('names an icon the interface actually bundles', () => {
    // Icons are named as strings, so a typo would render nothing at all.
    for (const op of OPS) {
      expect(ICONS[op.icon], `${op.id} uses icon "${op.icon}"`).toBeTruthy()
    }
  })

  it('gives every effect a filter builder', () => {
    for (const op of EFFECTS) {
      expect(op.filters, `${op.id} has no filters()`).toBeTypeOf('function')
      expect(op.build, `${op.id} must not build a command of its own`).toBeUndefined()
      expect(op.extraInputs, `${op.id} cannot take extra inputs`).toBe(0)
    }
  })

  it('covers the whole published list of effects', () => {
    const expected: EffectId[] = [
      'resizecompress', 'crop', 'rotate', 'pad', 'adjust', 'denoise', 'sharpenblur',
    ]
    expect(EFFECTS.map((op) => op.id).sort()).toEqual([...expected].sort())
  })

  /**
   * The rule the whole timeline rests on.
   *
   * An overlay says "from three seconds to seven". Those seconds are counted on
   * the finished picture, so if an effect could stretch time — `setpts`,
   * `atempo`, `reverse` — every overlay would silently point at the wrong
   * moment and nothing would fail. Speed, reversal and repeats are properties of
   * a clip precisely so that this list can stay clean.
   */
  it('has no effect that moves anything in time', () => {
    const forbidden = ['setpts', 'atempo', 'areverse', 'reverse', 'trim=', 'atrim=', 'loop=']
    for (const op of EFFECTS) {
      const fragments = op.filters!(defaultParams(op), {
        container: 'mp4',
        engine: 'native',
        duration: 30,
        inputCount: 1,
        source: PRIMARY.info,
      })
      for (const fragment of [...(fragments.video ?? []), ...(fragments.audio ?? [])]) {
        for (const filter of forbidden) {
          expect(fragment.includes(filter), `${op.id} emits "${fragment}"`).toBe(false)
        }
      }
    }
  })

  it('has no effect that touches the sound', () => {
    // The soundtrack is a track, with its own level and levelling. An audio
    // fragment here would be a second place to set the volume.
    for (const op of EFFECTS) {
      const fragments = op.filters!(defaultParams(op), {
        container: 'mp4',
        engine: 'native',
        duration: 30,
        inputCount: 1,
        source: PRIMARY.info,
      })
      expect(fragments.audio ?? [], `${op.id} emits audio filters`).toEqual([])
    }
  })
})

describe('effect parameters', () => {
  const withParams = OPS.filter((op) => op.params.length > 0)

  it('uses each parameter key only once per effect', () => {
    for (const op of withParams) {
      const keys = op.params.map((spec) => spec.key)
      expect(new Set(keys).size, `${op.id} repeats a parameter key`).toBe(keys.length)
    }
  })

  it('gives every parameter a default of the right type', () => {
    for (const op of withParams) {
      for (const spec of op.params) {
        const expected =
          spec.kind === 'toggle'
            ? 'boolean'
            : spec.kind === 'number' || spec.kind === 'slider'
              ? 'number'
              : 'string'
        expect(typeof spec.default, `${op.id}.${spec.key} (${spec.kind})`).toBe(expected)
      }
    }
  })

  it('keeps slider bounds sane and the default inside them', () => {
    for (const op of withParams) {
      for (const spec of op.params) {
        if (spec.kind !== 'slider') continue
        expect(spec.min, `${op.id}.${spec.key}`).toBeLessThan(spec.max)
        expect(spec.step, `${op.id}.${spec.key}`).toBeGreaterThan(0)
        expect(spec.default, `${op.id}.${spec.key}`).toBeGreaterThanOrEqual(spec.min)
        expect(spec.default, `${op.id}.${spec.key}`).toBeLessThanOrEqual(spec.max)
      }
    }
  })

  it('offers a default that is one of the options', () => {
    for (const op of withParams) {
      for (const spec of op.params) {
        if (spec.kind !== 'select') continue
        expect(spec.options.length, `${op.id}.${spec.key} has no options`).toBeGreaterThan(1)
        const values = spec.options.map((option) => option.value)
        expect(values, `${op.id}.${spec.key}`).toContain(spec.default)
        expect(new Set(values).size, `${op.id}.${spec.key} repeats an option`).toBe(values.length)
      }
    }
  })

  it('produces defaults for every declared parameter', () => {
    for (const op of withParams) {
      const params = defaultParams(op)
      for (const spec of op.params) {
        expect(params[spec.key], `${op.id}.${spec.key}`).toBeDefined()
      }
    }
  })
})

describe('what an engine can run', () => {
  it('allows every effect on a full ffmpeg build', () => {
    for (const op of OPS) {
      const status = availability(op, 'native', RICH_NATIVE)
      expect(status.available, `${op.id} needs ${status.missing.join(', ')}`).toBe(true)
    }
  })

  it('names what is missing rather than failing silently', () => {
    const bare: NativeCapabilities = { ...RICH_NATIVE, encoders: [], filters: [] }
    const status = availability(getOp('denoise'), 'native', bare)
    expect(status.available).toBe(false)
    expect(status.missing).toContain('hqdn3d')
  })

  it('measures the browser engine against the wasm build, not the local one', () => {
    const bare: NativeCapabilities = { ...RICH_NATIVE, encoders: [], filters: [] }
    for (const op of OPS) {
      const status = availability(op, 'wasm', bare)
      for (const missing of status.missing) {
        expect([...WASM_ENCODERS, ...WASM_FILTERS]).not.toContain(missing)
      }
    }
  })

  /**
   * A project assembles a graph out of parts no single effect declares, so the
   * requirement has to come from the project. Without this the browser engine
   * accepts a timeline it cannot run and fails somewhere in the middle of it.
   */
  it('works out what a whole project needs', () => {
    const joined = project({ clips: [clip(PRIMARY), clip(SILENT)] })
    expect(projectFilters(joined, FILES)).toContain('concat')
    expect(projectFilters(joined, FILES)).toContain('anullsrc')

    const withMusic = project({
      sounds: [sound('s1', MUSIC, { at: 4, in: 0, out: 20 })],
    })
    expect(projectFilters(withMusic, FILES)).toContain('adelay')
    expect(projectFilters(withMusic, FILES)).toContain('amix')

    const withLogo = project({
      overlays: [overlay('o1', LOGO, { x: 0.5, y: 0.5, scale: 0.2, opacity: 1, from: 1, to: 2 })],
    })
    expect(projectFilters(withLogo, FILES)).toContain('overlay')
    expect(projectFilters(withLogo, FILES)).toContain('scale2ref')

    const spedUp = project({ clips: [clip(PRIMARY, { speed: 2 }), clip(SECOND)] })
    expect(projectFilters(spedUp, FILES)).toContain('atempo')

    // The simple case needs nothing beyond what the effects themselves declare.
    expect(projectFilters(project(), FILES)).toEqual([])
    expect(projectFilters(project({ effects: [effect('denoise')] }), FILES)).toContain('hqdn3d')
  })

  it('can run every project shape in the browser', () => {
    const shapes = [
      project(),
      project({ clips: [clip(PRIMARY), clip(SECOND)] }),
      project({ clips: [clip(PRIMARY), clip(SILENT)] }),
      project({ clips: [clip(PRIMARY, { speed: 2, reverse: true, loop: 2, boomerang: true })] }),
      project({ sounds: [sound('s1', MUSIC, { at: 3, in: 0, out: 9 })] }),
      project({ audio: { ...emptyProject().audio, gain: 3, normalize: true } }),
      project({ overlays: [overlay('o1', LOGO, { x: 0.5, y: 0.5, scale: 0.2, opacity: 0.5, from: 1, to: 2 })] }),
      project({ fadeIn: 1, fadeOut: 1 }),
      project({ target: 'gif' }),
      project({ target: 'still' }),
    ]
    for (const shape of shapes) {
      const missing = projectFilters(shape, FILES).filter((filter) => !WASM_FILTERS.includes(filter))
      expect(missing, `browser engine is missing ${missing.join(', ')}`).toEqual([])
    }
  })

  it('admits that burning subtitles needs libass, which the browser core lacks', () => {
    const burnt = project({ subtitles: { fileId: 'f6', mode: 'burn', fontSize: 24 } })
    expect(projectFilters(burnt, FILES)).toContain('subtitles')
    expect(WASM_FILTERS).not.toContain('subtitles')
  })

  it('names the filters a dissolve needs, whether or not the browser has them', () => {
    // Nobody here has established that the published browser core ships
    // `xfade`, and this list is a promise rather than a probe: putting it in
    // on a hunch would mean accepting a timeline and then dying part way
    // through the encode. Left out, the engine says so before anything runs,
    // exactly as it does for burnt-in subtitles.
    const dissolved = project({
      clips: [clip(PRIMARY), clip(SECOND, { transition: { duration: 1, kind: 'fade' } })],
    })
    const needed = projectFilters(dissolved, FILES)
    expect(needed).toContain('xfade')
    expect(needed).toContain('acrossfade')
    expect(WASM_FILTERS).not.toContain('xfade')
  })
})

describe('translations', () => {
  const both = (key: string, what: string) => {
    expect(en[key as keyof typeof en], `English is missing ${key} (${what})`).toBeTruthy()
    expect(ru[key as keyof typeof en], `Russian is missing ${key} (${what})`).toBeTruthy()
  }

  it('names every effect in both languages', () => {
    for (const op of OPS) both(`op.${op.id}`, 'effect name')
  })

  it('labels every parameter in both languages', () => {
    for (const op of OPS) {
      for (const spec of op.params) both(`p.${op.id}.${spec.key}`, 'parameter label')
    }
  })

  it('names every export target and its explanation in both languages', () => {
    for (const target of ['video', 'gif', 'audio', 'still']) {
      both(`target.${target}`, 'export target')
      both(`target.${target}.hint`, 'export target hint')
    }
  })

  it('keeps the two dictionaries in step', () => {
    // Russian falls back to English, so an extra Russian key is a typo, and a
    // translated string that lost its English original is a broken fallback.
    for (const key of Object.keys(ru)) {
      expect(en[key as keyof typeof en], `${key} exists only in Russian`).toBeDefined()
    }
  })

  it('says everything in Russian too, not only what an effect needs', () => {
    // The checks above cover effect, parameter and target keys. Everything
    // else — panels, tooltips, warnings — was covered by nothing, and a
    // forgotten Russian string compiles and falls back to English silently.
    // The screenshots are taken in Russian, so it would ship in a picture.
    const missing = Object.keys(en).filter((key) => !(key in ru))
    expect(missing, `no Russian for: ${missing.join(', ')}`).toEqual([])
  })

  it('translates an option label wherever one language bothered to', () => {
    for (const op of OPS) {
      for (const spec of op.params) {
        if (spec.kind !== 'select') continue
        for (const option of spec.options) {
          const key = (
            spec.key === 'position' ? `o.position.${option.value}` : `o.${op.id}.${spec.key}.${option.value}`
          ) as keyof typeof en
          if (en[key] || ru[key]) {
            expect(en[key], `English is missing ${key}`).toBeTruthy()
            expect(ru[key], `Russian is missing ${key}`).toBeTruthy()
          }
        }
      }
    }
  })
})
