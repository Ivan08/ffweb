/**
 * Assembling the ffmpeg command from a project.
 *
 * The output is an argument list using `@in0`/`@in1`/`@out` placeholders. The
 * native engine sends it to the server, which substitutes real paths; the wasm
 * engine substitutes virtual filesystem names. Both run exactly what the
 * command bar shows.
 *
 * Two paths lead out of here, and keeping both is the point. A project that is
 * one clip played straight, with its own sound and nothing on top, produces the
 * same flat `-ss / -i / -vf` command it always did — which is what leaves room
 * for a stream copy and a fast seek. Everything else builds one labelled graph.
 * A universal `-filter_complex` would have made the ordinary case slower than
 * the tool it replaced.
 */

import { codecArgs, findContainer } from './containers'
import { stemOf } from './format'
import { buildGraph, canvasOf, effectFragments } from './graph'
import { getOp } from '../ops'
import type { BuildContext } from './ops'
import { toNames } from './placeholders'
import {
  clipDuration,
  isStill,
  isTrivial,
  resolveInputs,
  sourceLength,
  timelineDuration,
  type ExportTarget,
  type Project,
} from './project'
import type { EngineId, MediaFile } from './types'

export interface BuildRequest {
  project: Project
  files: MediaFile[]
  engine: EngineId
}

export interface BuiltCommand {
  args: string[]
  /**
   * The same command with placeholders replaced by file names. Placeholders are
   * an implementation detail of handing the command to an engine safely; what
   * the user reads should be the command they could paste into a terminal.
   */
  display: string[]
  /** Output file name, extension included. */
  outputName: string
  /** Duration of the result, used for progress and size estimates. */
  duration?: number
  /** Parts of the project whose file is no longer in the list. */
  missing: string[]
}

/** One `-i` and whatever has to precede it. */
interface InputSlot {
  file: MediaFile
  /**
   * Options that belong to this input alone. `-ss`, `-t` and `-loop` are
   * per-input options: putting them all before the first `-i`, as the older
   * builder did, silently applied one clip's trim to every input.
   */
  pre: string[]
}

/** What the chosen target produces, for picking a container. */
function kindOf(target: ExportTarget): 'video' | 'audio' | 'image' {
  return target === 'audio' ? 'audio' : target === 'still' || target === 'gif' ? 'image' : 'video'
}

/**
 * The extension the result will have.
 *
 * The panel's container choice is honoured whenever it can produce the target,
 * and quietly replaced when it cannot: exporting a soundtrack into an mp4 would
 * otherwise make a video file with no picture.
 */
export function containerFor(target: ExportTarget, chosen: string): string {
  if (target === 'gif') return 'gif'
  const kind = kindOf(target)
  const container = findContainer(chosen)
  if (container && container.kind === kind) return chosen
  return kind === 'audio' ? 'mp3' : kind === 'image' ? 'jpg' : 'mp4'
}

export function outputNameFor(inputName: string, target: ExportTarget, ext: string): string {
  const stem = stemOf(inputName).replace(/[^\p{L}\p{N}._-]+/gu, '_')
  return `${stem}-${target}.${ext}`
}

/**
 * Where a still frame sits inside the source of a single-clip project.
 *
 * The playhead is a position on the timeline; the input wants a position in the
 * file, and the two differ by the clip's own start and speed.
 */
function stillInSource(project: Project): number {
  const [clip] = project.clips
  if (!clip) return 0
  const speed = clip.speed > 0 ? clip.speed : 1
  return clip.in + Math.max(0, project.still) * speed
}

