import type { GifAsset, GifFrame } from '../gif-decode'
import type { Rect } from '../types'
import { fetchBytes } from '../net'
import { PLATE_WIDTH } from '../render'

// ---------------------------------------------------------------------------
// SPM draws animated profile backgrounds with a <video>. Its poster is only the
// first frame, which is why a video background used to end up as a still PNG.
// These helpers sample the real video element into GIF frames so the preview and
// the exported file animate exactly like the page.
//
// A cross-origin video without CORS headers taints every canvas it is drawn on.
// Chrome still lets createImageBitmap() copy such a canvas, so the taint used to
// slip through and only explode later inside the GIF encoder's getImageData().
// Every source is therefore probed before capture. A tainted page video is
// retried through a CORS-enabled clone, and finally through the extension relay
// (which has host permissions), before falling back to the poster.
//
// A fixed sampling rate (the old 8 fps) threw away most of the original frames
// and made the GIF look like a slideshow. The main path now plays one loop and
// records every frame the browser actually presents, so the export keeps the
// video's own cadence. Seeking is only the fallback for long clips or browsers
// without requestVideoFrameCallback.
// ---------------------------------------------------------------------------

/** Enough for ~4 s at 30 fps; keeps captured bitmaps within a sane memory budget. */
const MAX_FRAMES = 120
/** Legacy cap: the whole frame is squeezed into this long side. */
const MAX_SIDE = 960
/** Native-capture cap: the 1920 px profile plate needs no more than this. */
export const FULL_MAX_SIDE = 1920
/** Frame delays below this are pointless for GIF and only inflate the file. */
const MIN_DELAY = 10
/** Below this the sampling rate is assumed to be 30 fps for the seek fallback. */
const FALLBACK_FPS = 30
/** Cloned/relayed videos need time to load; profile loops are usually small. */
const LOAD_TIMEOUT = 8000

function waitForEvent(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer = 0
    const done = () => {
      target.removeEventListener(event, done)
      if (timer) window.clearTimeout(timer)
      resolve()
    }
    timer = window.setTimeout(() => {
      target.removeEventListener(event, done)
      reject(new Error(`Видео не ответило событием ${event}`))
    }, timeoutMs)
    target.addEventListener(event, done, { once: true })
  })
}

async function ensureVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return
  if (video.error) throw new Error('Видео не загрузилось')
  await new Promise<void>((resolve, reject) => {
    let timer = 0
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', check)
      video.removeEventListener('loadeddata', check)
      video.removeEventListener('error', onError)
      if (timer) window.clearTimeout(timer)
    }
    const finish = (error?: Error) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (video.readyState >= 2) finish()
    }
    const onError = () => finish(new Error('Видео не загрузилось'))
    timer = window.setTimeout(() => finish(new Error('Видео не ответило вовремя')), LOAD_TIMEOUT)
    video.addEventListener('loadedmetadata', check)
    video.addEventListener('loadeddata', check)
    video.addEventListener('error', onError)
    check()
  })
}

/** Last moment that can be seeked to; some videos expose a shorter seekable range. */
function seekableEnd(video: HTMLVideoElement, duration: number): number {
  try {
    const ranges = video.seekable
    if (ranges && ranges.length) return Math.min(duration, ranges.end(ranges.length - 1))
  } catch {
    // seekable can throw for live streams
  }
  return duration
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.01) return
  const seeked = waitForEvent(video, 'seeked', 2000)
  video.currentTime = time
  await seeked
}

/** Can this canvas be read back? A cross-origin video makes getImageData throw. */
function canvasReadable(ctx: CanvasRenderingContext2D): boolean {
  try {
    ctx.getImageData(0, 0, 1, 1)
    return true
  } catch {
    return false
  }
}

/** Draw the current video frame into a tiny canvas and test whether it is clean. */
function videoReadable(video: HTMLVideoElement): boolean {
  try {
    const probe = document.createElement('canvas')
    probe.width = 8
    probe.height = 8
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, 8, 8)
    return canvasReadable(ctx)
  } catch {
    return false
  }
}

interface LoadedVideo {
  element: HTMLVideoElement
  /** Blob URL created by the relay fallback and revoked after capture. */
  blobUrl?: string
}

