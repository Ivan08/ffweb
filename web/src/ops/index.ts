/** The effect registry, and what a given engine can actually run. */

import { WASM_ENCODERS, WASM_FILTERS } from '../core/containers'
import { isTrivial, type Project } from '../core/project'
import type { EngineId, MediaFile, NativeCapabilities } from '../core/types'
import type { OpDef, OpId } from '../core/ops'
import { EFFECTS } from './effects'

export const OPS: OpDef[] = EFFECTS

const BY_ID = new Map<OpId, OpDef>(OPS.map((op) => [op.id, op]))

export function getOp(id: OpId): OpDef {
  const op = BY_ID.get(id)
  if (!op) throw new Error(`unknown operation: ${id}`)
  return op
}

/** Hard-burning subtitles needs libass, which the published wasm core lacks. */
export function canBurnSubtitles(engine: EngineId, native: NativeCapabilities): boolean {
  return engine === 'native' && native.filters.includes('subtitles')
}

export interface Availability {
  available: boolean
  /** Names of the components that are missing, for the tooltip. */
  missing: string[]
}

function componentsOf(engine: EngineId, native: NativeCapabilities) {
  return {
    encoders: engine === 'wasm' ? WASM_ENCODERS : native.encoders,
    filters: engine === 'wasm' ? WASM_FILTERS : native.filters,
  }
}

/**
 * Whether one effect can run on a given engine. The wasm core ships a reduced
 * build — notably without libass — so telling the user up front beats failing
 * three minutes into an encode.
 */
export function availability(op: OpDef, engine: EngineId, native: NativeCapabilities): Availability {
  const { encoders, filters } = componentsOf(engine, native)
  const missing: string[] = []

  for (const encoder of op.requires?.encoders ?? []) {
    if (!encoders.includes(encoder)) missing.push(encoder)
  }
  for (const filter of op.requires?.filters ?? []) {
    if (!filters.includes(filter)) missing.push(filter)
  }
  return { available: missing.length === 0, missing }
}

/**
 * Every filter a project will ask for.
 *
 * The old model could check each operation on its own, because an operation was
 * the whole job. A project assembles a graph out of parts that no single
 * operation declares, so the requirement has to be derived from the project
 * itself — otherwise the browser engine accepts a timeline it cannot run and
 * fails somewhere in the middle of it.
 */
export function projectFilters(project: Project, files: MediaFile[]): string[] {
  const needed = new Set<string>()

  if (!isTrivial(project)) {
    for (const filter of ['scale', 'pad', 'setsar', 'fps', 'asetpts', 'aformat']) needed.add(filter)
  }
  if (project.clips.length > 1) {
    needed.add(project.layout === 'side-by-side' ? (project.stackDirection === 'vertical' ? 'vstack' : 'hstack') : 'concat')
  }
  for (const clip of project.clips) {
    if (clip.reverse) {
      needed.add('reverse')
      needed.add('areverse')
    }
    if (clip.speed > 0 && Math.abs(clip.speed - 1) > 0.001) {
      needed.add('setpts')
      needed.add('atempo')
    }
    if (clip.boomerang) {
      needed.add('split')
      needed.add('asplit')
      needed.add('reverse')
      needed.add('concat')
    }
    if (Math.floor(clip.loop) > 1) {
      needed.add('split')
      needed.add('asplit')
    }
    const info = files.find((file) => file.id === clip.fileId)?.info
    if (info && !info.has_audio && project.clips.some((other) => files.find((f) => f.id === other.fileId)?.info?.has_audio)) {
      needed.add('anullsrc')
      needed.add('atrim')
    }
  }
  if (project.sounds.length > 0) {
    needed.add('atrim')
    if (project.sounds.some((sound) => sound.at > 0)) needed.add('adelay')
    if (project.sounds.some((sound) => sound.gain !== 0)) needed.add('volume')
    // One sound over the footage is already two things to mix.
    if (project.sounds.length + (project.audio.source === 'clips' ? 1 : 0) > 1) needed.add('amix')
  }
  if (project.audio.gain !== 0) needed.add('volume')
  if (project.audio.normalize) needed.add('loudnorm')
  const captions = project.overlays.filter((overlay) => overlay.text !== undefined)
  const laid = project.overlays.filter((overlay) => overlay.text === undefined)
  if (captions.length > 0) needed.add('drawtext')
  if (laid.length > 0) {
    needed.add('overlay')
    needed.add('scale2ref')
    if (laid.some((overlay) => overlay.opacity < 1)) needed.add('colorchannelmixer')
  }
  if (project.subtitles?.mode === 'burn') needed.add('subtitles')
  if (project.fadeIn > 0 || project.fadeOut > 0) {
    needed.add('fade')
    needed.add('afade')
  }
  if (project.target === 'gif') {
    for (const filter of ['fps', 'scale', 'split', 'palettegen', 'paletteuse']) needed.add(filter)
  }
  if (project.target === 'still' && !isTrivial(project)) needed.add('select')

  for (const item of project.effects) {
    if (!item.enabled) continue
    for (const filter of getOp(item.op).requires?.filters ?? []) needed.add(filter)
  }

  return [...needed].sort()
}

/** Whether the engine can run the whole project. */
export function projectAvailability(
  project: Project,
  files: MediaFile[],
  engine: EngineId,
  native: NativeCapabilities,
): Availability {
  const { filters } = componentsOf(engine, native)
  const missing = projectFilters(project, files).filter((filter) => !filters.includes(filter))
  return { available: missing.length === 0, missing }
}

export { EFFECTS }