export function buildProject(request: BuildRequest): BuiltCommand {
  const { project, files, engine } = request
  const inputs = resolveInputs(project, files)
  const primary = inputs.files[0]
  const duration = timelineDuration(project)

  if (!primary) {
    return { args: [], display: [], outputName: '', missing: inputs.missing }
  }

  const target = project.target
  const ext = containerFor(target, project.container)
  const container = findContainer(ext)
  const canvas = canvasOf(project, files)

  const context: BuildContext = {
    source: primary.info,
    container: ext,
    engine,
    duration,
    inputCount: inputs.files.length,
  }
  const effects = effectFragments(project.effects, (id) => getOp(id as never), context)

  const wantVideo = target !== 'audio'
  // There is sound to make if anything can make it: the footage's own, or any
  // laid on the timeline. Turning the footage's own off while a sound sits on
  // the track is how a soundtrack is replaced, and reading only the former left
  // that case silent.
  const ownSound =
    project.audio.source === 'clips' && project.clips.some((clip) => hasSound(clip.fileId, files))
  const wantAudio =
    target !== 'gif' && target !== 'still' && (ownSound || project.sounds.length > 0)

  const trivial = isTrivial(project)

  const args: string[] = []
  const slots: InputSlot[] = []
  const post: string[] = []
  const tail: string[] = []
  let ownsCodecs = false
  let dropsAudio = !wantAudio

  if (trivial) {
    // ---- The flat path: one clip, nothing layered on it. ----
    const [clip] = project.clips
    const pre: string[] = []
    const still = target === 'still'
    const start = still ? stillInSource(project) : clip.in
    if (start > 0) pre.push('-ss', start.toFixed(3))
    slots.push({ file: primary, pre })

    const full = primary.info?.duration ?? 0
    const trimmed = clip.in > 0 || (full > 0 && clip.out < full - 0.001)
    if (!still && trimmed && sourceLength(clip) > 0) {
      post.push('-t', sourceLength(clip).toFixed(3))
    }

    // An audio-only container has no picture to filter, and ffmpeg refuses
    // `-vn` together with `-vf`, so those fragments are dropped rather than
    // turned into a command it will reject.
    if (wantVideo && container?.kind !== 'audio') {
      const chain = [...effects.video]
      if (target === 'gif') {
        chain.push(`fps=${Math.min(canvas.fps, 15)}`, `scale=${Math.min(canvas.width, 480)}:-2:flags=lanczos`)
        tail.push(
          '-vf',
          `${chain.join(',')},split[gs0][gs1];[gs0]palettegen=stats_mode=diff[gp];` +
            '[gs1][gp]paletteuse=diff_mode=rectangle',
        )
      } else if (chain.length > 0) {
        tail.push('-vf', chain.join(','))
      }
    }
    if (wantAudio && effects.audio.length > 0) tail.push('-af', effects.audio.join(','))

    if (target === 'gif') {
      tail.push('-loop', '0', '-an')
      ownsCodecs = true
      dropsAudio = true
    } else if (still) {
      tail.push('-frames:v', '1', '-update', '1', '-an')
      ownsCodecs = true
      dropsAudio = true
    } else if (target === 'audio') {
      tail.push('-vn')
    } else if (!wantAudio) {
      tail.push('-an')
    }
  } else {
    // ---- The graph path. ----
    for (const clip of project.clips) {
      const file = files.find((candidate) => candidate.id === clip.fileId)
      if (!file) continue
      const pre: string[] = []
      if (isStill(file)) {
        // An unbounded image input leaves ffmpeg generating frames forever and
        // muddles the timestamps; bounding it costs nothing and ends the run.
        pre.push('-loop', '1', '-framerate', String(canvas.fps), '-t', clipDuration(clip).toFixed(3))
      } else {
        if (clip.in > 0) pre.push('-ss', clip.in.toFixed(3))
        if (sourceLength(clip) > 0) pre.push('-t', sourceLength(clip).toFixed(3))
      }
      slots.push({ file, pre })
    }
    for (const sound of project.sounds) {
      const index = inputs.sounds.get(sound.uid)
      if (index !== undefined) slots.push({ file: inputs.files[index], pre: [] })
    }
    for (const overlay of project.overlays) {
      const index = inputs.overlays.get(overlay.uid)
      if (index === undefined) continue
      const file = inputs.files[index]
      const pre = isStill(file)
        ? ['-loop', '1', '-framerate', String(canvas.fps), '-t', Math.max(0.04, duration).toFixed(3)]
        : []
      slots.push({ file, pre })
    }
    if (project.subtitles && inputs.subtitles !== undefined) {
      slots.push({ file: inputs.files[inputs.subtitles], pre: [] })
    }

    const graph = buildGraph({ project, files, inputs, canvas, effects, wantAudio, wantVideo })
    const chunks = [...graph.chunks]
    let video = graph.video
    const audio = graph.audio

    if (target === 'gif' && video) {
      const out = 'gout'
      chunks.push(
        `[${video}]fps=${Math.min(canvas.fps, 15)},scale=${Math.min(canvas.width, 480)}:-2:flags=lanczos,` +
          `split[gs0][gs1];[gs0]palettegen=stats_mode=diff[gp];[gs1][gp]paletteuse=diff_mode=rectangle[${out}]`,
      )
      video = out
    }
    if (target === 'still' && video) {
      const out = 'sout'
      chunks.push(`[${video}]select='gte(t\\,${Math.max(0, project.still).toFixed(3)})',setpts=PTS-STARTPTS[${out}]`)
      video = out
    }

    if (chunks.length > 0) tail.push('-filter_complex', chunks.join(';'))
    if (wantVideo && video) tail.push('-map', `[${video}]`)
    if (audio) tail.push('-map', `[${audio}]`)
    else dropsAudio = true

    if (target === 'gif') {
      tail.push('-loop', '0', '-an')
      ownsCodecs = true
      dropsAudio = true
    } else if (target === 'still') {
      tail.push('-frames:v', '1', '-update', '1', '-an')
      ownsCodecs = true
      dropsAudio = true
    } else if (target === 'audio') {
      tail.push('-vn')
    }

    // A sound the user placed can run past the picture. The project knows how
    // long it is meant to be, so say so rather than reaching for `-shortest`,
    // which with a filter graph is where truncations live.
    if (project.sounds.length > 0 && target !== 'still' && duration > 0) {
      tail.push('-t', duration.toFixed(3))
    }
  }

  // 1. The inputs, each preceded by the options that belong to it.
  slots.forEach((slot, index) => {
    args.push(...slot.pre, '-i', `@in${index}`)
  })

  // 2. Output-side trimming, then everything the target asked for.
  args.push(...post, ...tail)

  // 3. Metadata, then the codecs for the chosen container.
  if (project.stripMeta) args.push('-map_metadata', '-1', '-map_chapters', '-1')

  if (!ownsCodecs && container) {
    args.push(
      ...codecArgs(container, project.quality, {
        hasVideo: wantVideo && primary.info?.has_video !== false,
        hasAudio: !dropsAudio,
      }),
    )
  }

  args.push('@out')

  const outputName = project.name ?? outputNameFor(primary.name, target, ext)
  const names = slots.map((slot) => slot.file.name)

  return {
    args,
    display: toNames(args, names, outputName),
    outputName,
    duration: target === 'still' ? undefined : duration,
    missing: inputs.missing,
  }
}

function hasSound(fileId: string, files: MediaFile[]): boolean {
  const info = files.find((file) => file.id === fileId)?.info
  return info ? info.has_audio : true
}

/**
 * A rough guess at the finished size, so the export dialog can say something
 * before an encode rather than after it.
 *
 * CRF 23 is x264's default and the point where the source bitrate is roughly
 * preserved; every 6 points is about a factor of two.
 */
export function estimateSize(
  source: { bit_rate?: number | null; duration?: number | null; size?: number | null } | undefined,
  options: { duration?: number; crf: number; scale: number; container: string },
): number | null {
  if (!source) return null
  const bitrate = source.bit_rate ?? (source.size && source.duration ? (source.size * 8) / source.duration : null)
  if (!bitrate) return null
  const duration = options.duration ?? source.duration ?? 0
  if (!duration) return null

  const qualityFactor = Math.pow(2, (23 - options.crf) / 6)
  const areaFactor = Math.max(0.01, options.scale)
  const containerFactor = options.container === 'webm' ? 0.75 : 1
  const bits = bitrate * duration * qualityFactor * areaFactor * containerFactor
  return Math.max(0, Math.round(bits / 8))
}
