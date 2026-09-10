/**
 * Every kind of project, executed by a real ffmpeg.
 *
 * The other suites check that the builder says what it means to say. This one
 * checks that ffmpeg agrees: each project is built, the placeholders are
 * substituted the way the server substitutes them, and the command is run
 * against real clips. A project that produces a plausible argument list which
 * ffmpeg then rejects is exactly the failure the unit tests cannot see.
 *
 * It encodes, so it is opt-in: `npm run test:ffmpeg`.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildProject } from '../core/build'
import { toNames } from '../core/placeholders'
import {
  clipOf,
  emptyProject,
  type Clip,
  type Project,
} from '../core/project'
import type { MediaFile, MediaInfo } from '../core/types'
import { caption, effect, overlay, sound } from './fixtures'

const run = promisify(execFile)

/** Small and short: the point is whether ffmpeg accepts the command. */
const CLIP = { width: 320, height: 240, seconds: 3, fps: 15 }

/**
 * A wall-clock ceiling for every run.
 *
 * An unbounded image input is the one way this model can hang rather than fail,
 * and a hang looks exactly like a slow encode until somebody notices a pinned
 * core. Three seconds of 320×240 has no business taking twenty.
 */
const TIMEOUT = 20_000

let dir: string
let primary: MediaFile
let second: MediaFile
let silent: MediaFile
let music: MediaFile
let logo: MediaFile
let captions: MediaFile

async function ffmpeg(args: string[]) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    timeout: TIMEOUT,
  })
}

/** A clip with both a video and an audio stream. */
async function makeClip(path: string, colour: string, seconds = CLIP.seconds, fps = CLIP.fps) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc=size=${CLIP.width}x${CLIP.height}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-vf', `drawbox=color=${colour}@0.3:t=fill`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', path,
  ])
}

