/**
 * Turning a project into one ffmpeg filter graph.
 *
 * Everything here is string assembly over numbers, with no state and no
 * interface, because this is the part most likely to be wrong in a way no unit
 * test would notice — a graph that ffmpeg accepts and that quietly produces the
 * wrong picture. Keeping it pure is what makes it possible to check.
 *
 * The pipeline, and why it is in this order:
 *
 *     clips → join → effects → overlays → subtitles → fade → export
 *
 * Effects come **before** overlays so that cropping cannot cut a logo the user
 * placed afterwards; the overlay is then sized against whatever the frame has
 * become, using `scale2ref`, rather than against a canvas size that a crop may
 * already have invalidated.
 *
 * Nothing here changes the length of the timeline. Speed, reversal and repeats
 * are properties of a clip and are applied before the join, so an overlay's
 * `enable='between(t,…)'` always refers to the timeline the user is looking at.
 */

import type { BuildContext, Params } from './ops'
import {
  clipDuration,
  fileOf,
  isStill,
  overlaps,
  sourceLength,
  timelineDuration,
  type Clip,
  type EffectItem,
  type TransitionKind,
  type Project,
  type ResolvedInputs,
} from './project'
import type { MediaFile } from './types'

/** The size and rate every clip is brought to before they can be joined. */
export interface Canvas {
  width: number
  height: number
  fps: number
}

/** Audio is normalised to one format so `concat` and `amix` will accept it. */
const SAMPLE_RATE = 48000
const AUDIO_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`

/**
 * `atempo` only accepts 0.5–2.0 per instance, so a bigger change is a chain of
 * them. Anything within a thousandth of 1 is left alone rather than emitted as
 * a no-op stage.
 */
export function buildAtempo(factor: number): string[] {
  const stages: string[] = []
  let remaining = factor
  if (remaining <= 0 || !Number.isFinite(remaining)) return stages
  while (remaining < 0.5) {
    stages.push('atempo=0.5')
    remaining /= 0.5
  }
  while (remaining > 2.0) {
    stages.push('atempo=2.0')
    remaining /= 2.0
  }
  if (Math.abs(remaining - 1) > 0.001) stages.push(`atempo=${remaining.toFixed(4)}`)
  return stages
}

/**
 * Make a line of text safe to put inside a filtergraph.
 *
 * Nothing here is about the shell — the graph is one argument. It is about the
 * two parsers the text passes through on its way in: the filtergraph splits on
 * `,;[]` and quotes with `'`, and then the filter's own option parser splits on
 * `:`. The colon is therefore escaped **twice**, because each parser eats one
 * backslash; everything else needs one.
 *
 * The text is left unquoted on purpose. Wrapping it in `'…'` looks tidier and
 * does not work: inside those quotes a backslash is literal, so an apostrophe
 * in the text closes the quote early and the rest is read as options.
 *
 * The escaped colon has a second, welcome effect. The server refuses any
 * argument containing a protocol like `http:`, which is how a filtergraph
 * reaches the network — so a caption mentioning a web address would otherwise
 * be turned away at the door.
 */
