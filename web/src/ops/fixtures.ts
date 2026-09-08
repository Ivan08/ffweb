/**
 * Shared setup for the project tests.
 *
 * Every project is built from the same imaginary footage so a failure points at
 * the thing being tested rather than at whatever the test happened to feed it.
 */

import { buildProject, type BuiltCommand } from '../core/build'
import { DEFAULT_QUALITY } from '../core/containers'
import { defaultParams, type Params } from '../core/ops'
import {
  clipOf,
  emptyProject,
  fileOverlay,
  soundOf,
  textOverlay,
  type Clip,
  type EffectId,
  type EffectItem,
  type Overlay,
  type Project,
  type Sound,
} from '../core/project'
import type { EngineId, MediaFile, MediaInfo } from '../core/types'
import { EFFECTS, getOp } from './index'

export const SOURCE_INFO: MediaInfo = {
  duration: 30,
  size: 12_000_000,
  bit_rate: 3_200_000,
  format_name: 'mov,mp4,m4a',
  width: 1920,
  height: 1080,
  fps: 25,
  video_codec: 'h264',
  audio_codec: 'aac',
  has_video: true,
  has_audio: true,
  raw: {},
}

export const PRIMARY: MediaFile = {
  id: 'f1',
  path: '/clips/holiday.mp4',
  name: 'holiday.mp4',
  size: 12_000_000,
  info: SOURCE_INFO,
}

export const SECOND: MediaFile = {
  id: 'f2',
  path: '/clips/second.mp4',
  name: 'second.mp4',
  size: 6_000_000,
  info: { ...SOURCE_INFO, duration: 12 },
}

/** A clip with no soundtrack, for the silence-padding path. */
export const SILENT: MediaFile = {
  id: 'f3',
  path: '/clips/screen.mp4',
  name: 'screen.mp4',
  size: 3_000_000,
  info: { ...SOURCE_INFO, duration: 8, has_audio: false, audio_codec: null },
}

export const MUSIC: MediaFile = {
  id: 'f4',
  path: '/clips/music.mp3',
  name: 'music.mp3',
  size: 4_000_000,
  info: { ...SOURCE_INFO, duration: 90, has_video: false, width: null, height: null },
}

export const LOGO: MediaFile = {
  id: 'f5',
  path: '/clips/logo.png',
  name: 'logo.png',
  size: 20_000,
  info: { ...SOURCE_INFO, duration: 0, has_audio: false, has_video: true, width: 400, height: 400 },
}

export const SUBS: MediaFile = {
  id: 'f6',
  path: '/clips/subs.srt',
  name: 'subs.srt',
  size: 4_000,
  info: undefined,
}

export const FILES: MediaFile[] = [PRIMARY, SECOND, SILENT, MUSIC, LOGO, SUBS]

/** A clip covering the whole of a file, with a predictable id. */
export function clip(file: MediaFile, patch: Partial<Clip> = {}): Clip {
  return { ...clipOf(`c-${file.id}`, file), ...patch }
}

/** A project holding one untouched clip of the primary file. */
export function project(patch: Partial<Project> = {}): Project {
  return { ...emptyProject(), clips: [clip(PRIMARY)], ...patch }
}

/** A file laid over the picture, with everything but the timing defaulted. */
export function overlay(uid: string, file: MediaFile, patch: Partial<Overlay> = {}): Overlay {
  return { ...fileOverlay(uid, file, 30), ...patch }
}

/** A caption drawn on the picture. */
export function caption(uid: string, text: string, patch: Partial<Overlay> = {}): Overlay {
  return { ...textOverlay(uid, text, 30), ...patch }
}

/** A sound laid on the timeline. */
export function sound(uid: string, file: MediaFile, patch: Partial<Sound> = {}): Sound {
  return { ...soundOf(uid, file), ...patch }
}

export function effect(op: EffectId, params: Params = {}): EffectItem {
  return {
    uid: `e-${op}`,
    op,
    params: { ...defaultParams(getOp(op)), ...params },
    enabled: true,
  }
}

export function build(
  input: Project,
  options: { files?: MediaFile[]; engine?: EngineId } = {},
): BuiltCommand {
  return buildProject({
    project: input,
    files: options.files ?? FILES,
    engine: options.engine ?? 'native',
  })
}

/** Read the value that follows a flag, e.g. `argAfter(args, '-vf')`. */
export function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** The `-filter_complex` graph, split into its chunks. */
export function graphChunks(args: string[]): string[] {
  const graph = argAfter(args, '-filter_complex')
  return graph ? graph.split(';') : []
}

export { DEFAULT_QUALITY, EFFECTS }
