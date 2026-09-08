/** Naming a result and reading a log line. */

import { describe, expect, it } from 'vitest'

import { classifyLog, uniqueOutputName } from './jobs'

describe('reading a log line', () => {
  it('picks out the level ffmpeg prefixes', () => {
    expect(classifyLog('[error] Invalid argument').level).toBe('error')
    expect(classifyLog('[fatal] Error opening output').level).toBe('error')
    expect(classifyLog('[warning] deprecated pixel format').level).toBe('warn')
    expect(classifyLog('frame= 120 fps=25').level).toBe('info')
  })

  it('notices a problem even without the prefix', () => {
    // Not every line ffmpeg calls a failure carries a level tag.
    expect(classifyLog('Error while decoding stream').level).toBe('error')
    expect(classifyLog('Codec is deprecated').level).toBe('warn')
  })

  it('keeps the line exactly as it arrived', () => {
    const line = '  [info] Stream #0:0 -> #0:0 (h264 -> libx264)  '
    expect(classifyLog(line).text).toBe(line)
  })
})

describe('naming a result', () => {
  const jobs = (...names: string[]) => names.map((outputName) => ({ outputName }))

  it('uses the name when nothing has claimed it', () => {
    expect(uniqueOutputName(jobs(), 'holiday-convert.mp4')).toBe('holiday-convert.mp4')
    expect(uniqueOutputName(jobs('other.mp4'), 'holiday.mp4')).toBe('holiday.mp4')
  })

  it('steps aside from a result already produced this session', () => {
    expect(uniqueOutputName(jobs('holiday.mp4'), 'holiday.mp4')).toBe('holiday-2.mp4')
    expect(uniqueOutputName(jobs('holiday.mp4', 'holiday-2.mp4'), 'holiday.mp4')).toBe('holiday-3.mp4')
  })

  it('keeps the extension where it belongs', () => {
    expect(uniqueOutputName(jobs('a.tar.gz'), 'a.tar.gz')).toBe('a.tar-2.gz')
    expect(uniqueOutputName(jobs('noext'), 'noext')).toBe('noext-2')
  })

  it('gives up rather than looping forever', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({
      outputName: i === 0 ? 'a.mp4' : `a-${i + 1}.mp4`,
    }))
    expect(uniqueOutputName(many, 'a.mp4')).toBe('a.mp4')
  })
})
