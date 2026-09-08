/** The helpers the operation panel and the command bar are built on. */

import { describe, expect, it } from 'vitest'

import { codecArgs, CONTAINERS, findContainer, DEFAULT_QUALITY } from './containers'
import { estimateSize } from './build'
import {
  formatBytes,
  formatDelta,
  formatDuration,
  parseTimecode,
  stemOf,
  toTimecode,
} from './format'
import { formatCommand, parseArgs, parseCommandLine, quoteArg } from './shell'

describe('splitting a hand-written command', () => {
  it('splits on whitespace', () => {
    expect(parseArgs('-i in.mp4  -c:v libx264')).toEqual(['-i', 'in.mp4', '-c:v', 'libx264'])
  })

  it('keeps a quoted value together', () => {
    // Filter graphs are full of quotes; a naive split breaks them immediately.
    // Single quotes inside double quotes are literal, exactly as a shell
    // treats them — the filter keeps the quotes ffmpeg expects.
    expect(parseArgs(`-vf "drawtext=text='hello world'"`)).toEqual([
      '-vf',
      "drawtext=text='hello world'",
    ])
    expect(parseArgs("-vf subtitles=a.srt:force_style='FontSize=24'")).toEqual([
      '-vf',
      'subtitles=a.srt:force_style=FontSize=24',
    ])
  })

  it('honours backslash escapes outside single quotes', () => {
    expect(parseArgs('a\\ b c')).toEqual(['a b', 'c'])
    expect(parseArgs("'a\\ b'")).toEqual(['a\\ b'])
  })

  it('returns nothing for an empty line', () => {
    expect(parseArgs('   ')).toEqual([])
  })

  it('drops the program name a pasted command carries', () => {
    // The bar shows the command as it would be pasted, so `ffmpeg` has to come
    // back off — passing it through makes ffmpeg treat it as an output file.
    expect(parseCommandLine('ffmpeg -i a.mp4 out.mp4')).toEqual(['-i', 'a.mp4', 'out.mp4'])
    expect(parseCommandLine('/usr/bin/ffmpeg -i a.mp4')).toEqual(['-i', 'a.mp4'])
    expect(parseCommandLine('ffprobe -show_format a.mp4')).toEqual(['-show_format', 'a.mp4'])
  })

  it('leaves a command that has no program name alone', () => {
    expect(parseCommandLine('-i a.mp4 out.mp4')).toEqual(['-i', 'a.mp4', 'out.mp4'])
  })

  it('quotes only what needs it', () => {
    expect(quoteArg('-c:v')).toBe('-c:v')
    expect(quoteArg('scale=640:-2')).toBe('scale=640:-2')
    expect(quoteArg('a b')).toBe("'a b'")
    expect(quoteArg("it's")).toBe("'it'\\''s'")
    expect(quoteArg('')).toBe("''")
  })

  it('round-trips a command through display and back', () => {
    const args = ['-vf', "drawtext=text='hi there'", '-c:v', 'libx264', 'out put.mp4']
    expect(parseCommandLine(formatCommand(args))).toEqual(args)
  })
})