/** Detached video used for the CORS retry; the page element is never touched. */
async function loadVideoElement(src: string, cors: boolean): Promise<LoadedVideo | null> {
  const element = document.createElement('video')
  if (cors) element.crossOrigin = 'anonymous'
  element.muted = true
  element.loop = false
  element.playsInline = true
  element.preload = 'auto'
  element.src = src
  element.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;width:64px;height:64px;opacity:0;pointer-events:none'
  document.body.appendChild(element)
  try {
    await ensureVideoReady(element)
    return { element }
  } catch {
    disposeVideo({ element })
    return null
  }
}

/** Fetch the clip through the extension relay and play it from a blob URL. */
async function loadRelayedVideo(src: string): Promise<LoadedVideo | null> {
  try {
    const { bytes, mime } = await fetchBytes(src)
    const blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
    const loaded = await loadVideoElement(blobUrl, false)
    if (!loaded) {
      URL.revokeObjectURL(blobUrl)
      return null
    }
    loaded.blobUrl = blobUrl
    return loaded
  } catch {
    return null
  }
}

function disposeVideo(loaded: LoadedVideo) {
  const { element, blobUrl } = loaded
  try {
    element.pause()
  } catch {
    // Detached elements can already be closed.
  }
  element.removeAttribute('src')
  try {
    element.load()
  } catch {
    // Ignore teardown failures.
  }
  element.remove()
  if (blobUrl) URL.revokeObjectURL(blobUrl)
}

/**
 * Source rectangle of a video frame in video pixels, or null for the whole
 * frame. Present when frames are cropped to the showcase (1:1 sampling).
 */
interface SourceCrop {
  x: number
  y: number
  w: number
  h: number
}

/** Draw one video frame, honouring the optional source crop. */
function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  source: SourceCrop | null,
  width: number,
  height: number,
): void {
  if (source) ctx.drawImage(video, source.x, source.y, source.w, source.h, 0, 0, width, height)
  else ctx.drawImage(video, 0, 0, width, height)
}

/**
 * Map a profile-px rect onto the video frame. The plate is drawn 1920 px wide,
 * so one profile px is `videoWidth / 1920` source px in both directions. The
 * result is snapped to whole source pixels, so a showcase crop is sampled 1:1
 * instead of being squeezed through a 960 px intermediate.
 */
function profileRectToSource(
  video: HTMLVideoElement,
  rect: Rect,
): { source: SourceCrop; width: number; height: number; region: Rect } | null {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return null
  const perProfilePx = sourceWidth / PLATE_WIDTH
  const frameHeight = (PLATE_WIDTH * sourceHeight) / sourceWidth
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
  const left = Math.round(clamp(rect.x, 0, PLATE_WIDTH) * perProfilePx)
  const top = Math.round(clamp(rect.y, 0, frameHeight) * perProfilePx)
  const right = Math.round(clamp(rect.x + rect.w, 0, PLATE_WIDTH) * perProfilePx)
  const bottom = Math.round(clamp(rect.y + rect.h, 0, frameHeight) * perProfilePx)
  const width = right - left
  const height = bottom - top
  if (width < 2 || height < 2) return null
  return {
    source: { x: left, y: top, w: width, h: height },
    width,
    height,
    region: {
      x: left / perProfilePx,
      y: top / perProfilePx,
      w: width / perProfilePx,
      h: height / perProfilePx,
    },
  }
}

/**
 * Play one loop and collect every frame the browser presents.
 *
 * `requestVideoFrameCallback` exposes the media timestamp of each frame, so the
 * delays come from the video itself rather than from a guessed sampling rate.
 * Returns null when the clip has more frames than the capture budget or when
 * the browser never delivered frames (hidden tab, unsupported codec); the
 * caller then falls back to seeking.
 */