export function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\\\:')
    .replace(/(['[\],;])/g, '\\$1')
}

export function canvasOf(project: Project, files: MediaFile[]): Canvas {
  const first = project.clips[0]
  const info = first ? fileOf(files, first.fileId)?.info : undefined
  return {
    width: Math.max(2, Math.round((info?.width ?? 1280) / 2) * 2),
    height: Math.max(2, Math.round((info?.height ?? 720) / 2) * 2),
    fps: info?.fps && info.fps > 0 ? Math.round(info.fps * 1000) / 1000 : 30,
  }
}

/** Whether a clip's own file carries a soundtrack. */
function clipHasAudio(clip: Clip, files: MediaFile[]): boolean {
  const info = fileOf(files, clip.fileId)?.info
  // An unprobed file is assumed to have sound: asking for a stream that is not
  // there fails loudly, which is better than silently dropping the audio.
  return info ? info.has_audio : true
}

/**
 * Join the clips so that each dissolves out of the one before it.
 *
 * `xfade` takes two inputs and gives one, so a run of clips is a left fold
 * rather than the single N-way `concat` a hard cut uses. Its `offset` is
 * measured on the *first* input's timeline and says where the transition
 * begins, so the accumulated length has to be carried along: after joining,
 * the result runs `left + right - overlap`, which is exactly what `overlaps`
 * told the timeline it would.
 *
 * Video and sound are folded apart, and not for tidiness: `acrossfade` has no
 * offset at all — it always joins the tail of one to the head of the next — so
 * there is nothing for the two walks to share.
 *
 * Repeats within a clip are joined first, with an ordinary cut. A transition
 * belongs between clips; a clip dissolving into another showing of itself is
 * not what "play it three times" means.
 */
function dissolve(
  chunks: string[],
  labels: Labels,
  segments: Segment[],
  gaps: number[],
): { video: string | null; audio: string | null } {
  const collapse = (pads: string[], audio: boolean): string | null => {
    if (pads.length === 0) return null
    if (pads.length === 1) return pads[0]
    const out = labels.next(audio ? 'ra' : 'rv')
    chunks.push(
      `${pads.map((pad) => `[${pad}]`).join('')}` +
        `concat=n=${pads.length}:v=${audio ? 0 : 1}:a=${audio ? 1 : 0}[${out}]`,
    )
    return out
  }

  let video = collapse(segments[0].video, false)
  let audio = collapse(segments[0].audio, true)
  // Only the picture needs this: it is what `offset` is measured against.
  let elapsed = segments[0].length

  for (let index = 1; index < segments.length; index += 1) {
    const overlap = gaps[index] ?? 0
    const nextVideo = collapse(segments[index].video, false)
    const nextAudio = collapse(segments[index].audio, true)

    if (video && nextVideo) {
      const out = labels.next('xf')
      if (overlap > 0) {
        const at = Math.max(0, elapsed - overlap)
        chunks.push(
          `[${video}][${nextVideo}]xfade=transition=${segments[index].kind}` +
            `:duration=${overlap.toFixed(3)}:offset=${at.toFixed(3)}[${out}]`,
        )
      } else {
        chunks.push(`[${video}][${nextVideo}]concat=n=2:v=1:a=0[${out}]`)
      }
      video = out
    } else {
      video = video ?? nextVideo
    }

    if (audio && nextAudio) {
      const out = labels.next('xa')
      if (overlap > 0) {
        // `c1`/`c2` are the curves each side follows. Triangular is the pair
        // that holds the loudness steady across the join rather than dipping
        // in the middle of it, which is what the default does.
        chunks.push(
          `[${audio}][${nextAudio}]acrossfade=d=${overlap.toFixed(3)}:c1=tri:c2=tri[${out}]`,
        )
      } else {
        chunks.push(`[${audio}][${nextAudio}]concat=n=2:v=0:a=1[${out}]`)
      }
      audio = out
    } else {
      audio = audio ?? nextAudio
    }

    elapsed += segments[index].length - overlap
  }

  return { video, audio }
}

/** One clip's pads, kept together so a transition can join clip to clip. */
interface Segment {
  video: string[]
  audio: string[]
  length: number
  kind: TransitionKind
}

/** Mints unique graph labels, so no two chunks can collide. */
class Labels {
  private counter = 0

  next(prefix: string): string {
    this.counter += 1
    return `${prefix}${this.counter}`
  }
}

export interface GraphResult {
  /** The chunks of `-filter_complex`, to be joined with `;`. */
  chunks: string[]
  /** Label carrying the finished picture, without brackets. */
  video: string | null
  /** Label carrying the finished sound, without brackets. */
  audio: string | null
}

interface GraphRequest {
  project: Project
  files: MediaFile[]
  inputs: ResolvedInputs
  canvas: Canvas
  /** Effect fragments, already rendered by the effect definitions. */
  effects: { video: string[]; audio: string[] }
  /** Whether the export target wants a soundtrack at all. */
  wantAudio: boolean
  /** Whether the export target wants a picture at all. */
  wantVideo: boolean
}

/**
 * Bring one clip to the canvas, applying everything that changes its time.
 *
 * Reversal resets the timestamps afterwards because `reverse` leaves them
 * running backwards, which every later filter would then misread.
 */
function clipVideoFilters(clip: Clip, canvas: Canvas): string[] {
  const filters = ['setpts=PTS-STARTPTS']
  if (clip.reverse) filters.push('reverse', 'setpts=PTS-STARTPTS')
  if (clip.speed > 0 && Math.abs(clip.speed - 1) > 0.001) {
    filters.push(`setpts=${(1 / clip.speed).toFixed(6)}*PTS`)
  }
  filters.push(
    `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease`,
    `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${canvas.fps}`,
  )
  return filters
}

function clipAudioFilters(clip: Clip): string[] {
  const filters = ['asetpts=PTS-STARTPTS']
  if (clip.reverse) filters.push('areverse', 'asetpts=PTS-STARTPTS')
  if (clip.speed > 0 && Math.abs(clip.speed - 1) > 0.001) {
    filters.push(...buildAtempo(clip.speed))
  }
  filters.push(AUDIO_FORMAT)
  return filters
}

/**
 * Fan one label out into `count` copies.
 *
 * A graph label may be consumed exactly once, so repeating a clip cannot mean
 * naming it twice — it means splitting it.
 */
function fanOut(
  chunks: string[],
  labels: Labels,
  label: string,
  count: number,
  audio: boolean,
): string[] {
  if (count <= 1) return [label]
  const outputs = Array.from({ length: count }, () => labels.next(audio ? 'fa' : 'fv'))
  const filter = audio ? `asplit=${count}` : `split=${count}`
  chunks.push(`[${label}]${filter}${outputs.map((name) => `[${name}]`).join('')}`)
  return outputs
}

/** Play a stream forwards then backwards. */
function boomerang(chunks: string[], labels: Labels, label: string, audio: boolean): string {
  const [forward, backward] = fanOut(chunks, labels, label, 2, audio)
  const reversed = labels.next('br')
  chunks.push(`[${backward}]${audio ? 'areverse' : 'reverse'}[${reversed}]`)
  const out = labels.next('bo')
  chunks.push(
    `[${forward}][${reversed}]concat=n=2:v=${audio ? 0 : 1}:a=${audio ? 1 : 0}[${out}]`,
  )
  return out
}

export function buildGraph(request: GraphRequest): GraphResult {
  const { project, files, inputs, canvas, effects, wantAudio, wantVideo } = request
  const chunks: string[] = []
  const labels = new Labels()

  // 1. Each clip, brought to the canvas and to a common audio format.
  //
  // The clips' own sound is only built when something will consume it. A
  // soundtrack that replaces it outright leaves these pads with nowhere to go,
  // and ffmpeg refuses a graph that ends in an unconnected output rather than
  // ignoring it.
  const wantClipAudio = wantAudio && project.audio.source === 'clips'
  const videoPads: string[] = []
  const audioPads: string[] = []

  // Where each clip's pads begin, so a transition can join clips rather than
  // the repeats within one. Dissolving a clip into itself is a soft-focus
  // effect nobody asked for.
  const segments: Segment[] = []

  // Dissolving needs both sides in the same pixel format, which the canvas
  // filters do not pin — ffmpeg refuses the whole graph rather than converting.
  // Added only when it is needed, so an ordinary join keeps the command it had.
  const gaps = overlaps(project.clips)
  const dissolving = project.layout === 'sequence' && gaps.some((gap) => gap > 0)

  for (const clip of project.clips) {
    const index = inputs.clips.get(clip.uid)
    if (index === undefined) continue
    const repeats = Math.max(1, Math.floor(clip.loop))
    const segment: Segment = {
      video: [],
      audio: [],
      length: clipDuration(clip),
      kind: clip.transition?.kind ?? 'fade',
    }

    if (wantVideo) {
      let label = labels.next('cv')
      const filters = clipVideoFilters(clip, canvas)
      if (dissolving) {
        // `xfade` refuses two inputs whose pixel format or timebase differ,
        // and neither is pinned by the canvas filters. The timebase is the
        // one that only shows up in a *chain* of dissolves: a clip carries
        // the frame rate's, and xfade hands on microseconds, so the second
        // join in a row is where they meet and ffmpeg gives up.
        filters.push('format=yuv420p', 'settb=AVTB')
      }
      chunks.push(`[${index}:v]${filters.join(',')}[${label}]`)
      if (clip.boomerang) label = boomerang(chunks, labels, label, false)
      segment.video = fanOut(chunks, labels, label, repeats, false)
      videoPads.push(...segment.video)
    }

    if (wantClipAudio) {
      let label = labels.next('ca')
      if (clipHasAudio(clip, files)) {
        chunks.push(`[${index}:a]${clipAudioFilters(clip).join(',')}[${label}]`)
      } else {
        // A silent clip among noisy ones still needs a pad, or `concat` refuses
        // the whole set. Synthesised silence is the pad.
        const length = sourceLength(clip).toFixed(3)
        chunks.push(
          `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE},` +
            `atrim=duration=${length},asetpts=PTS-STARTPTS[${label}]`,
        )
      }
      if (clip.boomerang) label = boomerang(chunks, labels, label, true)
      segment.audio = fanOut(chunks, labels, label, repeats, true)
      audioPads.push(...segment.audio)
    }

    segments.push(segment)
  }

  // 2. Put the clips together.
  let video: string | null = null
  let audio: string | null = null

  if (project.layout === 'side-by-side' && videoPads.length > 1) {
    const stacked = labels.next('sx')
    const filter = project.stackDirection === 'vertical' ? 'vstack' : 'hstack'
    chunks.push(`${videoPads.map((pad) => `[${pad}]`).join('')}${filter}=inputs=${videoPads.length}[${stacked}]`)
    video = stacked
    if (audioPads.length > 0) {
      const mixed = labels.next('sa')
      chunks.push(
        `${audioPads.map((pad) => `[${pad}]`).join('')}` +
          `amix=inputs=${audioPads.length}:duration=longest:normalize=0[${mixed}]`,
      )
      audio = mixed
    }
  } else if (dissolving && segments.length > 1) {
    const joined = dissolve(chunks, labels, segments, gaps)
    video = joined.video
    audio = joined.audio
  } else if (videoPads.length > 1 || audioPads.length > 1) {
    const count = Math.max(videoPads.length, audioPads.length)
    const withVideo = videoPads.length > 0
    const withAudio = audioPads.length > 0
    const pads: string[] = []
    for (let i = 0; i < count; i += 1) {
      if (withVideo) pads.push(`[${videoPads[i]}]`)
      if (withAudio) pads.push(`[${audioPads[i]}]`)
    }
    const outVideo = withVideo ? labels.next('jv') : null
    const outAudio = withAudio ? labels.next('ja') : null
    chunks.push(
      `${pads.join('')}concat=n=${count}:v=${withVideo ? 1 : 0}:a=${withAudio ? 1 : 0}` +
        `${outVideo ? `[${outVideo}]` : ''}${outAudio ? `[${outAudio}]` : ''}`,
    )
    video = outVideo
    audio = outAudio
  } else {
    video = videoPads[0] ?? null
    audio = audioPads[0] ?? null
  }

  // 3. Sounds laid on the timeline, each where it was put.
  if (wantAudio) {
    const laid: string[] = []
    for (const sound of project.sounds) {
      const index = inputs.sounds.get(sound.uid)
      if (index === undefined) continue

      const track = labels.next('sd')
      const filters = [`atrim=${sound.in.toFixed(3)}:${sound.out.toFixed(3)}`, 'asetpts=PTS-STARTPTS']
      if (sound.at > 0) {
        // `all=1` matters: the bare form delays only the first channel and
        // silently pulls a stereo track out of alignment.
        filters.push(`adelay=delays=${Math.round(sound.at * 1000)}:all=1`)
      }
      if (sound.gain !== 0) filters.push(`volume=${sound.gain}dB`)
      filters.push(AUDIO_FORMAT)
      chunks.push(`[${index}:a]${filters.join(',')}[${track}]`)
      laid.push(track)
    }

    const all = audio ? [audio, ...laid] : laid
    if (all.length > 1) {
      const mixed = labels.next('am')
      // `normalize=0` or ffmpeg quietly scales every input by 1/n, so two
      // sounds deliberately set to full come out halved.
      chunks.push(
        `${all.map((name) => `[${name}]`).join('')}` +
          `amix=inputs=${all.length}:duration=longest:dropout_transition=0:normalize=0[${mixed}]`,
      )
      audio = mixed
    } else {
      audio = all[0] ?? null
    }
  }

  if (!wantAudio) audio = null

  // 4. Effects: per-frame, and never time-changing.
  if (video && effects.video.length > 0) {
    const out = labels.next('fx')
    chunks.push(`[${video}]${effects.video.join(',')}[${out}]`)
    video = out
  }
  if (audio && effects.audio.length > 0) {
    const out = labels.next('fa')
    chunks.push(`[${audio}]${effects.audio.join(',')}[${out}]`)
    audio = out
  }

  // 5. Level and loudness, once the whole mix exists.
  if (audio) {
    const tail: string[] = []
    if (project.audio.gain !== 0) tail.push(`volume=${project.audio.gain}dB`)
    if (project.audio.normalize) tail.push('loudnorm=I=-16:LRA=11:TP=-1.5')
    if (tail.length > 0) {
      const out = labels.next('al')
      chunks.push(`[${audio}]${tail.join(',')}[${out}]`)
      audio = out
    }
  }

  // 6. Overlays, sized against the frame as it now is.
  if (video) {
    for (const overlay of project.overlays) {
      const window = `enable='between(t,${overlay.from.toFixed(3)},${overlay.to.toFixed(3)})'`

      if (overlay.text !== undefined) {
        // `expansion=none` makes the text literal. Without it a per cent sign
        // is read as a strftime escape and ffmpeg refuses the whole graph over
        // a caption that says "50%".
        const parts = [
          'drawtext=expansion=none',
          `text=${escapeDrawText(overlay.text)}`,
          'font=Sans',
          `fontsize=h*${overlay.fontSize.toFixed(4)}`,
          `fontcolor=${overlay.colour}@${overlay.opacity.toFixed(2)}`,
        ]
        if (overlay.box) parts.push('box=1', 'boxcolor=black@0.45', 'boxborderw=12')
        parts.push(
          `x=(w-tw)*${overlay.x.toFixed(4)}`,
          `y=(h-th)*${overlay.y.toFixed(4)}`,
          window,
        )
        const out = labels.next('tx')
        chunks.push(`[${video}]${parts.join(':')}[${out}]`)
        video = out
        continue
      }

      const index = inputs.overlays.get(overlay.uid)
      if (index === undefined) continue

      const scaled = labels.next('ov')
      const base = labels.next('ob')
      // `scale2ref` measures the overlay against the main picture, so a crop
      // earlier in the chain resizes the logo with it instead of leaving it
      // proportionally huge.
      chunks.push(
        `[${index}:v][${video}]scale2ref=w=iw*${overlay.scale.toFixed(4)}:h=-2[${scaled}][${base}]`,
      )

      const dressing = ['setsar=1']
      // A clip laid down at three seconds should start playing then, not show
      // whatever it happens to be showing at its own third second. Without this
      // a four-second overlay placed at three showed its last frame.
      const file = fileOf(files, overlay.fileId)
      if (overlay.from > 0 && file && !isStill(file)) {
        dressing.push(`setpts=PTS-STARTPTS+${overlay.from.toFixed(3)}/TB`)
      }
      if (overlay.opacity < 1) {
        // The alpha channel has to exist before it can be scaled.
        dressing.push('format=rgba', `colorchannelmixer=aa=${overlay.opacity.toFixed(2)}`)
      }
      const ready = labels.next('od')
      chunks.push(`[${scaled}]${dressing.join(',')}[${ready}]`)

      const out = labels.next('oc')
      // No `eof_action`: the default repeats the last frame, which is what
      // keeps a single-frame image on screen. `pass` would make every still
      // overlay invisible.
      chunks.push(
        `[${base}][${ready}]overlay=x=(W-w)*${overlay.x.toFixed(4)}:y=(H-h)*${overlay.y.toFixed(4)}` +
          `:${window}[${out}]`,
      )
      video = out
    }
  }

  // 7. Burnt-in subtitles go last, so effects cannot distort the lettering.
  if (video && project.subtitles?.mode === 'burn' && inputs.subtitles !== undefined) {
    const out = labels.next('sb')
    chunks.push(
      `[${video}]subtitles=@in${inputs.subtitles}` +
        `:force_style='FontSize=${Math.round(project.subtitles.fontSize)}'[${out}]`,
    )
    video = out
  }

  // 8. Fading the finished timeline in and out.
  const duration = timelineDuration(project)
  if (project.fadeIn > 0 || (project.fadeOut > 0 && duration > project.fadeOut)) {
    const videoFades: string[] = []
    const audioFades: string[] = []
    if (project.fadeIn > 0) {
      videoFades.push(`fade=t=in:st=0:d=${project.fadeIn}`)
      audioFades.push(`afade=t=in:st=0:d=${project.fadeIn}`)
    }
    if (project.fadeOut > 0 && duration > project.fadeOut) {
      const start = (duration - project.fadeOut).toFixed(3)
      videoFades.push(`fade=t=out:st=${start}:d=${project.fadeOut}`)
      audioFades.push(`afade=t=out:st=${start}:d=${project.fadeOut}`)
    }
    if (video && videoFades.length > 0) {
      const out = labels.next('fd')
      chunks.push(`[${video}]${videoFades.join(',')}[${out}]`)
      video = out
    }
    if (audio && audioFades.length > 0) {
      const out = labels.next('fa')
      chunks.push(`[${audio}]${audioFades.join(',')}[${out}]`)
      audio = out
    }
  }

  return { chunks, video, audio }
}

/**
 * Render the effect chain.
 *
 * The effect definitions are unchanged from the old filter stack: they take
 * parameters and a context and return comma-joinable fragments.
 */
export function effectFragments(
  effects: EffectItem[],
  lookup: (id: string) => { filters?: (p: Params, ctx: BuildContext) => { video?: string[]; audio?: string[] } },
  context: BuildContext,
): { video: string[]; audio: string[] } {
  const video: string[] = []
  const audio: string[] = []
  for (const item of effects) {
    if (!item.enabled) continue
    const def = lookup(item.op)
    if (!def.filters) continue
    const fragments = def.filters(item.params, context)
    video.push(...(fragments.video ?? []))
    audio.push(...(fragments.audio ?? []))
  }
  return { video, audio }
}
