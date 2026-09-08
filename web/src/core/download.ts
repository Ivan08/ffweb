/** Saving a result, wherever it happens to live. */

import { withToken } from '../api/client'
import type { Job } from './types'

/** Where a finished result can be fetched from, whichever engine produced it. */
export function resultUrl(job: Job): string | null {
  if (job.outputUrl) return job.outputUrl
  if (job.outputPath) return `/api/file?path=${encodeURIComponent(job.outputPath)}`
  return null
}

/**
 * Save a result to the browser's downloads.
 *
 * Native results are already files on disk and this makes a second copy, so it
 * is offered rather than done automatically there. A browser-engine result
 * exists only as a blob in the tab, and would be lost on reload if it were not
 * saved.
 */
export function download(url: string, name: string, isObjectUrl: boolean) {
  const link = document.createElement('a')
  link.href = isObjectUrl ? url : withToken(url)
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
}

export function downloadJob(job: Job) {
  const url = resultUrl(job)
  if (url) download(url, job.outputName, Boolean(job.outputUrl))
}
