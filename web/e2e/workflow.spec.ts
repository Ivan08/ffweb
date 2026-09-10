/**
 * The whole path, once: open a file, build a timeline, run it, get a result.
 *
 * Everything else is tested in pieces. This is the only test that says a person
 * can actually use the thing — that the binary serves the interface it was
 * built with, that picking a file reaches the disk, that the timeline says what
 * will happen, and that a finished job comes back as a real file.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'

const run = promisify(execFile)
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let server: ChildProcess
let baseUrl: string
let media: string
let output: string
let workspace: string

/** Start the built binary the way a person would, and wait for its URL. */
async function startServer(): Promise<string> {
  const binary = join(repo, 'target', 'release', 'ffweb')
  server = spawn(binary, ['--port', '0', '--no-open', '--no-token', '--root', media, '--out', output])

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server never announced a URL')), 20_000)
    let buffered = ''
    server.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(buffered)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    server.on('error', reject)
  })
}

async function makeClip(path: string, seconds: number, tone: number) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`,
    // A tone that swells and fades, not a flat one: a waveform of a constant
    // sine is the same picture at every zoom level, so nothing here could tell
    // a track that follows the window from one that ignores it.
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds},tremolo=f=1.7:d=0.9`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', path,
  ])
}

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ffweb-e2e-'))
  media = join(workspace, 'media')
  output = join(workspace, 'out')
  await run('mkdir', ['-p', media])

  // A clip with a moving picture and a tone, so trimming has something to cut.
  await makeClip(join(media, 'holiday.mp4'), 6, 440)
  // Two more, so joining has something to join.
  await makeClip(join(media, 'second.mp4'), 2, 880)
  await makeClip(join(media, 'third.mp4'), 2, 660)

  // A picture to lay over the timeline, and a soundtrack to put under it.
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=red:size=64x64:duration=1',
    '-frames:v', '1', join(media, 'logo.png'),
  ])
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8',
    '-c:a', 'libmp3lame', join(media, 'music.mp3'),
  ])
  await writeFile(join(media, 'notes.txt'), 'not media\n')
  await writeFile(
    join(media, 'captions.srt'),
    '1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:05,000\nAnd again\n',
  )

  baseUrl = await startServer()
})

