import { parseGIF, decompressFrames } from 'gifuct-js'
import type { AssetMeta, Rect } from './types'
import { sniffImageMime } from './net'

export interface GifFrame {
  bitmap: ImageBitmap
  /** Frame delay in ms, already clamped to something browsers can show. */
  delay: number
}

export interface GifAsset {
  width: number
  height: number
  frames: GifFrame[]
  duration: number
  /**
   * Profile-px area the frames cover. Video frames cropped to the showcase set
   * this so the renderer can put them back in the right place; full-frame GIFs
   * leave it undefined and fill the 1920 px plate.
   */
  region?: Rect
}

/** Progress of a GIF decode: `total` frames parsed, `done` already copied. */
export type GifProgress = (done: number, total: number) => void

// A GIF that decodes to more than this many pixels would eat gigabytes once every
// frame is an ImageBitmap. Reject it with a clear message instead of crashing.
const MAX_GIF_PIXELS = 80_000_000
const MAX_GIF_SIDE = 4096

export function isGifBytes(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
}

/**
 * Decode a GIF into full-size frames, honouring disposal methods, so every frame
 * can be drawn as a normal image.
 */
export async function decodeGif(bytes: Uint8Array, onProgress?: GifProgress): Promise<GifAsset> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const parsed = parseGIF(buffer)
  const width = parsed.lsd.width
  const height = parsed.lsd.height
  if (width > MAX_GIF_SIDE || height > MAX_GIF_SIDE) {
    throw new Error(`GIF ${width}×${height} слишком большой: поддерживается до ${MAX_GIF_SIDE} px по стороне`)
  }
  // Let the caller paint a loading state before the synchronous parse below.
  // decompressFrames blocks the main thread for hundreds of ms on a big GIF, so
  // a plain microtask/timer is not enough: React still has to commit and the
  // browser still has to paint. Wait for two animation frames, with a timer
  // fallback for hidden tabs where rAF never fires.
  onProgress?.(0, 0)
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    requestAnimationFrame(() => requestAnimationFrame(finish))
    window.setTimeout(finish, 120)
  })
  const raw = decompressFrames(parsed, true)
  if (!raw.length) throw new Error('В GIF не найдено ни одного кадра')
  if (width * height * raw.length > MAX_GIF_PIXELS) {
    throw new Error(
      `GIF слишком тяжёлый для обработки в браузере (${raw.length} кадров ${width}×${height}). ` +
        'Уменьшите размер или число кадров.',
    )
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) throw new Error('Canvas 2D недоступен')

  const patchCanvas = document.createElement('canvas')
  const patchCtx = patchCanvas.getContext('2d')
  if (!patchCtx) throw new Error('Canvas 2D недоступен')

  const frames: GifFrame[] = []
  let previous: { disposal: number; left: number; top: number; width: number; height: number } | null = null
  let saved: ImageData | null = null

  for (const frame of raw) {
    if (previous) {
      if (previous.disposal === 2) {
        ctx.clearRect(previous.left, previous.top, previous.width, previous.height)
      } else if (previous.disposal === 3 && saved) {
        ctx.putImageData(saved, 0, 0)
      }
    }
    saved = frame.disposalType === 3 ? ctx.getImageData(0, 0, width, height) : null

    const { width: fw, height: fh, left, top } = frame.dims
    if (!fw || !fh) {
      previous = { disposal: frame.disposalType, left, top, width: fw, height: fh }
      continue
    }
    patchCanvas.width = fw
    patchCanvas.height = fh
    const data = new Uint8ClampedArray(frame.patch)
    patchCtx.putImageData(new ImageData(data, fw, fh), 0, 0)
    ctx.drawImage(patchCanvas, left, top)

    frames.push({
      bitmap: await createImageBitmap(canvas),
      delay: Math.max(20, Math.round(frame.delay || 100)),
    })
    previous = { disposal: frame.disposalType, left, top, width: fw, height: fh }
    onProgress?.(frames.length, raw.length)
    // createImageBitmap yields a microtask, but a paint needs a macrotask.
    if (frames.length % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const duration = frames.reduce((sum, f) => sum + f.delay, 0)
  return { width, height, frames, duration }
}

/** Which frame is visible at `timeMs` (looping). */
export function gifFrameIndex(gif: GifAsset, timeMs: number): number {
  if (gif.frames.length <= 1 || gif.duration <= 0) return 0
  let t = timeMs % gif.duration
  if (t < 0) t += gif.duration
  let acc = 0
  for (let i = 0; i < gif.frames.length; i++) {
    acc += gif.frames[i]!.delay
    if (t < acc) return i
  }
  return gif.frames.length - 1
}

export interface DecodedAsset {
  meta: AssetMeta
  gif: GifAsset | null
  bitmap: ImageBitmap | null
}

/**
 * Turn any supported file into something the renderer understands.
 * Supports PNG, JPEG, WebP and animated GIF.
 */
export async function inspectFile(
  file: File,
  onProgress?: GifProgress,
): Promise<{ mime: string; gif: GifAsset | null; bitmap: ImageBitmap; width: number; height: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = sniffImageMime(bytes)
  const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  if (!supported.includes(mime)) {
    throw new Error('Поддерживаются PNG, JPG, WebP и GIF')
  }
  if (mime === 'image/gif') {
    const gif = await decodeGif(bytes, onProgress)
    return { mime, gif, bitmap: gif.frames[0]!.bitmap, width: gif.width, height: gif.height }
  }
  const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }))
  return { mime, gif: null, bitmap, width: bitmap.width, height: bitmap.height }
}

/** First frame as a small data URL for the layer/project lists. */
export async function makeThumbnail(source: ImageBitmap | GifAsset, width = 320): Promise<string> {
  const bitmap = 'frames' in source ? source.frames[0]!.bitmap : source
  const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.72)
}