describe('formatting', () => {
  it('renders sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(null)).toBe('—')
  })

  it('renders durations, showing hours only when there are any', () => {
    expect(formatDuration(0)).toBe('0:00.0')
    expect(formatDuration(83.4)).toBe('1:23.4')
    expect(formatDuration(3661)).toBe('1:01:01.0')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('renders timecodes ffmpeg accepts', () => {
    expect(toTimecode(0)).toBe('00:00:00.000')
    expect(toTimecode(83.4)).toBe('00:01:23.400')
    expect(toTimecode(3661.5)).toBe('01:01:01.500')
  })

  it('reads back the timecodes it writes', () => {
    for (const seconds of [0, 1.25, 83.4, 3661.5]) {
      expect(parseTimecode(toTimecode(seconds))).toBeCloseTo(seconds, 3)
    }
  })

  it('accepts the shorter forms people type', () => {
    expect(parseTimecode('12')).toBe(12)
    expect(parseTimecode('1:23')).toBe(83)
    expect(parseTimecode('1:23.5')).toBe(83.5)
    expect(parseTimecode(' 2:00 ')).toBe(120)
  })

  it('refuses what it cannot read', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('1:2:3:4')).toBeNull()
    expect(parseTimecode('-5')).toBeNull()
  })

  it('describes a change against the source', () => {
    expect(formatDelta(100, 40)).toBe('−60%')
    expect(formatDelta(100, 150)).toBe('+50%')
    expect(formatDelta(0, 10)).toBe('')
  })

  it('takes the stem of a name, including one with dots', () => {
    expect(stemOf('holiday.mp4')).toBe('holiday')
    expect(stemOf('/clips/my.holiday.final.mov')).toBe('my.holiday.final')
    expect(stemOf('noextension')).toBe('noextension')
  })
})

describe('containers', () => {
  it('can be looked up by extension', () => {
    for (const container of CONTAINERS) {
      expect(findContainer(container.ext)).toBe(container)
    }
    expect(findContainer('nope')).toBeUndefined()
  })

  it('declares what each one needs', () => {
    for (const container of CONTAINERS) {
      expect(container.requires.length, `${container.ext} requires nothing`).toBeGreaterThan(0)
    }
  })

  it('gives a video container both codecs when both streams exist', () => {
    const mp4 = findContainer('mp4')!
    const args = codecArgs(mp4, DEFAULT_QUALITY, { hasVideo: true, hasAudio: true })
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).not.toContain('-an')
  })

  it('drops the audio when the source has none', () => {
    const mp4 = findContainer('mp4')!
    const args = codecArgs(mp4, DEFAULT_QUALITY, { hasVideo: true, hasAudio: false })
    expect(args).toContain('-an')
    expect(args).not.toContain('aac')
  })

  it('ignores the video entirely for an audio container', () => {
    const mp3 = findContainer('mp3')!
    const args = codecArgs(mp3, DEFAULT_QUALITY, { hasVideo: true, hasAudio: true })
    expect(args).toContain('-vn')
    expect(args).not.toContain('libx264')
  })
})

describe('the size estimate', () => {
  const source = { bit_rate: 8_000_000, duration: 60, size: 60_000_000 }

  it('grows as the quality number falls', () => {
    const good = estimateSize(source, { crf: 18, scale: 1, container: 'mp4' })!
    const poor = estimateSize(source, { crf: 30, scale: 1, container: 'mp4' })!
    expect(good).toBeGreaterThan(poor)
  })

  it('follows the frame area', () => {
    const full = estimateSize(source, { crf: 23, scale: 1, container: 'mp4' })!
    const quarter = estimateSize(source, { crf: 23, scale: 0.25, container: 'mp4' })!
    expect(quarter).toBeCloseTo(full / 4, -3)
  })

  it('follows the trimmed length', () => {
    const whole = estimateSize(source, { crf: 23, scale: 1, container: 'mp4' })!
    const half = estimateSize(source, { duration: 30, crf: 23, scale: 1, container: 'mp4' })!
    expect(half).toBeCloseTo(whole / 2, -3)
  })

  it('says nothing rather than guessing without a source', () => {
    expect(estimateSize(undefined, { crf: 23, scale: 1, container: 'mp4' })).toBeNull()
    expect(estimateSize({ duration: 0 }, { crf: 23, scale: 1, container: 'mp4' })).toBeNull()
  })

  it('lands near the source size at the reference quality', () => {
    // CRF 23 is x264's default and roughly preserves the source bitrate.
    const estimate = estimateSize(source, { crf: 23, scale: 1, container: 'mp4' })!
    expect(estimate).toBeCloseTo(source.size, -7)
  })
})