test.afterAll(async () => {
  server?.kill('SIGTERM')
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

/** English, light theme, no automatic saving: a predictable starting point. */
async function openApp(page: Page) {
  await page.goto(baseUrl)
  await page.evaluate(() => {
    localStorage.setItem('ffweb.lang', 'en')
    localStorage.setItem('ffweb.theme', 'light')
    localStorage.setItem('ffweb.autoDownload', '0')
  })
  await page.goto(baseUrl)
  await expect(page.getByRole('button', { name: 'Open', exact: true }).first()).toBeVisible()
}

/**
 * Open one of the prepared files through the dialog.
 *
 * Scoped to the dialog on purpose: once a file is open its name also appears on
 * a chip in the source strip, and an unscoped match picks the chip — which
 * ticks it instead of opening anything.
 */
async function openFile(page: Page, name: string) {
  await page.keyboard.press('Control+o')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).first().click()
  await expect(dialog).toBeHidden()
}

/**
 * Open the clip and wait until the interface has caught up: the probe has
 * returned, the clip is on the timeline and the command bar shows what would
 * run. Reading either before that is a race, not a failure.
 */
async function openClip(page: Page) {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await expect(page.locator('video')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(page.locator('textarea')).toHaveValue(/ffmpeg -i holiday\.mp4/)
}

/** Wait for a file matching the pattern to appear in the output directory. */
async function waitForOutput(pattern: RegExp, timeout = 60_000): Promise<string> {
  const deadline = Date.now() + timeout
  for (;;) {
    const entries = await readdir(output).catch(() => [] as string[])
    const found = entries.find((entry) => pattern.test(entry))
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`nothing matching ${pattern} appeared in ${output}; saw ${entries.join(', ')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * Export is two steps now: the button opens the questions, and the dialog
 * starts the job.
 */
async function exportNow(page: Page, target?: string) {
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  if (target) await dialog.getByRole('button', { name: target, exact: true }).click()
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()
}

/**
 * Where every block on the timeline sits, as a percentage of the axis.
 *
 * Measured rather than assumed: a block's position is arithmetic that ends up
 * in CSS, and the one thing that cannot be checked by reading the code is
 * whether the number that came out is the number that was drawn.
 */
async function blocks(page: Page) {
  return page.evaluate(() => {
    const axis = document.querySelector('[class*="relative min-w-0 flex-1"]') as HTMLElement
    const box = axis.getBoundingClientRect()
    return [...axis.children].flatMap((row) =>
      [...row.querySelectorAll(':scope > div')].map((block) => {
        const rect = (block as HTMLElement).getBoundingClientRect()
        return {
          text: (block.textContent ?? '').replace(/\s+/g, ' ').trim(),
          from: Math.round(((rect.left - box.left) / box.width) * 1000) / 10,
          to: Math.round(((rect.right - box.left) / box.width) * 1000) / 10,
          top: Math.round(rect.top - box.top),
        }
      }),
    ).filter((block) => block.text)
  })
}

/** Just the blocks on the video track: the ones naming the footage. */
async function clipBlocks(page: Page, name: string) {
  const all = await blocks(page)
  return all.filter((block) => block.text.includes(name))
}

/** Click the ruler to put the playhead a fraction of the way along. */
async function seekTo(page: Page, fraction: number) {
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  await page.mouse.click(axis.x + axis.width * fraction, axis.y + 8)
}

/**
 * Read something out of a finished result.
 *
 * The file appears on disk before it is worth reading: an mp4 written with
 * `+faststart` has its index moved to the front in a second pass, so until the
 * job is over there is a file there with no moov atom in it. Waiting for the
 * name is not waiting for the result.
 */
async function probeWhenReady(path: string, entries: string, timeout = 30_000): Promise<string> {
  const deadline = Date.now() + timeout
  let last = ''
  for (;;) {
    try {
      const probed = await run('ffprobe', [
        '-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', path,
      ])
      const value = probed.stdout.trim()
      if (value) return value
      last = 'ffprobe said nothing'
    } catch (error) {
      last = String((error as { stderr?: string }).stderr ?? error).trim()
    }
    if (Date.now() > deadline) throw new Error(`${path} never became readable: ${last}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * Mark the whole workspace as kept, by dragging across the Keep row.
 *
 * There is no button for it: no window at all already means the whole of it,
 * and a button that filled the row would leave nowhere to drag a second one.
 */
async function markWhole(page: Page) {
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  // The Keep row sits under the ruler and the video track.
  const y = axis.y + 52 + 16 + 15
  await page.mouse.move(axis.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(axis.x + axis.width - 1, y, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByRole('slider', { name: 'End of the kept part' })).toBeVisible()
}

/** The chip for a file in the source strip. */
function chip(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).first()
}

test('serves the interface that was built into it', async ({ page }) => {
  await openApp(page)
  await expect(page).toHaveTitle('ffweb')
  // The engine badge only appears once /api/capabilities has answered.
  await expect(page.locator('header')).toContainText('ffmpeg')
})

test('is cross-origin isolated, so the browser engine can load', async ({ page }) => {
  await openApp(page)
  // Without this the browser withholds SharedArrayBuffer and the wasm core
  // cannot start at all.
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true)
})

test('puts an opened file straight onto the timeline', async ({ page }) => {
  await openClip(page)
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  // The footage goes on whole, and nothing is marked: all of it is kept until
  // somebody says otherwise, which the Keep row says rather than draws.
  await expect(page.getByText(/All of it/)).toBeVisible()
  await expect(page.locator('textarea')).not.toHaveValue(/-ss |-t /)
})

test('shows the command it is going to run', async ({ page }) => {
  await openClip(page)

  const command = await page.locator('textarea').inputValue()
  expect(command).toContain('ffmpeg -i holiday.mp4')
  expect(command).toContain('libx264')
  expect(command).toContain('holiday-video.mp4')
  // A single untouched clip must not go through a filter graph: that is the
  // path that keeps the ordinary case as fast as it ever was.
  expect(command).not.toContain('-filter_complex')
  // Placeholders are an implementation detail and must not reach the user.
  expect(command).not.toContain('@in0')
})

test('keeps part of a clip and writes the result to disk', async ({ page }) => {
  await openClip(page)
  await markWhole(page)

  const handle = (await page.getByRole('slider', { name: 'End of the kept part' }).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x - 200, handle.y + handle.height / 2, { steps: 10 })
  await page.mouse.up()

  await expect(page.locator('textarea')).toHaveValue(/-t /)

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('joins three clips in the order they were ticked', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'second.mp4')
  await openFile(page, 'third.mp4')

  // The first file is already on the timeline, so it is unticked here and the
  // other two are added after it.
  await chip(page, 'holiday.mp4').click()
  await chip(page, 'second.mp4').click()
  await chip(page, 'third.mp4').click()
  await expect(page.getByText('2 selected')).toBeVisible()

  await page.getByRole('button', { name: /Join 2/ }).click()

  // `toHaveValue` retries; `inputValue` reads once, and the command bar
  // re-derives a tick after the click.
  await expect(page.locator('textarea')).toHaveValue(/concat=n=3/)
  const command = await page.locator('textarea').inputValue()
  expect(command.indexOf('holiday.mp4')).toBeLessThan(command.indexOf('second.mp4'))
  expect(command.indexOf('second.mp4')).toBeLessThan(command.indexOf('third.mp4'))

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('lays a picture over part of the timeline, not all of it', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'logo.png')

  await page.getByRole('button', { name: 'Picture', exact: true }).click()
  await page.getByRole('menuitem', { name: /logo\.png/ }).click()

  // The overlay lands on the track and the command says when it shows.
  await expect(page.getByRole('slider', { name: 'Start of the overlay' })).toBeVisible()
  await expect(page.locator('textarea')).toHaveValue(/between\(t,/)

  // Type the window rather than dragging it: the point of the test is that the
  // window reaches ffmpeg, and a timecode field is exact.
  await page.getByLabel('Shows at', { exact: true }).fill('00:00:02.0')
  await page.getByLabel('Shows at', { exact: true }).press('Enter')
  await page.getByLabel('Hides at', { exact: true }).fill('00:00:04.0')
  await page.getByLabel('Hides at', { exact: true }).press('Enter')

  await expect(page.locator('textarea')).toHaveValue(/between\(t,2\.000,4\.000\)/)

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('puts another soundtrack under the picture, starting partway in', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'music.mp3')

  await page.getByRole('button', { name: 'Sound', exact: true }).click()
  await page.getByRole('menuitem', { name: /music\.mp3/ }).click()

  await page.getByLabel('Starts at', { exact: true }).fill('00:00:02.0')
  await page.getByLabel('Starts at', { exact: true }).press('Enter')

  await expect(page.locator('textarea')).toHaveValue(/adelay=delays=2000:all=1/)

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('saves the soundtrack on its own from the audio track', async ({ page }) => {
  await openClip(page)

  // This is what "extract audio" was, reached from the sound itself rather than
  // from a list of twenty-eight operations.
  await page.getByText('From the footage').first().click()
  await page.getByRole('button', { name: 'Save this track on its own' }).click()

  expect(await waitForOutput(/^holiday-audio.*\.mp3$/)).toBeTruthy()
})

test('exports a still frame from where the playhead is', async ({ page }) => {
  await openClip(page)
  await exportNow(page, 'Frame')
  expect(await waitForOutput(/^holiday-still.*\.(jpg|jpeg)$/)).toBeTruthy()
})

test('never overwrites a result from an earlier run', async ({ page }) => {
  await openClip(page)
  await exportNow(page)
  await waitForOutput(/^holiday-video\.mp4$/)

  // Clearing the workspace loses the client's memory of the first result; the
  // server still has to notice the file on disk.
  await page.getByRole('button', { name: 'Clear' }).click()
  await openFile(page, 'holiday.mp4')
  await expect(page.locator('textarea')).toHaveValue(/holiday-video\.mp4/)
  await exportNow(page)

  expect(await waitForOutput(/^holiday-video-\d+\.mp4$/)).toBeTruthy()
})

test('takes back a whole drag as one step, and puts it back again', async ({ page }) => {
  await openClip(page)
  const command = page.locator('textarea')
  expect(await command.inputValue()).not.toContain('-t ')

  // One gesture, many pointer moves. The point of the test is that undoing it
  // once returns the window to where it started, rather than stepping back
  // through the pixels it was dragged across.
  await markWhole(page)
  const marked = await command.inputValue()
  const handle = (await page.getByRole('slider', { name: 'End of the kept part' }).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x - 200, handle.y + handle.height / 2, { steps: 20 })
  await page.mouse.up()
  await expect(command).toHaveValue(/-t /)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(command).toHaveValue(marked)

  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(command).toHaveValue(/-t /)
})

test('offers nothing to undo on an empty workspace', async ({ page }) => {
  await openApp(page)
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled()
})

test('takes a clip back off the timeline, leaving the file open', async ({ page }) => {
  // Opening a file puts it on the timeline, and that is an edit like any
  // other: undo takes the clip off. The file itself stays in the strip, ready
  // to be put back — history covers the project, not what is open.
  await openClip(page)

  await page.getByRole('button', { name: 'Undo' }).click()

  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeHidden()
  await expect(chip(page, 'holiday.mp4')).toBeVisible()
})

test('forgets a clear, rather than offering to undo it', async ({ page }) => {
  // Clearing stops running jobs and drops files whose ids are never minted
  // again, so a remembered project could not be put back on screen anyway.
  await openClip(page)
  await page.getByRole('button', { name: 'Clear' }).click()

  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
})

test('cuts a clip in two at the playhead', async ({ page }) => {
  await openClip(page)
  expect(await clipBlocks(page, 'holiday.mp4')).toHaveLength(1)

  // Put the playhead halfway along by clicking the ruler, then cut there.
  await seekTo(page, 0.5)
  await page.keyboard.press('s')

  const after = await clipBlocks(page, 'holiday.mp4')
  expect(after).toHaveLength(2)
  // Two blocks side by side, together covering what the one covered.
  expect(after[0].from).toBeCloseTo(0, 0)
  expect(after[1].from).toBeCloseTo(after[0].to, 0)
  expect(after[1].to).toBeCloseTo(100, 0)

  // A cut clip is a join, so the command has to go through a filter graph.
  await expect(page.locator('textarea')).toHaveValue(/-filter_complex/)
})

test('undoes a split in one step', async ({ page }) => {
  await openClip(page)
  await seekTo(page, 0.5)
  await page.keyboard.press('s')
  expect(await clipBlocks(page, 'holiday.mp4')).toHaveLength(2)

  await page.keyboard.press('Control+z')
  expect(await clipBlocks(page, 'holiday.mp4')).toHaveLength(1)
})

test('leaves the letter S alone while a caption is being typed', async ({ page }) => {
  // The whole point of the guard: the command bar is a textarea that is always
  // on screen, and every bare letter taken as a shortcut is one nobody can
  // type. Without this, naming a caption would chop the timeline up.
  await openClip(page)
  await seekTo(page, 0.5)
  await page.getByRole('button', { name: 'Text', exact: true }).click()

  const caption = page.getByLabel('Text', { exact: true })
  await caption.click()
  await caption.pressSequentially('sunset')

  await expect(caption).toHaveValue('sunset')
  expect(await clipBlocks(page, 'holiday.mp4')).toHaveLength(1)
})

test('steps the playhead with the arrow keys', async ({ page }) => {
  await openClip(page)
  const readout = page.getByRole('heading', { name: 'Timeline' }).locator('..')
  await expect(readout).toContainText('0:00.0 /')

  // Shift moves by a second, which is visible in a readout that shows tenths.
  await page.keyboard.press('Shift+ArrowRight')
  await expect(readout).toContainText('0:01.0 /')

  await page.keyboard.press('Shift+ArrowLeft')
  await expect(readout).toContainText('0:00.0 /')
})

test('fades the whole result in and out', async ({ page }) => {
  await openClip(page)

  await page.getByRole('slider', { name: 'Fade in' }).fill('1')
  await expect(page.locator('textarea')).toHaveValue(/fade=t=in:st=0:d=1/)
  await expect(page.locator('textarea')).toHaveValue(/afade=t=in:st=0:d=1/)

  // The fade-out is anchored on the end of the timeline, not on zero.
  await page.getByRole('slider', { name: 'Fade out' }).fill('2')
  await expect(page.locator('textarea')).toHaveValue(/fade=t=out:st=4\.000:d=2/)
})

test('plays two clips at once instead of one after another', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'second.mp4')
  await chip(page, 'holiday.mp4').click()
  await chip(page, 'second.mp4').click()
  await page.getByRole('button', { name: 'Add to timeline' }).click()
  await expect(page.locator('textarea')).toHaveValue(/concat=n=2/)

  await page.getByRole('button', { name: 'Together', exact: true }).click()
  await expect(page.locator('textarea')).toHaveValue(/hstack=inputs=2/)
  await expect(page.locator('textarea')).not.toHaveValue(/concat=n=2/)

  // The frame really is twice as wide, and says so rather than pretending.
  await expect(page.getByText('640×240')).toBeVisible()

  await page.getByRole('button', { name: 'Stacked', exact: true }).click()
  await expect(page.locator('textarea')).toHaveValue(/vstack=inputs=2/)
  await expect(page.getByText('320×480')).toBeVisible()
})

test('carries a subtitle file as a track of its own', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'captions.srt')

  // Subtitles are not footage: opening one must not put it on the video track.
  expect(await clipBlocks(page, 'captions.srt')).toHaveLength(0)

  await page.getByRole('button', { name: 'Subtitles', exact: true }).click()
  await page.getByRole('menuitem', { name: /captions\.srt/ }).click()

  await expect(page.locator('textarea')).toHaveValue(/-c:s mov_text/)
  await expect(page.locator('textarea')).toHaveValue(/-map 1:s/)

  // A name of its own: every test writes into the same directory, and the
  // default name is one several of them already use.
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('File name').fill('with-subtitles.mp4')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()

  const result = await waitForOutput(/^with-subtitles\.mp4$/)
  expect(await probeWhenReady(join(output, result), 'stream=codec_name:stream=codec_type')).toContain(
    'mov_text',
  )
})

test('says so when a container cannot carry the subtitles', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'captions.srt')
  await page.getByRole('button', { name: 'Subtitles', exact: true }).click()
  await page.getByRole('menuitem', { name: /captions\.srt/ }).click()

  await page.getByRole('button', { name: 'Export…' }).click()
  await page.getByRole('dialog').getByLabel('Container').selectOption('avi')
  await page.keyboard.press('Escape')

  // AVI has nowhere to put them, so the track is left out rather than being
  // silently dropped at the end of a long encode.
  await expect(page.getByText('carries no subtitle track', { exact: false })).toBeVisible()
  await expect(page.locator('textarea')).not.toHaveValue(/-c:s/)
})

