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
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
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
  await expect(page.getByRole('slider', { name: 'Start of the clip' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'End of the clip' })).toBeVisible()
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

test('trims a clip by its handle and writes the result to disk', async ({ page }) => {
  await openClip(page)

  const handle = (await page.getByRole('slider', { name: 'End of the clip' }).boundingBox())!
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
