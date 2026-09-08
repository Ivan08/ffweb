/**
 * The pictures in the README, taken from the built binary in a real browser.
 *
 * Kept as a test rather than done by hand so the documentation cannot drift
 * away from the interface without anyone noticing: `make screenshots` retakes
 * every one of them, and it fails the moment a control it names is gone.
 *
 * The footage is drawn here rather than downloaded: `fixtures/*.svg` are cat
 * scenes with their movement written as SMIL, so stepping the animation and
 * screenshotting each step gives real frames. That keeps the pictures free of
 * anyone else's video and keeps `make screenshots` working offline.
 *
 * It is skipped by the ordinary run — these produce pictures, not assertions.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type Browser, type Page } from '@playwright/test'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const OUT = join(repo, 'docs', 'screenshots')
const FPS = 25
/** The scenes loop over two seconds, so that is how much has to be drawn. */
const LOOP = 2

let server: ChildProcess
let baseUrl: string
let D: string

/**
 * Draw one animated scene as a run of frames.
 *
 * The animation is paused and then stepped by hand: left to play, a screenshot
 * would land wherever the clock happened to be, and the frames would not be
 * evenly spaced or reproducible.
 */
async function drawFrames(browser: Browser, scene: string, into: string) {
  const svg = await readFile(join(here, 'fixtures', `${scene}.svg`), 'utf8')
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
  await page.setContent(`<body style="margin:0">${svg}</body>`)
  await page.evaluate(() => (document.querySelector('svg') as SVGSVGElement).pauseAnimations())
  await mkdir(into, { recursive: true })
  for (let frame = 0; frame < LOOP * FPS; frame += 1) {
    await page.evaluate((seconds) => {
      (document.querySelector('svg') as SVGSVGElement).setCurrentTime(seconds)
    }, frame / FPS)
    await page.screenshot({ path: join(into, `${String(frame).padStart(3, '0')}.png`) })
  }
  await page.close()
}

/** One scene as a clip of the given length, looping the drawn seconds. */
async function scene(browser: Browser, name: string, seconds: number, tone: number, to: string) {
  const frames = join(D, 'frames', name)
  await drawFrames(browser, name, frames)
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-stream_loop', '-1', '-framerate', String(FPS), '-i', join(frames, '%03d.png'),
    '-f', 'lavfi', '-i', `sine=frequency=${tone}`,
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', to])
}

test.beforeAll(async ({ browser }) => {
  D = await mkdtemp(join(tmpdir(), 'ffweb-shots-'))
  const media = join(D, 'media')
  await mkdir(media, { recursive: true })
  await mkdir(join(D, 'out'), { recursive: true })

  await scene(browser, 'cat-day', 7, 220, join(media, 'кот.mp4'))
  await scene(browser, 'cat-evening', 5, 330, join(media, 'вечер.mp4'))

  const paw = await browser.newPage({ viewport: { width: 200, height: 200 } })
  await paw.setContent(`<body style="margin:0">${await readFile(join(here, 'fixtures', 'paw.svg'), 'utf8')}</body>`)
  await paw.screenshot({ path: join(media, 'лапка.png'), omitBackground: true })
  await paw.close()

  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', '30', '-i', 'sine=frequency=440', '-c:a', 'libmp3lame',
    join(media, 'музыка.mp3')])

  server = spawn(join(repo, 'target', 'release', 'ffweb'),
    ['--port', '0', '--no-open', '--no-token', '--root', media, '--out', join(D, 'out')])
  baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no url')), 20000)
    let buffered = ''
    server.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(buffered)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
})
test.afterAll(() => server?.kill('SIGTERM'))

async function open(page: Page, name: string) {
  await page.getByRole('button', { name: 'Открыть', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).first().click()
  await expect(dialog).toBeHidden()
}
const chip = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).first()

async function start(page: Page, theme: 'dark' | 'light') {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(baseUrl)
  await page.evaluate((t) => {
    localStorage.setItem('ffweb.lang', 'ru')
    localStorage.setItem('ffweb.theme', t)
    localStorage.setItem('ffweb.autoDownload', '0')
  }, theme)
  await page.goto(baseUrl)
}