test('offers the encoders this ffmpeg was built with', async ({ page }) => {
  await openClip(page)
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')

  const encoder = dialog.getByLabel('Encoder')
  await expect(encoder).toBeVisible()
  // Software is the default: a hardware encoder is listed whenever ffmpeg was
  // built with it, which says nothing about a driver being present.
  await expect(encoder).toHaveValue('auto')

  await encoder.selectOption('h264_nvenc')
  await page.keyboard.press('Escape')
  await expect(page.locator('textarea')).toHaveValue(/h264_nvenc/)
  // Its own spelling of quality, and never x264's alongside it.
  await expect(page.locator('textarea')).toHaveValue(/-cq 26/)
  await expect(page.locator('textarea')).not.toHaveValue(/-crf/)
})

test('drops an encoder the new container cannot take', async ({ page }) => {
  await openClip(page)
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Encoder').selectOption('h264_nvenc')
  await expect(page.locator('textarea')).toHaveValue(/h264_nvenc/)

  // WebM has no h264 slot. Keeping the dead choice would leave the dialog
  // naming an encoder that is not writing anything.
  await dialog.getByLabel('Container').selectOption('webm')
  await expect(dialog.getByLabel('Encoder')).toHaveValue('auto')
  await page.keyboard.press('Escape')
  await expect(page.locator('textarea')).toHaveValue(/libvpx-vp9/)
})

