import type { AssetMeta, Background, BackgroundSource, Layer, LayerKeying } from './types'
import { inspectFile, makeThumbnail } from './gif-decode'
import type { GifAsset, GifFrame, GifProgress } from './gif-decode'
import { fetchBytes, isVideoFile, loadBitmap, probeImage } from './net'
import { inspectVideo } from './video-import'
import { keyGif, keyingSignature, normalizeKeying } from './keying'

export interface AssetRecord {
  meta: AssetMeta
  blob: Blob
  bitmap: ImageBitmap | null
  gif: GifAsset | null
}

let counter = 0
const newId = () => `a${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * In-memory registry of decoded images. Bytes are persisted separately in
 * IndexedDB, decoded frames are rebuilt on load.
 */
export class AssetLibrary {
  private map = new Map<string, AssetRecord>()
  /** Background-removed variants, keyed by `${assetId}|${signature}`. */
  private keyed = new Map<string, GifAsset>()
  private keyingJobs = new Map<string, Promise<GifAsset | null>>()
  private keyedOrder: string[] = []
  /** Rough decoded size of every cached variant, to keep long videos in check. */
  private keyedBytes = 0

  get(id: string): AssetRecord | undefined {
    return this.map.get(id)
  }

  all(): AssetRecord[] {
    return [...this.map.values()]
  }

  async addFile(file: File, role: 'art' | 'background' = 'art', onProgress?: GifProgress): Promise<AssetRecord> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const video = isVideoFile(file, bytes)
    const inspected = video ? await inspectVideo(file, onProgress) : await inspectFile(file, onProgress)
    const id = newId()
    const blob = new Blob([bytes as unknown as BlobPart], { type: inspected.mime })
    const meta: AssetMeta = {
      id,
      name: file.name,
      kind: video ? 'video' : inspected.gif ? 'gif' : 'image',
      width: inspected.width,
      height: inspected.height,
      bytes: blob.size,
      frames: inspected.gif?.frames.length ?? 1,
      duration: inspected.gif?.duration ?? 0,
      role,
      createdAt: Date.now(),
    }
    const record: AssetRecord = {
      meta,
      blob,
      bitmap: 'bitmap' in inspected ? inspected.bitmap : null,
      gif: inspected.gif,
    }
    this.map.set(id, record)
    return record
  }

  async addUrl(url: string, role: 'art' | 'background', name = url.split('/').pop() ?? 'image', onProgress?: GifProgress): Promise<AssetRecord> {
    const { bytes, mime } = await fetchBytes(url)
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
    const file = new File([blob], name, { type: mime })
    const record = await this.addFile(file, role, onProgress)
    return record
  }

  /** Attach an in-memory animation, e.g. frames captured from an SPM video. */
  registerGif(
    id: string,
    name: string,
    role: 'art' | 'background',
    gif: GifAsset,
    blob?: Blob,
  ): AssetRecord {
    const meta: AssetMeta = {
      id,
      name,
      kind: 'gif',
      width: gif.width,
      height: gif.height,
      bytes: blob?.size ?? 0,
      frames: gif.frames.length,
      duration: gif.duration,
      role,
      createdAt: Date.now(),
    }
    const record: AssetRecord = {
      meta,
      blob: blob ?? new Blob([], { type: 'image/gif' }),
      bitmap: null,
      gif,
    }
    this.map.set(id, record)
    return record
  }

  /** Re-create the decoded bitmaps for a stored project asset. */
  async restore(meta: AssetMeta, blob: Blob, onProgress?: GifProgress): Promise<AssetRecord> {
    const existing = this.map.get(meta.id)
    if (existing) return existing
    const video = meta.kind === 'video'
    const file = new File([blob], meta.name, {
      type: blob.type || (video ? 'video/mp4' : 'image/png'),
    })
    const inspected = video ? await inspectVideo(file, onProgress) : await inspectFile(file, onProgress)
    const record: AssetRecord = {
      meta: { ...meta, width: inspected.width, height: inspected.height },
      blob,
      bitmap: 'bitmap' in inspected ? inspected.bitmap : null,
      gif: inspected.gif,
    }
    this.map.set(meta.id, record)
    return record
  }

  /** Cache key for one keyed variant; also used to detect "already processed". */
  private keyingKey(assetId: string, keying: LayerKeying): string {
    return `${assetId}|${keyingSignature(keying)}`
  }

  hasKeying(assetId: string, keying: LayerKeying): boolean {
    return this.keyed.has(this.keyingKey(assetId, keying))
  }

  /**
   * Remove the solid background from every frame of an asset and remember the
   * result. Rendering stays synchronous: the layer simply keeps drawing the raw
   * frames until this resolves, then `assetsVersion` repaints everything.
   */
  async prepareKeying(
    assetId: string,
    input: LayerKeying,
    onProgress?: (done: number, total: number) => void,
  ): Promise<boolean> {
    const keying = normalizeKeying(input)
    if (!keying.enabled) return false
    const key = this.keyingKey(assetId, keying)
    if (this.keyed.has(key)) {
      this.touchKeyed(key)
      return true
    }
    const running = this.keyingJobs.get(key)
    if (running) {
      await running.catch(() => null)
      return this.keyed.has(key)
    }
    const record = this.map.get(assetId)
    if (!record) return false
    const source: GifAsset | null =
      record.gif ??
      (record.bitmap
        ? {
            width: record.bitmap.width,
            height: record.bitmap.height,
            frames: [{ bitmap: record.bitmap, delay: 0 }],
            duration: 0,
          }
        : null)
    if (!source) return false

    const job = keyGif(source, keying, onProgress).then((keyed) => {
      this.keyed.set(key, keyed)
      this.keyedBytes += gifDecodedBytes(keyed)
      this.keyedOrder.push(key)
      this.trimKeyed()
      this.keyingJobs.delete(key)
      return keyed
    })
    // Failures must not leave a rejected promise in the map forever.
    job.catch(() => {
      this.keyingJobs.delete(key)
    })
    this.keyingJobs.set(key, job)
    await job.catch(() => null)
    return this.keyed.has(key)
  }

  private touchKeyed(key: string) {
    const index = this.keyedOrder.indexOf(key)
    if (index >= 0) this.keyedOrder.splice(index, 1)
    this.keyedOrder.push(key)
  }

  /** Keep a few variants (tolerance previews) instead of every slider step. */
  private trimKeyed() {
    // The newest variant is always kept: a single long video can legitimately
    // exceed the budget, and dropping it would mean re-keying on every frame.
    while (
      this.keyedOrder.length > 1 &&
      (this.keyedOrder.length > 6 || this.keyedBytes > KEYED_BUDGET)
    ) {
      const oldest = this.keyedOrder.shift()
      if (!oldest) break
      const asset = this.keyed.get(oldest)
      this.keyed.delete(oldest)
      if (asset) {
        this.keyedBytes -= gifDecodedBytes(asset)
        asset.frames.forEach((frame) => frame.bitmap.close())
      }
    }
  }

  bitmapAt(assetId: string, timeMs: number, keying?: LayerKeying): ImageBitmap | null {
    const record = this.map.get(assetId)
    if (!record) return null
    if (keying?.enabled) {
      const keyed = this.keyed.get(this.keyingKey(assetId, keying))
      if (keyed) {
        const bitmap = frameAt(keyed, timeMs)
        if (bitmap) return bitmap
      }
    }
    if (record.gif) return frameAt(record.gif, timeMs)
    return record.bitmap
  }

  thumbnail(assetId: string): Promise<string> {
    const record = this.map.get(assetId)
    if (!record) return Promise.resolve('')
    return makeThumbnail(record.gif ?? record.bitmap!, 240)
  }

  remove(assetId: string) {
    const record = this.map.get(assetId)
    record?.bitmap?.close()
    record?.gif?.frames.forEach((f) => f.bitmap.close())
    const prefix = `${assetId}|`
    for (const [key, asset] of [...this.keyed]) {
      if (!key.startsWith(prefix)) continue
      this.keyed.delete(key)
      this.keyedBytes -= gifDecodedBytes(asset)
      asset.frames.forEach((frame) => frame.bitmap.close())
    }
    this.keyedOrder = this.keyedOrder.filter((key) => !key.startsWith(prefix))
    this.map.delete(assetId)
  }

  dispose() {
    for (const record of this.map.values()) {
      record.bitmap?.close()
      record.gif?.frames.forEach((f) => f.bitmap.close())
    }
    for (const asset of this.keyed.values()) {
      asset.frames.forEach((frame) => frame.bitmap.close())
    }
    this.keyed.clear()
    this.keyedOrder = []
    this.keyedBytes = 0
    this.map.clear()
  }
}

/** Keep cached background-removed frames under this much decoded memory. */
const KEYED_BUDGET = 192 * 1024 * 1024

function gifDecodedBytes(gif: GifAsset): number {
  let bytes = 0
  for (const frame of gif.frames) bytes += frame.bitmap.width * frame.bitmap.height * 4
  return bytes
}

/** Frame visible at `timeMs` inside one animation (looping). */
function frameAt(gif: GifAsset, timeMs: number): ImageBitmap | null {
  const { frames, duration } = gif
  if (!frames.length) return null
  if (duration <= 0 || frames.length === 1) return frames[0]!.bitmap
  let t = timeMs % duration
  if (t < 0) t += duration
  let acc = 0
  for (const frame of frames) {
    acc += frame.delay
    if (t < acc) return frame.bitmap
  }
  return frames[frames.length - 1]!.bitmap
}

/** Build a background descriptor from an imported image. */
export async function backgroundFromAsset(record: AssetRecord, source: BackgroundSource, url = record.meta.name): Promise<Background> {
  return {
    url,
    assetId: record.meta.id,
    name: record.meta.name,
    source,
    width: record.meta.width,
    height: record.meta.height,
  }
}

/** Resolve any background source to a bitmap, loading remote URLs when needed. */
export async function resolveBackgroundBitmap(
  background: Background,
  library: AssetLibrary,
): Promise<ImageBitmap | null> {
  if (background.assetId) {
    const record = library.get(background.assetId)
    if (record) return record.bitmap ?? record.gif?.frames[0]?.bitmap ?? null
  }
  if (background.url) {
    try {
      return await loadBitmap(background.url)
    } catch {
      return null
    }
  }
  return null
}

/** Measure a remote image with a graceful fallback when the CDN is unreachable. */
export async function measureRemote(url: string): Promise<{ width: number; height: number } | null> {
  try {
    return await probeImage(url)
  } catch {
    return null
  }
}

/** Default placement of a freshly added image: contained in the transparent window. */
export function addLayerForAsset(record: AssetRecord, targetRect: { x: number; y: number; w: number; h: number }, existing: Layer[]): Layer {
  const { width, height } = record.meta
  const fit = Math.min(targetRect.w / width, targetRect.h / height) * 0.92
  const scale = Number.isFinite(fit) && fit > 0 ? fit : 0.5
  const index = existing.length + 1
  return {
    id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    assetId: record.meta.id,
    name: record.meta.name.replace(/\.[^.]+$/, '') || `Слой ${index}`,
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'source-over',
    cx: targetRect.x + targetRect.w / 2,
    cy: targetRect.y + targetRect.h / 2,
    scale,
    rotation: 0,
    flipX: false,
    crop: { x: 0, y: 0, w: 1, h: 1 },
  }
}

export function layerBounds(layer: Layer, record: AssetRecord | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!record) return null
  const w = record.meta.width * layer.crop.w * layer.scale
  const h = record.meta.height * layer.crop.h * layer.scale
  const rad = (layer.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const bw = w * cos + h * sin
  const bh = w * sin + h * cos
  return { x: layer.cx - bw / 2, y: layer.cy - bh / 2, w: bw, h: bh }
}