/** Build the timeline the wide shots are of. */
async function compose(page: Page) {
  await open(page, 'кот.mp4')
  await open(page, 'вечер.mp4')
  await open(page, 'лапка.png')
  await open(page, 'музыка.mp3')
  await expect(page.locator('video')).toBeVisible()

  await chip(page, 'кот.mp4').click()
  await chip(page, 'вечер.mp4').click()
  await page.getByRole('button', { name: 'На таймлайн' }).click()
  await expect(page.locator('textarea')).toHaveValue(/concat=n=2/)
  // 7 секунд первого клипа плюс 5 второго.
  await expect(page.getByRole('heading', { name: 'Таймлайн' }).locator('..')).toContainText('0:12.0')

  await page.getByRole('button', { name: 'Картинка', exact: true }).click()
  await page.getByRole('menuitem', { name: /лапка\.png/ }).click()
  await page.getByLabel('Исчезает', { exact: true }).fill('00:00:06.000')
  await page.getByLabel('Исчезает', { exact: true }).press('Enter')
  // A logo sits in a corner rather than over the subject, and the sliders are
  // the honest way to say so: whatever they set is what the command carries.
  await page.getByLabel('Размер', { exact: true }).fill('16')
  await page.getByLabel('По горизонтали', { exact: true }).fill('94')
  await page.getByLabel('По вертикали', { exact: true }).fill('8')

  await page.getByRole('button', { name: 'Текст', exact: true }).click()
  await page.getByLabel('Текст', { exact: true }).fill('Кот на подоконнике')
  await page.getByLabel('Появляется', { exact: true }).fill('00:00:01.000')
  await page.getByLabel('Появляется', { exact: true }).press('Enter')
  await page.getByLabel('Исчезает', { exact: true }).fill('00:00:08.000')
  await page.getByLabel('Исчезает', { exact: true }).press('Enter')

  await page.getByRole('button', { name: 'Звук', exact: true }).click()
  await page.getByRole('menuitem', { name: /музыка\.mp3/ }).click()

  // Ось тянется до 30 секунд из-за музыки, поэтому доля небольшая: нужен
  // момент, где на экране разом и лапка (0–6), и надпись (1–8).
  const axis = await page.evaluate(() => {
    const box = document.querySelector('[class*="relative min-w-0 flex-1"]')!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  })
  await page.mouse.click(axis.x + axis.width * 0.12, axis.y + 8)

  // Справа — настройки надписи: панель следует за выбранным на таймлайне.
  await page.getByText('Кот на подоконнике').last().click()
  await page.waitForTimeout(1200)
}

test('обзор', async ({ page }) => {
  await start(page, 'dark')
  await compose(page)
  await page.screenshot({ path: `${OUT}/overview.png` })
})

test('светлая тема', async ({ page }) => {
  await start(page, 'light')
  await compose(page)
  await page.screenshot({ path: `${OUT}/light.png` })
})

test('экспорт', async ({ page }) => {
  await start(page, 'dark')
  await compose(page)
  await page.getByRole('button', { name: 'Экспорт…' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/export.png` })
})

test('кадрирование', async ({ page }) => {
  await start(page, 'dark')
  await open(page, 'кот.mp4')
  await expect(page.locator('video')).toBeVisible()
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.getByRole('button', { name: 'Кадрировать' }).click()
  await page.waitForTimeout(900)

  // The rectangle starts as the whole frame, which shows the editor but not
  // what it is for. Pull two corners in so the picture, the darkened surround
  // and the command underneath all say the same thing.
  const frame = (await page.locator('video').boundingBox())!
  const drag = async (fromX: number, fromY: number, toX: number, toY: number) => {
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2)
    await page.mouse.move(toX, toY)
    await page.mouse.up()
  }
  await drag(frame.x, frame.y,
             frame.x + frame.width * 0.17, frame.y + frame.height * 0.20)
  await drag(frame.x + frame.width, frame.y + frame.height,
             frame.x + frame.width * 0.88, frame.y + frame.height * 0.86)
  await expect(page.locator('textarea')).toHaveValue(/crop=\d+:\d+:[1-9]/)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/crop.png` })
})
