// Cross-origin image loading.
//
// Content scripts are bound by the page's CORS rules in MV3, so a Steam CDN image
// that has no Access-Control-Allow-Origin header would taint the canvas and break
// export. The service worker has host permissions and can fetch anything, so we
// fall back to it and hand the bytes back as a data URL.

export interface FetchResult {
  bytes: Uint8Array
  mime: string
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

function guessMime(url: string, fallback = 'image/png'): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || fallback
}

function dataUrlToBytes(url: string): FetchResult {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('Некорректный data URL')
  const header = url.slice(0, comma)
  const body = url.slice(comma + 1)
  const mime = /data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream'
  if (/;base64/i.test(header)) {
    const bin = atob(body)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, mime }
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime }
}

async function directFetch(url: string): Promise<FetchResult> {
  const res = await fetch(url, { credentials: 'omit', mode: 'cors' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { bytes, mime: res.headers.get('content-type')?.split(';')[0] || guessMime(url) }
}

function hasExtensionRuntime(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.runtime.sendMessage
  } catch {
    return false
  }
}

async function viaServiceWorker(url: string): Promise<FetchResult> {
  const response = (await chrome.runtime.sendMessage({ type: 'spd:fetch', url })) as
    | { ok: true; dataUrl: string; mime: string }
    | { ok: false; error: string }
    | undefined
  if (!response) throw new Error('Расширение не ответило на запрос изображения')
  if (!response.ok) throw new Error(response.error)
  const result = dataUrlToBytes(response.dataUrl)
  return { bytes: result.bytes, mime: response.mime || result.mime }
}

/** Fetch bytes for an image URL, blob URL or data URL. */
export async function fetchBytes(url: string): Promise<FetchResult> {
  if (url.startsWith('data:')) return dataUrlToBytes(url)
  if (url.startsWith('blob:')) return directFetch(url)
  try {
    return await directFetch(url)
  } catch (error) {
    if (!hasExtensionRuntime()) {
      throw new Error(
        `Не удалось загрузить изображение (${error instanceof Error ? error.message : 'ошибка сети'}). ` +
          'Попробуйте выбрать файл с компьютера.',
      )
    }
    return viaServiceWorker(url)
  }
}

/** Decode an image to an ImageBitmap that is safe to draw on a canvas. */
export async function loadBitmap(url: string): Promise<ImageBitmap> {
  const { bytes, mime } = await fetchBytes(url)
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
  return createImageBitmap(blob)
}

export async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const { bytes, mime } = await fetchBytes(url)
  const blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
  try {
    const img = new Image()
    img.decoding = 'sync'
    img.src = blobUrl
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/** Read the real pixel size of a remote image. */
export async function probeImage(url: string): Promise<{ width: number; height: number }> {
  const bitmap = await loadBitmap(url)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
}

export function readFileAsBytes(file: Blob): Promise<Uint8Array> {
  return file.arrayBuffer().then((buf) => new Uint8Array(buf))
}

export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 5 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length > 11 && bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp'
  return 'image/png'
}

/**
 * Video container sniffing.
 *
 * Browsers report `file.type` unreliably (Windows often sends an empty string
 * for `.webm`), so the bytes decide. MP4/MOV share the `ftyp` box at offset 4;
 * WebM/Matroska start with the EBML header. Returns `''` for anything else.
 */
export function sniffVideoMime(bytes: Uint8Array): string {
  if (
    bytes.length > 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
    if (brand.startsWith('qt')) return 'video/quicktime'
    return 'video/mp4'
  }
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm'
  }
  return ''
}

/** Does this file look like a video we can sample into frames? */
export function isVideoFile(file: File, bytes?: Uint8Array): boolean {
  if (file.type.startsWith('video/')) return true
  if (!bytes) return false
  return sniffVideoMime(bytes) !== ''
}
