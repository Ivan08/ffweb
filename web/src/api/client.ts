/**
 * Talking to the local ffweb process.
 *
 * The access token arrives once in the page URL and the server turns it into a
 * cookie, so requests need no special handling after the first load. It is kept
 * here anyway for the dev server, which is a different origin and gets no cookie.
 */

import type {
  Capabilities,
  FsListing,
  JobEventMessage,
  MediaInfo,
  Peaks,
  WasmCacheStatus,
} from '../core/types'

function readToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    try {
      sessionStorage.setItem('ffweb_token', fromUrl)
    } catch {
      // Private windows can refuse storage; the cookie still carries the token.
    }
    // Keep the token out of the address bar so it does not end up in a
    // screenshot or a pasted link.
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    window.history.replaceState({}, '', url)
    return fromUrl
  }
  try {
    return sessionStorage.getItem('ffweb_token')
  } catch {
    return null
  }
}

const token = readToken()

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function headers(extra?: HeadersInit): HeadersInit {
  const result: Record<string, string> = {}
  if (extra) Object.assign(result, extra)
  if (token) result.Authorization = `Bearer ${token}`
  return result
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: headers(init?.headers) })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (body && typeof body.error === 'string') message = body.error
    } catch {
      // A non-JSON error body is still worth surfacing verbatim.
      const text = await response.text().catch(() => '')
      if (text) message = text
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

/** Append the token to a URL used by <video>, <img> or a download link. */
export function withToken(url: string): string {
  if (!token || url.includes('token=')) return url
  const joiner = url.includes('?') ? '&' : '?'
  return `${url}${joiner}token=${encodeURIComponent(token)}`
}

export const api = {
  capabilities: () => request<Capabilities>('/api/capabilities'),

  browse: (path?: string) =>
    request<FsListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  probe: (path: string) => request<MediaInfo>(`/api/probe?path=${encodeURIComponent(path)}`),

  fileUrl: (path: string) => withToken(`/api/file?path=${encodeURIComponent(path)}`),

  thumbUrl: (path: string, at: number, width = 640) =>
    withToken(`/api/thumb?path=${encodeURIComponent(path)}&t=${at}&w=${width}`),

  /**
   * The loudness of a file over time, for drawing an audio track.
   *
   * A plain request rather than a URL for an element to load: this is numbers
   * for the canvas to draw, so it goes through `fetch` with the token in a
   * header like everything else that is read by code.
   */
  peaks: (path: string, buckets = 2000, from?: number, to?: number) => {
    const query = new URLSearchParams({ path, buckets: String(buckets) })
    if (from !== undefined) query.set('from', String(from))
    if (to !== undefined) query.set('to', String(to))
    return request<Peaks>(`/api/peaks?${query.toString()}`)
  },

  upload: async (files: File[]) => {
    const body = new FormData()
    for (const file of files) body.append('file', file, file.name)
    return request<{ files: Array<{ name: string; path: string; size: number }> }>('/api/files', {
      method: 'POST',
      body,
    })
  },

  createJob: (payload: {
    inputs: string[]
    args: string[]
    output: string
    duration?: number
    label?: string
  }) =>
    request<{ id: string; command: string[]; output: string }>('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  cancelJob: (id: string) =>
    request<{ canceled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  job: (id: string) => request<{ output_size: number | null; state: string }>(`/api/jobs/${id}`),

  wasmStatus: () => request<WasmCacheStatus>('/api/wasm/status'),

  fetchWasm: () => request<WasmCacheStatus>('/api/wasm/fetch', { method: 'POST' }),
}

/**
 * Subscribe to a job's events. Returns a function that closes the stream.
 *
 * `EventSource` cannot send an Authorization header, so the token rides in the
 * query string here; the server accepts it either way.
 */
export function subscribeToJob(
  id: string,
  onEvent: (event: JobEventMessage) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource(withToken(`/api/jobs/${id}/events`))
  let finished = false

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as JobEventMessage
      if (event.type === 'state' && event.state && event.state !== 'queued' && event.state !== 'running') {
        finished = true
      }
      onEvent(event)
      // The server ends the stream after the terminal state; closing from this
      // side too stops EventSource from reconnecting to a finished job.
      if (finished) source.close()
    } catch (error) {
      onError?.(error as Error)
    }
  }

  source.onerror = () => {
    if (finished) return
    source.close()
    onError?.(new Error('lost the connection to the job stream'))
  }

  return () => {
    finished = true
    source.close()
  }
}