test('blames the encoder when the hardware turns out not to be there', async ({ page }) => {
  // ffmpeg lists an encoder it was *built* with whether or not a driver
  // exists, so this failure is reachable by choosing something the dialog
  // offered — and what ffmpeg says names a library or a session, never the
  // setting that caused it. Which encoders fail depends on the machine, so
  // this runs where one does and stands aside where none does.
  await openClip(page)
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  const encoder = dialog.getByLabel('Encoder')

  const offered = await encoder.locator('option:not([disabled])').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== 'auto'),
  )
  test.skip(offered.length === 0, 'this ffmpeg was built with no hardware encoders')

  await encoder.selectOption(offered[offered.length - 1])
  await dialog.getByLabel('File name').fill('hardware-attempt.mp4')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Either it worked — this machine has the driver — or the advice appears.
  // The queue shows the output name for a failed job too, so what counts as
  // "it worked" is a file on disk, not a name on screen.
  const advice = page.getByText('hardware encoder', { exact: false })
  const encoded = async () =>
    (await readdir(output).catch(() => [] as string[])).includes('hardware-attempt.mp4')

  await expect
    .poll(
      async () => ((await advice.isVisible()) ? 'advised' : (await encoded()) ? 'encoded' : ''),
      { timeout: 30_000 },
    )
    .not.toBe('')
})

test('draws the sound of the footage, and of what is laid under it', async ({ page }) => {
  // A canvas is the one thing that cannot be checked by reading the code: the
  // numbers may be right and nothing appear. This reads the pixels back.
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'music.mp3')

  const painted = async (index: number) =>
    page.locator('canvas').nth(index).evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')!
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let drawn = 0
      for (let at = 3; at < data.length; at += 4) if (data[at] > 0) drawn += 1
      return { drawn, total: data.length / 4 }
    })

  // The footage's own sound, once the peaks have come back from the server.
  await expect.poll(async () => (await painted(0)).drawn, { timeout: 20_000 }).toBeGreaterThan(0)

  const footage = await painted(0)
  // A tone fills much of the height, but a waveform is not a solid block.
  expect(footage.drawn).toBeLessThan(footage.total * 0.9)

  await page.getByRole('button', { name: 'Sound', exact: true }).click()
  await page.getByRole('menuitem', { name: /music\.mp3/ }).click()

  await expect(page.locator('canvas')).toHaveCount(2)
  await expect.poll(async () => (await painted(1)).drawn, { timeout: 20_000 }).toBeGreaterThan(0)
})

test('dissolves one clip into the next, and shortens the result by the overlap', async ({
  page,
}) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'second.mp4')
  await chip(page, 'holiday.mp4').click()
  await chip(page, 'second.mp4').click()
  await page.getByRole('button', { name: 'Add to timeline' }).click()

  // Six seconds and two, joined end to end.
  const readout = page.getByRole('heading', { name: 'Timeline' }).locator('..')
  await expect(readout).toContainText('/ 0:08.0')

  // Select the arriving clip and dissolve it into the one before.
  const arriving = (await clipBlocks(page, 'second.mp4'))[0]
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  await page.mouse.click(
    axis.x + axis.width * ((arriving.from + arriving.to) / 200),
    axis.y + 40,
  )

  await page.getByRole('slider', { name: 'Dissolve out of the one before' }).fill('1')

  // The command dissolves, and the timeline is a second shorter for it.
  await expect(page.locator('textarea')).toHaveValue(/xfade=transition=fade/)
  await expect(page.locator('textarea')).toHaveValue(/acrossfade/)
  await expect(readout).toContainText('/ 0:07.0')

  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('File name').fill('dissolved.mp4')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()

  const result = await waitForOutput(/^dissolved\.mp4$/)
  const seconds = Number(await probeWhenReady(join(output, result), 'format=duration'))
  // Seven seconds, give or take a frame — not the eight the clips add up to.
  expect(seconds).toBeGreaterThan(6.8)
  expect(seconds).toBeLessThan(7.2)
})

test('shows a different part of the clip when the timeline is zoomed', async ({ page }) => {
  // The block is drawn clipped to the visible window, so what fills it has to
  // be clipped the same way. Drawn from the whole clip instead, zooming
  // magnified the block and changed nothing inside it.
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await expect(page.locator('canvas')).toHaveCount(1)

  const frames = () =>
    page.locator('img[src*="/api/thumb"]').evaluateAll((nodes) =>
      nodes.map((node) => new URL((node as HTMLImageElement).src).searchParams.get('t')),
    )
  // The shape of the waveform, not how much of it there is: a signature that
  // changes when a different stretch of sound is drawn.
  const wave = () =>
    page.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
      const { width, height } = canvas
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, width, height)
      const heights: number[] = []
      for (let column = 0; column < 16; column += 1) {
        const x = Math.floor(((column + 0.5) / 16) * width)
        let painted = 0
        for (let y = 0; y < height; y += 1) if (data[(y * width + x) * 4 + 3] > 0) painted += 1
        heights.push(painted)
      }
      return heights.join(',')
    })

  await expect.poll(async () => (await frames()).length, { timeout: 20_000 }).toBeGreaterThan(1)
  await expect.poll(wave, { timeout: 20_000 }).not.toBe(new Array(16).fill(0).join(','))
  const wholeClip = await frames()
  const wholeWave = await wave()

  // Zoom in on the start: three presses, each taking a third off the window.
  await page.keyboard.press('Home')
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('Control+=')

  // The frames now come from the part on screen, so they sit earlier in the
  // file and cover a narrower range than before.
  await expect.poll(async () => (await frames())[0], { timeout: 20_000 }).not.toBe(wholeClip[0])
  const zoomed = (await frames()).map(Number)
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
  expect(spread(zoomed)).toBeLessThan(spread(wholeClip.map(Number)))

  // And the waveform is a different picture, not the same one stretched.
  await expect.poll(wave, { timeout: 20_000 }).not.toBe(wholeWave)
})