async function captureNativeFrames(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  duration: number,
  maxFrames: number,
  source: SourceCrop | null = null,
  region?: Rect,
  onProgress?: (done: number, total: number) => void,
): Promise<GifAsset | null> {
  if (typeof video.requestVideoFrameCallback !== 'function') return null
  const estimated = Math.max(2, Math.min(maxFrames, Math.round(duration * FALLBACK_FPS)))

  const wasPaused = video.paused
  const previousTime = video.currentTime
  const previousLoop = video.loop
  const times: number[] = [0]
  let firstBitmap: ImageBitmap | null = null
  const pending: { time: number; bitmap: Promise<ImageBitmap> }[] = []
  let incomplete = false

  try {
    video.pause()
    try {
      video.currentTime = 0
    } catch {
      // Some streams reject seeking; the current frame still works.
    }
    await seekTo(video, 0).catch(() => undefined)
    drawVideoFrame(ctx, video, source, width, height)
    // Chrome copies a tainted canvas into an ImageBitmap without complaining;
    // the taint only surfaces in getImageData() later, so check it here.
    if (!canvasReadable(ctx)) return null
    firstBitmap = await createImageBitmap(canvas)

    // One loop only: `ended` then marks the end of the cycle, and `loop = false`
    // prevents a second pass from adding duplicate frames.
    video.loop = false
    await video.play()

    await new Promise<void>((resolve) => {
      let done = false
      let timer = 0
      const finish = () => {
        if (done) return
        done = true
        if (timer) window.clearTimeout(timer)
        video.removeEventListener('ended', onEnded)
        resolve()
      }
      const onEnded = () => finish()
      const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (done) return
        const mediaTime = metadata.mediaTime
        const last = times[times.length - 1]!
        if (mediaTime + 0.001 < last) {
          // Wrapped around despite loop=false — that is a complete cycle too.
          finish()
          return
        }
        if (mediaTime - last > 0.0005) {
          if (times.length >= maxFrames) {
            incomplete = true
            finish()
            return
          }
          try {
            drawVideoFrame(ctx, video, source, width, height)
          } catch {
            // A detached element can fail here; the caller keeps the poster.
            incomplete = true
            finish()
            return
          }
          // createImageBitmap snapshots the canvas when it is called, so the
          // next frame cannot overwrite this one before the copy is made.
          pending.push({ time: mediaTime, bitmap: createImageBitmap(canvas) })
          times.push(mediaTime)
          onProgress?.(times.length, estimated)
        }
        video.requestVideoFrameCallback(onFrame)
      }
      video.addEventListener('ended', onEnded, { once: true })
      video.requestVideoFrameCallback(onFrame)
      timer = window.setTimeout(finish, Math.min(30_000, Math.round(duration * 1000) + 2500))
    })
  } finally {
    video.loop = previousLoop
    try {
      video.pause()
      video.currentTime = previousTime
    } catch {
      // Ignore restore failures on detached or live videos.
    }
    if (!wasPaused) void video.play().catch(() => undefined)
  }

  if (!firstBitmap || times.length < 2) return null
  // rVFC can fire only at the end for an offscreen or throttled video, which
  // looks like a valid 2-frame loop. Short clips cannot really have 2 frames,
  // so let the seek fallback read every frame instead.
  if (times.length < 3 && duration > 1) {
    firstBitmap.close()
    const discard = await Promise.all(pending.map((item) => item.bitmap.catch(() => null)))
    for (const bitmap of discard) bitmap?.close()
    return null
  }
  // A late `ended` or a hidden tab may leave the capture short of one full
  // cycle; resampling the video is better than exporting an out-of-sync loop.
  if (incomplete || times[times.length - 1]! < duration - 0.15) {
    firstBitmap.close()
    const discard = await Promise.all(pending.map((item) => item.bitmap.catch(() => null)))
    for (const bitmap of discard) bitmap?.close()
    return null
  }

  const bitmaps = await Promise.all(pending.map((item) => item.bitmap))
  const entries = [
    { time: 0, bitmap: firstBitmap },
    ...pending.map((item, index) => ({ time: item.time, bitmap: bitmaps[index]! })),
  ].sort((a, b) => a.time - b.time)

  const total = Math.max(1, Math.round(duration * 1000))
  const frames: GifFrame[] = entries.map((entry, index) => {
    const at = Math.round(entry.time * 1000)
    const next = index === entries.length - 1 ? total : Math.round(entries[index + 1]!.time * 1000)
    // The last presented frame can start 1 ms before the loop point; keep that
    // tiny delay so the captured cycle equals the real video length. The export
    // timeline is what turns it into a valid centisecond GIF delay.
    return { bitmap: entry.bitmap, delay: Math.max(1, next - at) }
  })

  const sum = frames.reduce((value, frame) => value + frame.delay, 0)
  // The estimate can overcount (plays at a different rate than the fallback
  // FPS). Close the bar on the real frame count so the banner ends at 100 %.
  onProgress?.(frames.length, frames.length)
  return { width, height, frames, duration: sum, ...(region ? { region } : {}) }
}

