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
  /**
   * Which encoder writes the picture, or `auto` for the container's own.
   *
   * Named rather than inferred: a hardware encoder is listed by `ffmpeg
   * -encoders` whether or not the machine has a driver for it, so choosing one
   * automatically would mean encodes that fail on some machines for reasons
   * nobody could see. The interface offers what was found and the person picks.
   */
  encoder: string
}

export const DEFAULT_QUALITY: Quality = {
  crf: 26,
  preset: 'medium',
  audioBitrate: '128k',
  encoder: 'auto',
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

/**
 * An encoder that can write the picture in place of the container's own.
 *
 * Kept as a table apart from the containers because the same hardware encoder
 * serves mp4, mkv and mov alike; listing them per container would be the same
 * facts written three times, which is three places to forget one.
 *
 * None of these takes `-crf` or an x264 preset name — every family has its own
 * spelling for "this quality", and the translation lives next to the arguments
 * rather than in the interface, so the dialog only has to know what exists.
 */
export interface EncoderDef {
  id: string
  /** The codec slot it fills, so a container can say what it accepts. */
  codec: 'h264' | 'hevc'
  args: (q: Quality, container: string) => string[]
}

/**
 * `-b:v 0` is what puts nvenc into constant-quality mode. Without it the
 * encoder caps itself at a default bitrate and `-cq` is quietly ignored — the
 * same trap libvpx-vp9 has, and the reason that one carries the same flag.
 */
const nvenc = (name: string) => (q: Quality, container: string) => [
  '-c:v',
  name,
  '-rc',
  'vbr',
  '-cq',
  String(q.crf),
  '-b:v',
  '0',
  // p1 is fastest and p7 slowest, which is the reverse of how x264 numbers
  // nothing at all — so the nine x264 names are mapped rather than passed on.
  '-preset',
  NVENC_PRESETS[q.preset] ?? 'p4',
  '-pix_fmt',
  'yuv420p',
  // Without this tag an HEVC file in an Apple container plays in nothing Apple
  // makes, and the failure looks like a corrupt file rather than a wrong tag.
  ...(name.startsWith('hevc') && (container === 'mp4' || container === 'mov')
    ? ['-tag:v', 'hvc1']
    : []),
]

const NVENC_PRESETS: Record<string, string> = {
  ultrafast: 'p1',
  superfast: 'p1',
  veryfast: 'p2',
  faster: 'p3',
  fast: 'p3',
  medium: 'p4',
  slow: 'p5',
  slower: 'p6',
  veryslow: 'p7',
}

/**
 * What can write the picture instead of the container's own encoder.
 *
 * VAAPI is deliberately absent. It needs `-vaapi_device /dev/dri/renderD128`
 * before the input, and the server refuses any argument that names a path —
 * that refusal is the whole of what stops a page reading files it should not.
 * It also needs `format=nv12,hwupload` on the video, which cannot sit beside
 * the `-filter_complex` a timeline already uses. Admitting it would mean a new
 * kind of placeholder that the server fills in with a device it chose itself,
 * which is a feature rather than a line; `docs/РАЗРАБОТКА.md` records why.
 */
export const VIDEO_ENCODERS: EncoderDef[] = [
  { id: 'h264_nvenc', codec: 'h264', args: nvenc('h264_nvenc') },
  { id: 'hevc_nvenc', codec: 'hevc', args: nvenc('hevc_nvenc') },
  {
    id: 'h264_qsv',
    codec: 'h264',
    // QSV spells constant quality `-global_quality`, and shares x264's preset
    // vocabulary, so that one passes straight through.
    args: (q) => ['-c:v', 'h264_qsv', '-global_quality', String(q.crf), '-preset', q.preset, '-pix_fmt', 'nv12'],
  },
  {
    id: 'h264_videotoolbox',
    codec: 'h264',
    args: (q) => ['-c:v', 'h264_videotoolbox', '-q:v', String(videotoolboxQuality(q.crf)), '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'hevc_videotoolbox',
    codec: 'hevc',
    args: (q, container) => [
      '-c:v',
      'hevc_videotoolbox',
      '-q:v',
      String(videotoolboxQuality(q.crf)),
      '-pix_fmt',
      'yuv420p',
      ...(container === 'mp4' || container === 'mov' ? ['-tag:v', 'hvc1'] : []),
    ],
  },
]

/**
 * CRF onto videotoolbox's scale, which runs the other way and has no meaning
 * in common with it. 14..40 becomes 85..30; it is an approximation, and the
 * only honest one available.
 */
function videotoolboxQuality(crf: number): number {
  const clamped = Math.min(40, Math.max(14, crf))
  return Math.round(85 - ((clamped - 14) / 26) * 55)
}

/** The encoder to use for this container and choice, or none for its own. */
export function pickEncoder(container: ContainerDef, chosen: string): EncoderDef | undefined {
  if (chosen === 'auto') return undefined
  const encoder = VIDEO_ENCODERS.find((candidate) => candidate.id === chosen)
  // A container that does not take this codec falls back to its own rather
  // than emitting a command ffmpeg would refuse: the choice outlives the
  // container it was made for, and switching to WebM should not break.
  if (!encoder || !container.codecs?.includes(encoder.codec)) return undefined
  return encoder
}

export interface ContainerDef {
  ext: string
  kind: 'video' | 'audio' | 'image'
  /** Encoders required for this container to work at all. */
  requires: string[]
  /** Codec slots this container accepts, for choosing another encoder. */
  codecs?: Array<'h264' | 'hevc'>
  video?: (q: Quality) => string[]
  audio?: (q: Quality) => string[]
  /**
   * The subtitle codec this container carries, when it carries one at all.
   *
   * Every container spells the same subtitles differently — mp4 wants
   * `mov_text`, matroska wants `srt`, webm wants `webvtt` — and one that is
   * missing here takes no subtitle track, which is why a soft track has to be
   * offered per container rather than as a plain choice.
   */
  subtitles?: string
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
    codecs: ['h264', 'hevc'],
    video: x264,
    audio: aac,
    subtitles: 'mov_text',
    // Without faststart the index sits at the end of the file, so the result
    // cannot start playing until it has fully downloaded.
    extra: ['-movflags', '+faststart'],
  },
  {
    ext: 'mkv',
    kind: 'video',
    requires: ['libx264'],
    codecs: ['h264', 'hevc'],
    video: x264,
    audio: aac,
    subtitles: 'srt',
  },
  {
    ext: 'mov',
    kind: 'video',
    requires: ['libx264'],
    codecs: ['h264', 'hevc'],
    video: x264,
    audio: aac,
    subtitles: 'mov_text',
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
    subtitles: 'webvtt',
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
  if (container.video && options.hasVideo) {
    const chosen = pickEncoder(container, quality.encoder)
    args.push(...(chosen ? chosen.args(quality, container.ext) : container.video(quality)))
  }
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