test('comes back to the same waveform when the zoom is undone', async ({ page }) => {
  // Zooming in fetches a closer look at the part on screen. That measurement
  // covers only the range it was asked for, so keeping it after the window has
  // moved on draws the wide view as a sliver of sound with silence either side.
  await openApp(page)
  await openFile(page, 'holiday.mp4')

  const wave = () =>
    page.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
      const { width, height } = canvas
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, width, height)
      const heights: number[] = []
      for (let column = 0; column < 24; column += 1) {
        const x = Math.floor(((column + 0.5) / 24) * width)
        let painted = 0
        for (let y = 0; y < height; y += 1) if (data[(y * width + x) * 4 + 3] > 0) painted += 1
        heights.push(painted)
      }
      return heights.join(',')
    })

  const silent = new Array(24).fill(0).join(',')
  await expect.poll(wave, { timeout: 20_000 }).not.toBe(silent)
  const before = await wave()

  // The closer look is only asked for past a certain zoom, so the test has to
  // go far enough in to provoke one — and then say that it did, or it would
  // pass just as well against the mistake it exists to catch.
  const closerLooks: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/peaks' && url.searchParams.has('from')) {
      closerLooks.push(url.search)
    }
  })

  await page.keyboard.press('Home')
  for (let press = 0; press < 7; press += 1) await page.keyboard.press('Control+=')
  await expect.poll(() => closerLooks.length, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect.poll(wave, { timeout: 20_000 }).not.toBe(before)

  await page.keyboard.press('Control+0')
  await expect.poll(wave, { timeout: 20_000 }).toBe(before)
})

test('drags a crop rectangle, and takes the whole drag back in one step', async ({ page }) => {
  await openClip(page)
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.getByRole('button', { name: 'Crop', exact: true }).first().click()

  const crop = async () =>
    /crop=(\d+):(\d+):(\d+):(\d+)/.exec(await page.locator('textarea').inputValue())?.[0]
  await expect.poll(crop).toBe('crop=320:240:0:0')

  // Pull the bottom-right corner in.
  const corner = async () => (await page.locator('[style*="nwse-resize"]').last().boundingBox())!
  const drag = async (from: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + dx, from.y + from.height / 2 + dy, { steps: 12 })
    await page.mouse.up()
  }

  await drag(await corner(), -120, -90)
  const shrunk = await crop()
  expect(shrunk).not.toBe('crop=320:240:0:0')

  // And back out again: a rectangle that has been made smaller can be made
  // larger, from the same handle, without being let go of first.
  await drag(await corner(), 90, 70)
  const grown = await crop()
  expect(grown).not.toBe(shrunk)
  const [, wideW, wideH] = /crop=(\d+):(\d+)/.exec(grown!)!
  const [, thinW, thinH] = /crop=(\d+):(\d+)/.exec(shrunk!)!
  expect(Number(wideW)).toBeGreaterThan(Number(thinW))
  expect(Number(wideH)).toBeGreaterThan(Number(thinH))

  // The top-left corner moves the rectangle off the edge it starts on.
  const topLeft = async () => (await page.locator('[style*="nwse-resize"]').first().boundingBox())!
  await drag(await topLeft(), 60, 50)
  const moved = await crop()
  expect(moved).toMatch(/crop=\d+:\d+:[1-9]\d*:[1-9]\d*/)
})

test('undoes a crop drag as one step, never half a rectangle', async ({ page }) => {
  // The four numbers of a crop mean nothing apart. Written one at a time, a
  // drag cost four steps of history per pointer move: undo restored a width
  // without its height — a rectangle that was never on screen — and a whole
  // gesture could not be taken back at all.
  await openClip(page)
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.getByRole('button', { name: 'Crop', exact: true }).first().click()

  const crop = async () =>
    /crop=\d+:\d+:\d+:\d+/.exec(await page.locator('textarea').inputValue())?.[0]
  await expect.poll(crop).toBe('crop=320:240:0:0')

  const corner = (await page.locator('[style*="nwse-resize"]').last().boundingBox())!
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
  await page.mouse.down()
  // Deliberately many small moves: this is what filled the history.
  await page.mouse.move(corner.x - 120, corner.y - 90, { steps: 30 })
  await page.mouse.up()
  expect(await crop()).not.toBe('crop=320:240:0:0')

  await page.keyboard.press('Control+z')
  expect(await crop()).toBe('crop=320:240:0:0')
})

test('marks to where the pointer is, not to how it got there', async ({ page }) => {
  // The edge used to be measured against a block that had already moved, so
  // every pointer move added the whole offset again: it ran away from the
  // pointer, faster the further out it went. A window is measured against the
  // workspace, which does not move — but the arithmetic still has to be even.
  await openClip(page)
  await markWhole(page)
  const length = async () => {
    const value = await page.locator('textarea').inputValue()
    return Number(/-t ([\d.]+)/.exec(value)?.[1] ?? 6)
  }

  const handle = (await page.getByRole('slider', { name: 'End of the kept part' }).boundingBox())!
  const originX = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2

  await page.mouse.move(originX, y)
  await page.mouse.down()
  const steps: number[] = []
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(originX - step * 12, y)
    steps.push(await length())
  }

  const gaps = steps.slice(1).map((value, index) => steps[index] - value)
  const widest = Math.max(...gaps)
  const narrowest = Math.min(...gaps)
  expect(widest - narrowest, `steps grew: ${gaps.map((g) => g.toFixed(3)).join(', ')}`).toBeLessThan(
    0.02,
  )

  // Back to where the gesture began, and the window is back where it started.
  await page.mouse.move(originX, y)
  const returned = await length()
  await page.mouse.up()
  expect(returned).toBeGreaterThan(5.9)
})

test('keeps a reversed clip on the timeline and cuts it from the right end', async ({ page }) => {
  // A reversed clip plays its source backwards, so the first second of its
  // block is the last second of the file. A window over the start of it has to
  // take the tail of the source, not the head.
  await openClip(page)
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  await page.mouse.click(axis.x + axis.width * 0.5, axis.y + 40)
  await page.getByRole('switch', { name: 'Backwards' }).click()
  await expect(page.locator('textarea')).toHaveValue(/reverse/)

  await markWhole(page)
  const handle = (await page.getByRole('slider', { name: 'End of the kept part' }).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x - 300, handle.y + handle.height / 2, { steps: 10 })
  await page.mouse.up()

  // Keeping the first part of a reversed block means seeking into the file,
  // because that part of the picture lives at the end of it.
  const command = await page.locator('textarea').inputValue()
  expect(Number(/-ss ([\d.]+)/.exec(command)?.[1] ?? 0)).toBeGreaterThan(0)
})