/** Same picture? Used to drop duplicate seek samples without keeping frames. */
function samePixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  const left = new Uint32Array(a.buffer, a.byteOffset, a.length / 4)
  const right = new Uint32Array(b.buffer, b.byteOffset, b.length / 4)
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

/**
 * Fallback used for long clips and browsers without frame callbacks: seek over
 * the whole clip at 30 fps (or lower when the frame budget is small) and spread
 * the real video length over the frames so the loop still matches the video.
 *
 * Seeking reads whatever frame covers the sampled time, so a 9 fps clip sampled
 * at 30 fps returns the same picture three times. Those repeats are merged into
 * the previous frame's delay instead of being encoded: they add bytes without
 * adding motion, and on a real 30 fps clip nothing is lost because neighbouring
 * samples are different.
 */
async function captureSeekFrames(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  duration: number,
  maxFrames: number,
  source: SourceCrop | null = null,
  region?: Rect,
  onProgress?: (done: number, total: number) => void,
): Promise<GifAsset | null> {
  const wasPaused = video.paused
  if (duration > 0) video.pause()

  try {
    const frames: GifFrame[] = []
    const count =
      duration > 0 ? Math.max(2, Math.min(maxFrames, Math.round(duration * FALLBACK_FPS))) : 1
    const end = duration > 0 ? seekableEnd(video, duration) : 0
    const target = duration > 0 ? Math.max(MIN_DELAY * count, Math.round(duration * 1000)) : 0
    const delays: number[] = []
    let lastData: Uint8ClampedArray | null = null
    let at = 0
    for (let index = 0; index < count; index++) {
      const targetAt = index === count - 1 ? target : Math.round((target * (index + 1)) / count)
      const delay = Math.max(MIN_DELAY, targetAt - at)
      delays.push(delay)
      at += delay
    }

    for (let index = 0; index < count; index++) {
      if (duration > 0) {
        const time = end > 0 ? (end * index) / count : 0
        await seekTo(video, Math.min(Math.max(0, time), Math.max(0, end - 0.001)))
      }
      drawVideoFrame(ctx, video, source, width, height)
      // getImageData is both the duplicate check and the taint check: a
      // cross-origin frame throws SecurityError here.
      if (!canvasReadable(ctx)) return null
      const delay = delays[index] ?? 100
      const data = ctx.getImageData(0, 0, width, height).data
      // Seek sampling can hit the same decoded frame several times. Keep one
      // copy and let its delay cover the whole time that picture was on screen.
      if (frames.length && lastData && samePixels(lastData, data)) {
        frames[frames.length - 1]!.delay += delay
        continue
      }
      frames.push({ bitmap: await createImageBitmap(canvas), delay })
      lastData = data
      onProgress?.(index + 1, count)
    }

    const total = frames.reduce((sum, frame) => sum + frame.delay, 0)
    onProgress?.(frames.length, frames.length)
    return { width, height, frames, duration: total, ...(region ? { region } : {}) }
  } finally {
    if (duration > 0 && !wasPaused) {
      void video.play().catch(() => undefined)
    }
  }
}

