/**
 * Output containers and the codec settings each one gets by default.
 *
 * These mirror what the original web tool used, with one deliberate change:
 * every video container also pins `-pix_fmt yuv420p`, because otherwise a
 * 10-bit or 4:2:2 source produces a file that most players refuse.
 */

export interface Quality {
  /** Constant-quality value; interpreted per encoder. */
  crf: number
  /** x264/x265 speed preset. */
  preset: string
  /** Audio bitrate, e.g. `128k`. */
  audioBitrate: string
}

export const DEFAULT_QUALITY: Quality = {
  crf: 26,
  preset: 'medium',
  audioBitrate: '128k',
}

export const PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]

export const AUDIO_BITRATES = ['64k', '96k', '128k', '160k', '192k', '256k', '320k']

export interface ContainerDef {
  ext: string
  kind: 'video' | 'audio' | 'image'
  /** Encoders required for this container to work at all. */
  requires: string[]
  video?: (q: Quality) => string[]
  audio?: (q: Quality) => string[]
  /** Extra arguments appended after the codec settings. */
  extra?: string[]
}

const x264 = (q: Quality) => [
  '-c:v',
  'libx264',
  '-crf',
  String(q.crf),
  '-preset',
  q.preset,
  '-pix_fmt',
  'yuv420p',
]

const aac = (q: Quality) => ['-c:a', 'aac', '-b:a', q.audioBitrate]

export const CONTAINERS: ContainerDef[] = [
  {
    ext: 'mp4',
    kind: 'video',
    requires: ['libx264'],
    video: x264,
    audio: aac,
    // Without faststart the index sits at the end of the file, so the result
    // cannot start playing until it has fully downloaded.
    extra: ['-movflags', '+faststart'],
  },
  { ext: 'mkv', kind: 'video', requires: ['libx264'], video: x264, audio: aac },
  {
    ext: 'mov',
    kind: 'video',
    requires: ['libx264'],
    video: x264,
    audio: aac,
    extra: ['-movflags', '+faststart'],
  },
  {
    ext: 'webm',
    kind: 'video',
    requires: ['libvpx-vp9'],
    // `-b:v 0` is what puts libvpx-vp9 into constant-quality mode; without it
    // CRF is ignored and the result is capped at a default bitrate.
    video: (q) => ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(q.crf + 4), '-row-mt', '1'],
    audio: (q) => ['-c:a', 'libopus', '-b:a', q.audioBitrate],
  },
  {
    ext: 'avi',
    kind: 'video',
    requires: ['mpeg4'],
    video: () => ['-c:v', 'mpeg4', '-q:v', '5'],
    audio: (q) => ['-c:a', 'libmp3lame', '-b:a', q.audioBitrate],
  },
  {
    ext: 'mp3',
    kind: 'audio',
    requires: ['libmp3lame'],
    audio: (q) => ['-vn', '-c:a', 'libmp3lame', '-b:a', q.audioBitrate],
  },
  {
    ext: 'm4a',
    kind: 'audio',
    requires: ['aac'],
    audio: (q) => ['-vn', '-c:a', 'aac', '-b:a', q.audioBitrate],
  },
  { ext: 'wav', kind: 'audio', requires: ['pcm_s16le'], audio: () => ['-vn', '-c:a', 'pcm_s16le'] },
  { ext: 'flac', kind: 'audio', requires: ['flac'], audio: () => ['-vn', '-c:a', 'flac'] },
  {
    ext: 'opus',
    kind: 'audio',
    requires: ['libopus'],
    audio: (q) => ['-vn', '-c:a', 'libopus', '-b:a', q.audioBitrate],
  },
  {
    ext: 'ogg',
    kind: 'audio',
    requires: ['libvorbis'],
    audio: (q) => ['-vn', '-c:a', 'libvorbis', '-b:a', q.audioBitrate],
  },
  { ext: 'gif', kind: 'image', requires: ['gif'] },
]

export function findContainer(ext: string): ContainerDef | undefined {
  return CONTAINERS.find((c) => c.ext === ext)
}

/** Codec arguments for a container, honouring what the source actually has. */
export function codecArgs(
  container: ContainerDef,
  quality: Quality,
  options: { hasAudio: boolean; hasVideo: boolean },
): string[] {
  const args: string[] = []
  if (container.kind === 'audio') {
    return container.audio ? container.audio(quality) : []
  }
  if (container.video && options.hasVideo) args.push(...container.video(quality))
  if (options.hasAudio && container.audio) args.push(...container.audio(quality))
  // Asking for an audio stream that does not exist makes ffmpeg fail outright.
  else if (!options.hasAudio) args.push('-an')
  if (container.extra) args.push(...container.extra)
  return args
}

/**
 * What the wasm core can actually do. The published `@ffmpeg/core` build ships
 * a reduced encoder set and no libass, so operations that need more are marked
 * unavailable rather than failing halfway through an encode.
 */
export const WASM_ENCODERS = [
  'libx264',
  'libx265',
  'libvpx',
  'libvpx-vp9',
  'mpeg4',
  'gif',
  'png',
  'mjpeg',
  'libwebp',
  'aac',
  'libmp3lame',
  'libopus',
  'libvorbis',
  'flac',
  'pcm_s16le',
  'mov_text',
  'webvtt',
  'srt',
]

export const WASM_FILTERS = [
  'scale',
  'crop',
  'pad',
  'eq',
  'fps',
  'setpts',
  'atempo',
  'reverse',
  'areverse',
  'fade',
  'afade',
  'hqdn3d',
  'unsharp',
  'gblur',
  'boxblur',
  'transpose',
  'hflip',
  'vflip',
  'palettegen',
  'paletteuse',
  'split',
  'overlay',
  'hstack',
  'vstack',
  'concat',
  'amix',
  'volume',
  'loudnorm',
  'format',
  'trim',
  'atrim',
  // The plumbing a project graph needs: joining clips, laying a soundtrack
  // against them and sizing an overlay. All of these are built into ffmpeg
  // itself rather than pulled from an external library, which is the line the
  // wasm build actually draws — unlike `subtitles`, which needs libass and is
  // deliberately absent.
  'setsar',
  'asetpts',
  'aformat',
  'aresample',
  'anullsrc',
  'adelay',
  'asplit',
  'scale2ref',
  'colorchannelmixer',
  'select',
]