test('leaves the workspace the same length however much is kept', async ({ page }) => {
  // The ruler measures the workspace, and marking a window no longer changes
  // it — so the whole class of mistake where the axis rescales under a gesture
  // cannot arise. The footage stays put and the window moves over it.
  await openClip(page)
  const readout = () => page.getByRole('heading', { name: 'Timeline' }).locator('..')
  await expect(readout()).toContainText('/ 0:06.0')

  await markWhole(page)
  const handle = (await page.getByRole('slider', { name: 'End of the kept part' }).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  for (let step = 1; step <= 5; step += 1) {
    await page.mouse.move(handle.x + handle.width / 2 - step * 40, handle.y + handle.height / 2)
    await expect(readout()).toContainText('/ 0:06.0')
  }
  await page.mouse.up()
  await expect(readout()).toContainText('/ 0:06.0')
})

test('keeps the footage on the timeline and marks what to export', async ({ page }) => {
  // The complaint this answers: trimming used to cut the clip, so the timeline
  // showed the result, the block filled the axis again and there was nowhere
  // left to drag back to. The footage stays put; a window is marked over it.
  await openClip(page)
  const readout = () => page.getByRole('heading', { name: 'Timeline' }).locator('..')
  await expect(readout()).toContainText('/ 0:06.0')

  // Nothing marked keeps everything, and says so.
  await markWhole(page)
  await expect(readout()).toContainText('0:06.0')

  const edge = async (name: string) => (await page.getByRole('slider', { name }).boundingBox())!
  const drag = async (from: { x: number; y: number; width: number; height: number }, dx: number) => {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + dx, from.y + from.height / 2, { steps: 10 })
    await page.mouse.up()
  }

  // Pull the end of the window in. The workspace is untouched: still six
  // seconds of footage, but less of it kept.
  await drag(await edge('End of the kept part'), -200)
  await expect(readout()).toContainText('/ 0:06.0')
  const shortened = await page.locator('textarea').inputValue()
  expect(shortened).toMatch(/-t [\d.]+/)

  // And back out again, which is what could not be done before.
  await drag(await edge('End of the kept part'), 120)
  const grown = await page.locator('textarea').inputValue()
  const lengthOf = (command: string) => Number(/-t ([\d.]+)/.exec(command)?.[1] ?? 0)
  expect(lengthOf(grown)).toBeGreaterThan(lengthOf(shortened))
})

test('marks two windows and exports them joined', async ({ page }) => {
  // Several stretches of one recording, cut apart and put back together — the
  // thing that needed adding the same file twice before.
  await openClip(page)
  await markWhole(page)

  const first = (await page.getByRole('slider', { name: 'End of the kept part' }).boundingBox())!
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2 - 400, first.y + first.height / 2, { steps: 10 })
  await page.mouse.up()

  // Draw a second window on the bare part of the track.
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  const y = first.y + first.height / 2
  await page.mouse.move(axis.x + axis.width * 0.7, y)
  await page.mouse.down()
  await page.mouse.move(axis.x + axis.width * 0.9, y, { steps: 10 })
  await page.mouse.up()

  // Two windows: two seeks into the same file, joined.
  const command = await page.locator('textarea').inputValue()
  expect(command.match(/-i /g) ?? []).toHaveLength(2)
  expect(command).toContain('concat=n=2')

  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('File name').fill('two-windows.mp4')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()

  const result = await waitForOutput(/^two-windows\.mp4$/)
  const seconds = Number(await probeWhenReady(join(output, result), 'format=duration'))
  // Shorter than the six seconds it was cut from, and longer than nothing.
  expect(seconds).toBeGreaterThan(0.5)
  expect(seconds).toBeLessThan(5.5)
})