/** Capture from one ready, readable video element. */
async function captureElement(
  video: HTMLVideoElement,
  maxFrames: number,
  maxSide: number,
  native = true,
  crop?: Rect | null,
  onProgress?: (done: number, total: number) => void,
): Promise<GifAsset | null> {
  try {
    await ensureVideoReady(video)
    const sourceWidth = video.videoWidth
    const sourceHeight = video.videoHeight
    if (!sourceWidth || !sourceHeight) return null
    // The page element can be tainted even though it is ready; never hand
    // unreadable frames to the encoder.
    if (!videoReadable(video)) return null

    // Cropped capture keeps the showcase at native resolution; the uncropped
    // path keeps the whole frame, optionally capped to a smaller long side.
    const cropped = crop ? profileRectToSource(video, crop) : null
    const ratio = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight))
    const width = cropped?.width ?? Math.max(2, Math.round(sourceWidth * ratio))
    const height = cropped?.height ?? Math.max(2, Math.round(sourceHeight * ratio))
    const source = cropped?.source ?? null
    const region = cropped?.region

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
    if (duration <= 0) {
      // Live streams have no loop to capture; keep a single frame instead of
      // pretending the background animates.
      return captureSeekFrames(video, canvas, ctx, width, height, duration, maxFrames, source, region, onProgress)
    }

    // Native playback capture only makes sense while the clip fits the frame
    // budget at a normal rate. Longer clips go straight to seeking, so the
    // whole loop is covered instead of the first few seconds. Detached clones
    // are never painted, so they always use seeking.
    if (native && duration <= maxFrames / FALLBACK_FPS) {
      try {
        const captured = await captureNativeFrames(
          video,
          canvas,
          ctx,
          width,
          height,
          duration,
          maxFrames,
          source,
          region,
          onProgress,
        )
        if (captured) return captured
      } catch {
        // Blocked play() or a detached element: seeking still produces frames.
      }
    }
    return captureSeekFrames(video, canvas, ctx, width, height, duration, maxFrames, source, region, onProgress)
  } catch {
    return null
  }
}

/**
 * Sample a video into full frames of a GifAsset.
 *
 * Cross-origin clips are retried in a CORS-enabled clone, then through the
 * extension relay, and only then give up. Returns null when no path can read
 * the pixels (no CORS, no host permission, unsupported codec); the caller keeps
 * the poster and still exports a GIF, just with a single frame.
 */
export async function captureVideoFrames(
  video: HTMLVideoElement,
  options: {
    maxFrames?: number
    maxSide?: number
    crop?: Rect | null
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<GifAsset | null> {
  if (!video) return null
  const maxFrames = Math.max(2, options.maxFrames ?? MAX_FRAMES)
  const maxSide = Math.max(64, options.maxSide ?? MAX_SIDE)
  const crop = options.crop ?? null
  const onProgress = options.onProgress

  try {
    await ensureVideoReady(video)
  } catch {
    return null
  }

  const src = video.currentSrc || video.src || ''
  if (videoReadable(video)) return captureElement(video, maxFrames, maxSide, true, crop, onProgress)
  // A blob or data URL is already same-origin, so nothing else can be tried.
  if (!/^https?:/i.test(src)) return null

  // 1) Ask for the same URL with CORS. Many hosts send ACAO even when the page
  //    element did not request it; the clone is detached from SPM's element.
  let loaded = await loadVideoElement(src, true)
  if (loaded && !videoReadable(loaded.element)) {
    disposeVideo(loaded)
    loaded = null
  }
  // 2) Fetch through the extension service worker. This works on Steam hosts
  //    whose CDN does not send ACAO; other hosts need a host permission.
  if (!loaded) loaded = await loadRelayedVideo(src)
  if (!loaded) return null

  try {
    return await captureElement(loaded.element, maxFrames, maxSide, false, crop, onProgress)
  } finally {
    disposeVideo(loaded)
  }
}

/**
 * Capture a clip from its URL alone.
 *
 * The studio tab has no profile page and therefore no <video> element, but the
 * project remembers the SPM clip URL. Loading it here keeps studio exports
 * animated instead of silently falling back to the poster. Detached elements
 * are never painted, so the seek sampler is always used.
 */
export async function captureVideoUrl(
  src: string,
  options: {
    maxFrames?: number
    maxSide?: number
    crop?: Rect | null
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<GifAsset | null> {
  if (!/^(https?|blob|data):/i.test(src)) return null
  const maxFrames = Math.max(2, options.maxFrames ?? MAX_FRAMES)
  const maxSide = Math.max(64, options.maxSide ?? MAX_SIDE)
  const crop = options.crop ?? null
  const onProgress = options.onProgress

  let loaded = await loadVideoElement(src, true)
  if (loaded && !videoReadable(loaded.element)) {
    disposeVideo(loaded)
    loaded = null
  }
  if (!loaded) loaded = await loadRelayedVideo(src)
  if (!loaded) return null

  try {
    return await captureElement(loaded.element, maxFrames, maxSide, false, crop, onProgress)
  } finally {
    disposeVideo(loaded)
  }
}