/** A clip with no soundtrack at all, and a different size and rate. */
async function makeSilentClip(path: string) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=640x480:rate=30:duration=2`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path,
  ])
}

async function makeMusic(path: string) {
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-c:a', 'libmp3lame', path])
}

async function makeLogo(path: string) {
  await ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=64x64:duration=1', '-frames:v', '1', path])
}

/** Read the real properties, so the builder sizes itself to the real clip. */
async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', [
    '-hide_banner', '-loglevel', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', path,
  ])
  const raw = JSON.parse(stdout) as {
    format: { duration?: string; size: string; bit_rate?: string; format_name: string }
    streams: Array<Record<string, unknown>>
  }
  const video = raw.streams.find((stream) => stream.codec_type === 'video')
  const audio = raw.streams.find((stream) => stream.codec_type === 'audio')
  const rate = video ? String(video.r_frame_rate ?? '0/1').split('/') : ['0', '1']
  return {
    duration: Number(raw.format.duration ?? 0),
    size: Number(raw.format.size),
    bit_rate: Number(raw.format.bit_rate ?? 0),
    format_name: raw.format.format_name,
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    fps: Number(rate[0]) / Number(rate[1] || 1) || null,
    video_codec: video ? String(video.codec_name) : null,
    audio_codec: audio ? String(audio.codec_name) : null,
    has_video: Boolean(video),
    has_audio: Boolean(audio),
    raw,
  }
}

async function open(path: string, id: string, name: string): Promise<MediaFile> {
  return { id, path, name, size: 0, info: await probe(path) }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ffweb-project-'))

  const paths = {
    primary: join(dir, 'clip.mp4'),
    second: join(dir, 'second.mp4'),
    silent: join(dir, 'screen.mp4'),
    music: join(dir, 'music.mp3'),
    logo: join(dir, 'logo.png'),
    captions: join(dir, 'captions.srt'),
  }

  await makeClip(paths.primary, 'red')
  // Deliberately mismatched: a different size and frame rate, so the join has
  // something real to reconcile.
  await makeClip(paths.second, 'blue', 2, 30)
  await makeSilentClip(paths.silent)
  await makeMusic(paths.music)
  await makeLogo(paths.logo)
  await run('bash', [
    '-c',
    `printf '1\\n00:00:00,000 --> 00:00:02,000\\nhello\\n\\n' > ${JSON.stringify(paths.captions)}`,
  ])

  primary = await open(paths.primary, 'p', 'clip.mp4')
  second = await open(paths.second, 's', 'second.mp4')
  silent = await open(paths.silent, 'n', 'screen.mp4')
  music = await open(paths.music, 'm', 'music.mp3')
  logo = await open(paths.logo, 'l', 'logo.png')
  captions = { id: 'c', path: paths.captions, name: 'captions.srt', size: 0 }
}, 120_000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

function files(): MediaFile[] {
  return [primary, second, silent, music, logo, captions]
}

function clip(file: MediaFile, patch: Partial<Clip> = {}): Clip {
  return { ...clipOf(`c-${file.id}`, file), ...patch }
}

function project(patch: Partial<Project> = {}): Project {
  return { ...emptyProject(), clips: [clip(primary)], ...patch }
}

/** Build a project, substitute the real paths, run it, and check the result. */
async function execute(input: Project, label: string) {
  const built = buildProject({ project: input, files: files(), engine: 'native' })
  expect(built.args.length, `${label}: nothing was built`).toBeGreaterThan(0)
  expect(built.missing, `${label}: a file went missing`).toEqual([])

  // From the builder, not worked out again: it is the one that decided which
  // files became which `-i`.
  const inputs = built.inputs.map((file) => file.path)
  const output = join(dir, `${label.replace(/[^a-z0-9]+/gi, '-')}-${built.outputName}`)
  // Exactly the substitution the server performs, including inside an argument.
  const args = toNames(built.args, inputs, output)

  try {
    await ffmpeg(args)
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr ?? String(error)
    throw new Error(`${label} failed:\n  ffmpeg ${args.join(' ')}\n\n${detail}`)
  }

  const info = await stat(output)
  expect(info.size, `${label} produced an empty file`).toBeGreaterThan(0)
  return output
}

describe('a project ffmpeg will actually run', () => {
  it('one clip, untouched', async () => {
    await execute(project(), 'plain')
  })

  it('one clip, trimmed', async () => {
    await execute(project({ clips: [clip(primary, { in: 0.5, out: 2 })] }), 'trimmed')
  })

  it('one clip with a chain of effects', async () => {
    await execute(
      project({
        effects: [effect('crop', { w: 200, h: 150, x: 10, y: 10 }), effect('adjust'), effect('denoise')],
      }),
      'effects',
    )
  })

  it('two clips of different size and frame rate, joined', async () => {
    // The per-clip scale, pad, setsar, fps and aformat exist for exactly this.
    await execute(project({ clips: [clip(primary), clip(second)] }), 'joined')
  })

  it('a silent clip joined to a noisy one', async () => {
    await execute(project({ clips: [clip(primary), clip(silent)] }), 'silent-pad')
  })

  it('three clips, one of them trimmed', async () => {
    await execute(
      project({ clips: [clip(primary, { in: 0.5, out: 2 }), clip(second), clip(silent)] }),
      'three',
    )
  })

  it('clips side by side', async () => {
    await execute(
      project({ clips: [clip(primary), clip(second)], layout: 'side-by-side' }),
      'side-by-side',
    )
  })

  it('a clip played faster', async () => {
    await execute(project({ clips: [clip(primary, { speed: 2 })] }), 'faster')
  })

  it('a clip played backwards', async () => {
    await execute(project({ clips: [clip(primary, { reverse: true })] }), 'reversed')
  })

  it('a clip repeated', async () => {
    await execute(project({ clips: [clip(primary, { loop: 2 })] }), 'repeated')
  })

  it('a clip there and back', async () => {
    await execute(project({ clips: [clip(primary, { boomerang: true })] }), 'boomerang')
  })

  it('another soundtrack, starting partway in', async () => {
    await execute(
      project({
        audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', music, { at: 1, in: 0, out: 4 })],
      }),
      'soundtrack',
    )
  })

  it('another soundtrack mixed over the original', async () => {
    await execute(
      project({
        sounds: [sound('s1', music, { at: 0, in: 0, out: 4 })],
      }),
      'mixed',
    )
  })

  it('two sounds laid down at once', async () => {
    await execute(
      project({
        sounds: [
          sound('s1', music, { at: 0, in: 0, out: 3 }),
          sound('s2', music, { at: 1.5, in: 0, out: 2, gain: -6 }),
        ],
      }),
      'two-sounds',
    )
  })

  it('a replaced soundtrack, with the footage muted', async () => {
    await execute(
      project({
        audio: { ...emptyProject().audio, source: 'none' },
        sounds: [sound('s1', music, { at: 0, in: 0, out: 3 })],
      }),
      'replaced-sound',
    )
  })

  it('a levelled soundtrack', async () => {
    await execute(
      project({ audio: { ...emptyProject().audio, gain: 4, normalize: true } }),
      'levelled',
    )
  })

  it('no soundtrack at all', async () => {
    await execute(project({ audio: { ...emptyProject().audio, source: 'none' } }), 'muted')
  })

  /**
   * The one that can hang rather than fail.
   *
   * An image has a single frame and no duration; left unbounded as `-loop 1` it
   * generates frames for as long as anything will take them. The timeout on
   * `execute` is what turns that into a failed test instead of a pinned core.
   */
  it('a still image laid over part of the timeline, and it terminates', async () => {
    await execute(
      project({
        overlays: [
          overlay('o1', logo, { x: 0.9, y: 0.9, scale: 0.25, opacity: 1, from: 1, to: 2 }),
        ],
      }),
      'overlay-still',
    )
  })

  it('a see-through overlay over a join', async () => {
    await execute(
      project({
        clips: [clip(primary), clip(second)],
        overlays: [
          overlay('o1', logo, { x: 0.1, y: 0.1, scale: 0.3, opacity: 0.5, from: 0.5, to: 3 }),
        ],
      }),
      'overlay-joined',
    )
  })

  it('a clip laid over another clip', async () => {
    await execute(
      project({
        overlays: [
          overlay('o1', second, { x: 0.5, y: 0.5, scale: 0.4, opacity: 1, from: 0, to: 2 }),
        ],
      }),
      'overlay-video',
    )
  })

  it('a clip laid on partway through, which has to start when it appears', async () => {
    await execute(
      project({
        overlays: [overlay('o1', second, { from: 1, to: 2.5 })],
      }),
      'overlay-shifted',
    )
  })

  it('an overlay after a crop', async () => {
    await execute(
      project({
        effects: [effect('crop', { w: 200, h: 150, x: 10, y: 10 })],
        overlays: [
          overlay('o1', logo, { x: 0.5, y: 0.5, scale: 0.25, opacity: 1, from: 0, to: 2 }),
        ],
      }),
      'overlay-cropped',
    )
  })

  it('a caption, with every character that could break the graph', async () => {
    // A filtergraph splits on `,;[]` and a filter splits its options on `:`,
    // so a caption is the one place a user's own text meets two parsers.
    await execute(
      project({
        overlays: [
          caption('t1', "50% off: don't miss it, see http://x [today]; a\\b", { from: 0.5, to: 2 }),
        ],
      }),
      'caption-nasty',
    )
  })

  it('a caption in Cyrillic over a join', async () => {
    await execute(
      project({
        clips: [clip(primary), clip(second)],
        overlays: [caption('t1', 'Привет, мир', { from: 1, to: 3 })],
      }),
      'caption-cyrillic',
    )
  })

  it('a still image as a clip of its own, between two others', async () => {
    // A picture has no duration, so this is the case that produced a
    // zero-length segment and, from there, nothing at all.
    await execute(
      project({ clips: [clip(primary), clip(logo), clip(second)] }),
      'title-card',
    )
  })

  it('fading in and out', async () => {
    await execute(project({ fadeIn: 0.5, fadeOut: 0.5 }), 'faded')
  })

  it('burnt-in subtitles', async () => {
    await execute(
      project({ subtitles: { fileId: captions.id, mode: 'burn', fontSize: 24 } }),
      'subtitles',
    )
  })

  it('a soft subtitle track, in every container that carries one', async () => {
    // The one stream mapped straight from an input rather than from a pad, and
    // each container spells the codec differently — so a wrong spelling is
    // refused by the muxer and nothing but a real run would show it.
    for (const container of ['mp4', 'mkv', 'webm']) {
      await execute(
        project({ container, subtitles: { fileId: captions.id, mode: 'soft', fontSize: 24 } }),
        `soft-subtitles-${container}`,
      )
    }
  })

  it('clips dissolving into one another', async () => {
    // The offset arithmetic is the part no string comparison can check: a
    // plausible number is accepted by the builder and rejected — or worse,
    // quietly mistimed — by ffmpeg. The fixtures differ in size, frame rate
    // and sample rate on purpose.
    await execute(
      project({
        clips: [clip(primary), clip(second, { transition: { duration: 1, kind: 'fade' } })],
      }),
      'dissolved',
    )
  })

  it('a dissolve after a repeat, and onto a silent clip', async () => {
    // Repeats are joined within the clip and the dissolve happens between
    // clips, so this is the shape where those two could be got the wrong way
    // round. The silent clip is there because its sound is synthesised, and
    // `acrossfade` has to accept that as readily as a real soundtrack.
    await execute(
      project({
        clips: [
          clip(primary, { loop: 2 }),
          clip(silent, { transition: { duration: 0.5, kind: 'wipeleft' } }),
          clip(second, { transition: { duration: 0.5, kind: 'circleopen' } }),
        ],
      }),
      'dissolved-repeat',
    )
  })

  it('a dissolve under an overlay and a fade', async () => {
    // Everything downstream counts in seconds of the finished timeline, which
    // a dissolve shortens. If the overlay window or the tail fade were left
    // measured against the un-dissolved length, this is where it would show.
    await execute(
      project({
        clips: [clip(primary), clip(second, { transition: { duration: 1, kind: 'fade' } })],
        overlays: [overlay('o1', logo, { from: 0.5, to: 2, x: 0.1, y: 0.1 })],
        fadeIn: 0.5,
        fadeOut: 0.5,
      }),
      'dissolved-dressed',
    )
  })

  it('metadata stripped', async () => {
    await execute(project({ stripMeta: true }), 'stripped')
  })

  it('everything at once', async () => {
    await execute(
      project({
        clips: [clip(primary, { in: 0.5, out: 2.5 }), clip(second, { speed: 2 }), clip(silent)],
        effects: [effect('crop', { w: 200, h: 150, x: 10, y: 10 }), effect('adjust')],
        overlays: [
          overlay('o1', logo, { x: 0.8, y: 0.8, scale: 0.2, opacity: 0.7, from: 0.5, to: 2 }),
        ],
        sounds: [sound('s1', music, { at: 0.5, in: 0, out: 5, gain: 2 })],
        fadeIn: 0.3,
        fadeOut: 0.3,
      }),
      'everything',
    )
  })
})

describe('every export target', () => {
  it('a video', async () => {
    await execute(project({ target: 'video', container: 'mp4' }), 'target-video')
  })

  it('a video in another container', async () => {
    await execute(project({ target: 'video', container: 'mkv' }), 'target-mkv')
  })

  it('a GIF from one clip', async () => {
    await execute(project({ target: 'gif' }), 'target-gif')
  })

  it('a GIF from a join', async () => {
    await execute(project({ clips: [clip(primary), clip(second)], target: 'gif' }), 'target-gif-joined')
  })

  it('the soundtrack on its own', async () => {
    await execute(project({ target: 'audio', container: 'mp3' }), 'target-audio')
  })

  it('the soundtrack of a join', async () => {
    await execute(
      project({ clips: [clip(primary), clip(second)], target: 'audio', container: 'mp3' }),
      'target-audio-joined',
    )
  })

  it('one frame', async () => {
    await execute(project({ target: 'still', still: 1 }), 'target-still')
  })

  it('one frame from a join', async () => {
    await execute(
      project({ clips: [clip(primary), clip(second)], target: 'still', still: 3.5 }),
      'target-still-joined',
    )
  })
})