test('marks a second window with the button, without hunting for bare track', async ({
  page,
}) => {
  // Dragging bare track works, but a thirty-pixel row is a poor place to have
  // to find one. The button marks from the playhead to wherever the next kept
  // part begins, and says so when there is nothing to mark.
  await openClip(page)
  const keep = page.getByRole('button', { name: 'Keep from here' })

  // Nothing marked keeps everything, so there is nothing to add yet.
  await expect(keep).toBeDisabled()

  // Mark the first two seconds by dragging, leaving the rest bare.
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  const y = axis.y + 52 + 16 + 15
  await page.mouse.move(axis.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(axis.x + axis.width / 3, y, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByRole('slider', { name: 'End of the kept part' })).toHaveCount(1)

  // Put the playhead in the bare part and press the button.
  await page.mouse.click(axis.x + axis.width * 0.7, axis.y + 8)
  await expect(keep).toBeEnabled()
  await keep.click()
  await expect(page.getByRole('slider', { name: 'End of the kept part' })).toHaveCount(2)

  // Two windows, two seeks into the file, joined.
  const command = await page.locator('textarea').inputValue()
  expect(command.match(/-i /g) ?? []).toHaveLength(2)
  expect(command).toContain('concat=n=2')

  // Inside a window there is nothing to add, and the button says so.
  await page.mouse.click(axis.x + axis.width * 0.1, axis.y + 8)
  await expect(keep).toBeDisabled()
})

test('empties the workspace when told to', async ({ page }) => {
  await openClip(page)
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()

  await page.getByRole('button', { name: 'Clear' }).click()

  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeHidden()
  await expect(page.getByText('No file yet', { exact: false }).first()).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
})

test('puts a caption on the picture for part of the timeline', async ({ page }) => {
  await openClip(page)

  // Adding is done from under the track it fills, not from the file strip.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('Text', { exact: true }).fill("50% off: don't miss it")

  await page.getByLabel('Shows at', { exact: true }).fill('00:00:01.0')
  await page.getByLabel('Shows at', { exact: true }).press('Enter')
  await page.getByLabel('Hides at', { exact: true }).fill('00:00:03.0')
  await page.getByLabel('Hides at', { exact: true }).press('Enter')

  await expect(page.locator('textarea')).toHaveValue(/drawtext/)
  await expect(page.locator('textarea')).toHaveValue(/between\(t,1\.000,3\.000\)/)

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('puts a picture in the sequence as a card of its own', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'logo.png')

  await chip(page, 'holiday.mp4').click()
  await chip(page, 'logo.png').click()
  await page.getByRole('button', { name: /Add to timeline/ }).click()

  // A picture has no duration of its own; without a default it would be a
  // zero-length segment and the join would produce nothing.
  await expect(page.locator('textarea')).toHaveValue(/concat=n=2/)

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('draws several things over the picture, each on its own row', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'logo.png')

  await page.getByRole('button', { name: 'Picture', exact: true }).click()
  await page.getByRole('menuitem', { name: /logo\.png/ }).click()

  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('Text', { exact: true }).fill('first')
  await page.getByLabel('Hides at', { exact: true }).fill('00:00:03.0')
  await page.getByLabel('Hides at', { exact: true }).press('Enter')

  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('Text', { exact: true }).fill('second')
  await page.getByLabel('Shows at', { exact: true }).fill('00:00:02.0')
  await page.getByLabel('Shows at', { exact: true }).press('Enter')

  const rows = await blocks(page)
  const logo = rows.find((block) => block.text.includes('logo.png'))!
  const first = rows.find((block) => block.text.startsWith('first'))!
  const second = rows.find((block) => block.text.startsWith('second'))!

  // Three overlays, three different rows: sharing one put whatever was on
  // screen at the same moment on top of each other here too.
  expect(new Set([logo.top, first.top, second.top]).size).toBe(3)

  // The clip is six seconds, so three seconds is half the axis.
  expect(first.from).toBeCloseTo(0, 0)
  expect(first.to).toBeCloseTo(50, 0)
  expect(second.from).toBeCloseTo(33.3, 0)

  // And all three are in the command, in order.
  const command = await page.locator('textarea').inputValue()
  expect(command).toContain('overlay=')
  expect(command.match(/drawtext/g)).toHaveLength(2)
})

test('shows the preview of an overlay on the picture itself', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'logo.png')

  await page.getByRole('button', { name: 'Picture', exact: true }).click()
  await page.getByRole('menuitem', { name: /logo\.png/ }).click()

  // Drawn in the browser over the video, not encoded by ffmpeg to find out.
  const drawn = page.getByRole('group', { name: 'On top' }).locator('img')
  await expect(drawn).toBeVisible()

  const video = (await page.locator('video').boundingBox())!
  const logo = (await drawn.boundingBox())!
  expect(logo.x).toBeGreaterThanOrEqual(video.x - 1)
  expect(logo.y).toBeGreaterThanOrEqual(video.y - 1)
  expect(logo.width).toBeLessThan(video.width)

  // Outside its window it is not on screen, the same as in the result. The
  // playhead is still at zero, so moving the overlay's start past it is enough.
  await page.getByLabel('Shows at', { exact: true }).fill('00:00:02.0')
  await page.getByLabel('Shows at', { exact: true }).press('Enter')
  await expect(drawn).toBeHidden()
})

test('shows a clip laid over the picture, and the frame it will be showing', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'second.mp4')

  await page.getByRole('button', { name: 'Picture', exact: true }).click()
  await page.getByRole('menuitem', { name: /second\.mp4/ }).click()

  // A clip gets its own length, not the whole timeline: second.mp4 is two
  // seconds of the clip's six, and saying otherwise promised it would be on
  // screen when it has nothing left to show.
  await expect(page.getByLabel('Hides at', { exact: true })).toHaveValue('00:00:02.000')

  await page.getByLabel('Shows at', { exact: true }).fill('00:00:01.0')
  await page.getByLabel('Shows at', { exact: true }).press('Enter')

  // Scrub to four seconds by clicking the ruler, which is where anyone would
  // try: every other row is covered by a block that selects itself instead.
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  // A quarter along a six-second clip is 1.5s, which is inside the overlay's
  // own two-second window rather than past the end of it.
  await page.mouse.click(axis.x + axis.width * 0.25, axis.y + 8)
  await expect(page.getByRole('heading', { name: 'Timeline' }).locator('..')).toContainText('0:01')

  // A clip cannot be drawn as an `<img>` of an mp4, which showed nothing at
  // all — not the picture, not even where it was. It is a frame now, taken at
  // the clip's own time, counted from where it appears.
  const drawn = page.getByRole('group', { name: 'On top' }).locator('img').first()
  await expect(drawn).toBeVisible()

  const video = (await page.locator('video').boundingBox())!
  const box = (await drawn.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(video.x - 1)
  expect(box.width).toBeLessThan(video.width)

  await expect(page.locator('textarea')).toHaveValue(/setpts=PTS-STARTPTS\+1\.000\/TB/)
})

test('moves and resizes an overlay by dragging it on the picture', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'logo.png')

  await page.getByRole('button', { name: 'Picture', exact: true }).click()
  await page.getByRole('menuitem', { name: /logo\.png/ }).click()

  const drawn = page.getByRole('group', { name: 'On top' }).locator('img').first()
  await expect(drawn).toBeVisible()
  const before = (await drawn.boundingBox())!

  // Drag the picture itself, not a slider in a panel: the position is a
  // fraction of the frame on both sides, so moving it here moves it in the
  // command.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 60, { steps: 8 })
  await page.mouse.up()

  const moved = (await drawn.boundingBox())!
  expect(moved.x).toBeGreaterThan(before.x + 40)
  expect(moved.y).toBeGreaterThan(before.y + 20)

  const command = await page.locator('textarea').inputValue()
  expect(command).toMatch(/overlay=x=\(W-w\)\*0\.[1-9]/)

  // And the corner handle changes how big it is — staying under the cursor,
  // which it did not: widening an overlay slides its left edge left as well, so
  // a size accumulated from the pointer's travel left the grip trailing behind
  // and dragging back did not undo it. The far corner is pinned instead.
  const handle = page.getByRole('slider', { name: 'Drag to resize' })
  const grip = (await handle.boundingBox())!
  const gripX = grip.x + grip.width / 2
  const gripY = grip.y + grip.height / 2

  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  await page.mouse.move(gripX + 90, gripY, { steps: 8 })

  const held = (await handle.boundingBox())!
  expect(Math.abs(held.x + held.width / 2 - (gripX + 90))).toBeLessThan(8)

  const bigger = (await drawn.boundingBox())!
  expect(bigger.width).toBeGreaterThan(moved.width + 40)

  // Dragging back is the exact inverse.
  await page.mouse.move(gripX, gripY, { steps: 8 })
  await page.mouse.up()

  const restored = (await drawn.boundingBox())!
  expect(Math.abs(restored.width - moved.width)).toBeLessThan(4)

  // Letting go really lets go.
  await page.mouse.move(gripX + 200, gripY + 150, { steps: 8 })
  expect((await drawn.boundingBox())!.width).toBeCloseTo(restored.width, 0)
})

