/**
 * Hand the generated commands to the server's own validator.
 *
 * The frontend builds the arguments and the Rust server decides whether to run
 * them, and the two enforce that contract in different languages. A rule that
 * tightens on one side and not the other produces a UI that cheerfully composes
 * commands the server then refuses — which no test on either side alone can
 * see. So this writes out every command a project can produce, and a Rust test
 * reads the same file back and validates it.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CONTAINERS } from '../core/containers'
import { emptyProject, type ExportTarget, type Project } from '../core/project'
import {
  build, clip, effect, FILES, LOGO, MUSIC, overlay, PRIMARY, project, SECOND, SILENT, sound, SUBS,
} from './fixtures'
import { projectFilters } from './index'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '__fixtures__', 'commands.json')
const FILTERS = join(here, '__fixtures__', 'filters.json')

const TARGETS: ExportTarget[] = ['video', 'gif', 'audio', 'still']

const SHAPES: Array<[string, Project]> = [
  ['one clip', project()],
  ['trimmed', project({ clips: [clip(PRIMARY, { in: 2, out: 9 })] })],
  ['joined', project({ clips: [clip(PRIMARY), clip(SECOND)] })],
  ['joined with a silent clip', project({ clips: [clip(PRIMARY), clip(SILENT)] })],
  ['side by side', project({ clips: [clip(PRIMARY), clip(SECOND)], layout: 'side-by-side' })],
  ['sped up', project({ clips: [clip(PRIMARY, { speed: 2 })] })],
  ['reversed', project({ clips: [clip(PRIMARY, { reverse: true })] })],
  ['repeated', project({ clips: [clip(PRIMARY, { loop: 3 })] })],
  ['there and back', project({ clips: [clip(PRIMARY, { boomerang: true })] })],
  ['silent', project({ audio: { ...emptyProject().audio, source: 'none' } })],
  [
    'another soundtrack',
    project({ audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 3, in: 0, out: 20 })] }),
  ],
  [
    'a soundtrack mixed in',
    project({
      sounds: [sound('s1', MUSIC, { at: 0, in: 0, out: 20 })],
    }),
  ],
  ['levelled', project({ audio: { ...emptyProject().audio, gain: 4, normalize: true } })],
  [
    'an overlay',
    project({
      overlays: [overlay('o1', LOGO, { x: 0.9, y: 0.9, scale: 0.25, opacity: 0.8, from: 1, to: 3 })],
    }),
  ],
  [
    'two overlays',
    project({
      overlays: [
        overlay('o1', LOGO, { x: 0.1, y: 0.1, scale: 0.2, opacity: 1, from: 0, to: 2 }),
        overlay('o2', SECOND, { x: 0.6, y: 0.6, scale: 0.3, opacity: 0.5, from: 2, to: 5 }),
      ],
    }),
  ],
  ['faded', project({ fadeIn: 1, fadeOut: 2 })],
  ['burnt-in subtitles', project({ subtitles: { fileId: SUBS.id, mode: 'burn', fontSize: 28 } })],
  ['stripped of metadata', project({ stripMeta: true })],
  [
    'effects',
    project({ effects: [effect('adjust'), effect('resizecompress'), effect('crop', { w: 640, h: 480, x: 8, y: 8 })] }),
  ],
]

describe('the commands the server has to accept', () => {
  it('writes them out for the Rust validator to check', () => {
    const commands: Array<{ label: string; inputs: number; args: string[] }> = []

    const add = (label: string, args: string[]) => {
      if (args.length === 0) return
      const inputs = new Set(
        args.flatMap((arg) => Array.from(arg.matchAll(/@in(\d+)/g), (match) => Number(match[1]))),
      )
      commands.push({ label, inputs: inputs.size, args })
    }

    for (const [label, shape] of SHAPES) {
      for (const target of TARGETS) {
        add(`${label} → ${target}`, build({ ...shape, target }).args)
      }
      for (const container of CONTAINERS) {
        add(`${label} → ${container.ext}`, build({ ...shape, container: container.ext }).args)
      }
    }

    mkdirSync(dirname(FIXTURE), { recursive: true })
    writeFileSync(FIXTURE, `${JSON.stringify(commands, null, 2)}\n`)

    // The Rust side asserts a floor of its own, so a shrinking matrix cannot
    // quietly turn the contract test into a no-op.
    expect(commands.length).toBeGreaterThan(100)
  })

  /**
   * The other half of the contract, and one that bit.
   *
   * The interface refuses to run a project whose filters this ffmpeg lacks, and
   * it asks the server which filters there are. The server only reports the
   * ones it was told to look for — so a filter the graph uses but that list
   * omits reads as *missing on every machine*, and the Run button is dead with
   * no explanation. Writing the vocabulary out lets a Rust test check the two
   * lists against each other.
   */
  it('writes out every filter a project can ask for', () => {
    const vocabulary = new Set<string>()
    for (const [, shape] of SHAPES) {
      for (const target of TARGETS) {
        for (const filter of projectFilters({ ...shape, target }, FILES)) vocabulary.add(filter)
      }
    }

    const sorted = [...vocabulary].sort()
    mkdirSync(dirname(FILTERS), { recursive: true })
    writeFileSync(FILTERS, `${JSON.stringify(sorted, null, 2)}\n`)

    expect(sorted.length).toBeGreaterThan(10)
  })
})