test('stops resizing when the browser takes the gesture over', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'logo.png')

  await page.getByRole('button', { name: 'Picture', exact: true }).click()
  await page.getByRole('menuitem', { name: /logo\.png/ }).click()

  const drawn = page.getByRole('group', { name: 'On top' }).locator('img').first()
  const grip = page.getByRole('slider', { name: 'Drag to resize' })
  const box = (await grip.boundingBox())!

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, box.y, { steps: 4 })

  // A drag does not only end with `pointerup`. The browser sends
  // `pointercancel` when it takes the gesture over — a native image drag, a
  // touch that becomes a scroll — and no release ever follows. Waiting only for
  // one left the overlay following a button nobody was holding down.
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })),
  )
  const atCancel = (await drawn.boundingBox())!.width

  await page.mouse.move(box.x + 240, box.y + 180, { steps: 8 })
  expect((await drawn.boundingBox())!.width).toBeCloseTo(atCancel, 0)
  await page.mouse.up()
})

test('shows a soundtrack that outlasts the picture, and where the result ends', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'music.mp3')

  await page.getByRole('button', { name: 'Sound', exact: true }).click()
  await page.getByRole('menuitem', { name: /music\.mp3/ }).click()

  // The clip is six seconds and the music is eight, so the axis has to reach
  // eight or the thing just added would be drawn off the end of the track. It
  // widens in the render after the sound lands, so this polls rather than
  // reading once: measuring mid-update is a race, not a failure.
  await expect
    .poll(async () => {
      const rows = await blocks(page)
      return rows.find((block) => block.text.includes('holiday.mp4'))?.to
    })
    .toBeCloseTo(75, 0)

  const rows = await blocks(page)
  expect(rows.find((block) => block.text.includes('music.mp3'))!.to).toBeCloseTo(100, 0)

  await expect(page.getByText('the result ends here')).toBeVisible()
})

test('lays several sounds down, each on its own row', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'music.mp3')

  // Picking the file is explicit. It used to take whatever was ticked in the
  // strip above, so pressing this with the footage ticked laid the footage over
  // itself — reasonable and not what anyone asked for.
  await page.getByRole('button', { name: 'Sound', exact: true }).click()
  await page.getByRole('menuitem', { name: /music\.mp3/ }).click()
  await page.getByLabel('Starts at', { exact: true }).fill('00:00:00.0')
  await page.getByLabel('Starts at', { exact: true }).press('Enter')

  await page.getByRole('button', { name: 'Sound', exact: true }).click()
  await page.getByRole('menuitem', { name: /music\.mp3/ }).click()
  await page.getByLabel('Starts at', { exact: true }).fill('00:00:02.0')
  await page.getByLabel('Starts at', { exact: true }).press('Enter')

  await expect
    .poll(async () => (await blocks(page)).filter((b) => b.text.includes('music.mp3')).length)
    .toBe(2)

  const rows = (await blocks(page)).filter((block) => block.text.includes('music.mp3'))
  expect(new Set(rows.map((block) => block.top)).size).toBe(2)
  expect(rows[1].from).toBeGreaterThan(rows[0].from)

  // The footage's own sound and both of theirs go into one mix.
  await expect(page.locator('textarea')).toHaveValue(/amix=inputs=3/)

  await exportNow(page)
  expect(await waitForOutput(/^holiday-video.*\.mp4$/)).toBeTruthy()
})

test('moves the picture when the playhead moves', async ({ page }) => {
  await openClip(page)

  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  const at = (fraction: number) => page.mouse.click(axis.x + axis.width * fraction, axis.y + 8)
  const shown = () => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)

  // The clip is six seconds. Clicking the ruler moved the marker and left the
  // frame where it was: the playhead drove the overlays but nothing drove the
  // picture.
  await at(0.5)
  await expect.poll(shown).toBeCloseTo(3, 0)

  await at(0.25)
  await expect.poll(shown).toBeCloseTo(1.5, 0)
})

test('keeps the marker on the right clip while a join plays', async ({ page }) => {
  await openApp(page)
  await openFile(page, 'holiday.mp4')
  await openFile(page, 'second.mp4')

  // holiday is already on the track, so ticking it again unticks it and only
  // second is added.
  await chip(page, 'holiday.mp4').click()
  await chip(page, 'second.mp4').click()
  await page.getByRole('button', { name: 'Add to timeline' }).click()
  await expect(page.locator('textarea')).toHaveValue(/concat=n=2/)
  // The axis widens in the render after the clip lands, so clicking before it
  // has caught up puts the playhead somewhere else entirely.
  await expect(page.getByRole('heading', { name: 'Timeline' }).locator('..')).toContainText('0:08.0')

  // Six seconds of the first clip, then two of the second. Seven seconds along
  // is one second into the second clip — the element reports 1, which is not
  // where the playhead is, and taking one for the other put the marker back at
  // the first second of the timeline.
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  await page.mouse.click(axis.x + axis.width * 0.875, axis.y + 8)

  await expect(page.getByRole('heading', { name: 'Timeline' }).locator('..')).toContainText('0:07')
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(1, 0)

  // Playing is what makes the element report its own time back, and that is the
  // moment the two clocks can disagree: taking the element's 1 for the
  // timeline's put the marker back at the first second of eight.
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    await video.play()
    await new Promise((resolve) => setTimeout(resolve, 500))
    video.pause()
  })
  await expect(page.getByRole('heading', { name: 'Timeline' }).locator('..')).toContainText('0:07')
})

test('reports a failure instead of pretending it worked', async ({ page }) => {
  await openClip(page)

  const command = page.locator('textarea')
  await command.fill('ffmpeg -i holiday.mp4 -vf definitely_not_a_filter=1 broken.mp4')
  await expect(page.getByText('Edited by hand', { exact: false })).toBeVisible()

  await exportNow(page)
  await expect(page.locator('body')).toContainText(/No such filter|Error|failed/i, {
    timeout: 45_000,
  })
})

test('copies a dropped file and opens it', async ({ page }) => {
  await openApp(page)

  await page.evaluate(async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], 'dropped.mp4', { type: 'video/mp4' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const target = document.querySelector('main') ?? document.body
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })

  await expect(page.getByText('dropped.mp4').first()).toBeVisible({ timeout: 15_000 })
})

test('keeps working in Russian', async ({ page }) => {
  await openClip(page)
  await page.getByTitle('Switch language').click()

  await expect(page.getByRole('heading', { name: 'Таймлайн' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Экспорт…' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Очистить' })).toBeVisible()
})
