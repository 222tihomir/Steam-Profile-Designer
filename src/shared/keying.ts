import type { GifAsset, GifFrame } from './gif-decode'
import type { LayerKeying } from './types'

// ---------------------------------------------------------------------------
// Solid-background removal ("вырезать фон").
//
// A GIF with a flat background (white studio backdrop, green screen, a solid
// colour exported from a chat sticker) needs those pixels transparent before it
// lands on the Steam page. Re-encoding such a GIF through another tool loses the
// animation, so the removal happens here, per frame, in place.
//
// Two modes cover the useful cases:
//   • `edges`  — flood fill from the border, so a subject that happens to use the
//                same colour as the backdrop stays intact.
//   • `global` — every pixel of that colour is removed, even inside the subject.
// ---------------------------------------------------------------------------

export const DEFAULT_KEYING: LayerKeying = {
  enabled: false,
  color: '#ffffff',
  tolerance: 48,
  feather: 12,
  mode: 'edges',
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Fill in missing/legacy fields and keep the values in a sane range. */
export function normalizeKeying(input?: Partial<LayerKeying> | null): LayerKeying {
  const merged = { ...DEFAULT_KEYING, ...(input ?? {}) }
  return {
    enabled: merged.enabled === true,
    color: /^#[0-9a-f]{6}$/i.test(merged.color) ? merged.color.toLowerCase() : DEFAULT_KEYING.color,
    tolerance: clamp(Math.round(Number(merged.tolerance) || 0), 0, 180),
    feather: clamp(Math.round(Number(merged.feather) || 0), 0, 64),
    mode: merged.mode === 'global' ? 'global' : 'edges',
  }
}

/** Cache key for one processed variant of an asset. */
export function keyingSignature(input: LayerKeying): string {
  const keying = normalizeKeying(input)
  if (!keying.enabled) return 'off'
  return `${keying.color}|${keying.tolerance}|${keying.feather}|${keying.mode}`
}

export function hexToRgb(color: string): [number, number, number] {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : 'ffffff'
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * Colours of the four corners (3×3 px averaged). The most frequent one wins,
 * which is the usual "the backdrop is the corner colour" case; when all four
 * differ the average is used.
 */
export function cornerColor(bitmap: ImageBitmap): string {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return '#ffffff'
  const maxX = Math.max(0, bitmap.width - 3)
  const maxY = Math.max(0, bitmap.height - 3)
  const spots: [number, number][] = [
    [0, 0],
    [maxX, 0],
    [0, maxY],
    [maxX, maxY],
  ]
  for (const [index, [x, y]] of spots.entries()) {
    ctx.drawImage(bitmap, x, y, 3, 3, index, 0, 1, 1)
  }
  const data = ctx.getImageData(0, 0, 4, 1).data
  const samples: [number, number, number][] = []
  for (let i = 0; i < 4; i++) samples.push([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!])

  // Group near-identical samples (16 levels per channel) and pick the winner.
  const groups = new Map<string, { count: number; sum: [number, number, number] }>()
  for (const [r, g, b] of samples) {
    const key = `${r >> 4}:${g >> 4}:${b >> 4}`
    const group = groups.get(key)
    if (group) {
      group.count += 1
      group.sum[0] += r
      group.sum[1] += g
      group.sum[2] += b
    } else {
      groups.set(key, { count: 1, sum: [r, g, b] })
    }
  }
  let best: { count: number; sum: [number, number, number] } | null = null
  for (const group of groups.values()) {
    if (!best || group.count > best.count) best = group
  }
  if (!best) return '#ffffff'
  const [r, g, b] = best.sum
  return rgbToHex(r / best.count, g / best.count, b / best.count)
}

/**
 * Remove one frame's background.
 *
 * The canvas is reused between frames; `createImageBitmap` snapshots it, so the
 * caller can start the next frame immediately.
 */
function keyBitmap(bitmap: ImageBitmap, keying: LayerKeying, canvas: HTMLCanvasElement): Promise<ImageBitmap> {
  const width = bitmap.width
  const height = bitmap.height
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return Promise.reject(new Error('Canvas 2D недоступен'))
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0)

  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  const [kr, kg, kb] = hexToRgb(keying.color)
  const tolerance2 = keying.tolerance * keying.tolerance
  const pixels = width * height
  const removed = new Uint8Array(pixels)

  const distance2 = (index: number): number => {
    const q = index * 4
    const dr = data[q]! - kr
    const dg = data[q + 1]! - kg
    const db = data[q + 2]! - kb
    return dr * dr + dg * dg + db * db
  }
  const isBackground = (index: number): boolean =>
    data[index * 4 + 3]! < 8 || distance2(index) <= tolerance2

  if (keying.mode === 'edges') {
    // Flood fill from the border so matching colours inside the subject survive.
    const stack: number[] = []
    const seed = (x: number, y: number) => {
      const index = y * width + x
      if (removed[index] || !isBackground(index)) return
      removed[index] = 1
      stack.push(index)
    }
    for (let x = 0; x < width; x++) {
      seed(x, 0)
      seed(x, height - 1)
    }
    for (let y = 0; y < height; y++) {
      seed(0, y)
      seed(width - 1, y)
    }
    while (stack.length) {
      const index = stack.pop()!
      const x = index % width
      if (x > 0) seed(x - 1, Math.floor(index / width))
      if (x < width - 1) seed(x + 1, Math.floor(index / width))
      if (index >= width) seed(x, Math.floor(index / width) - 1)
      if (index < pixels - width) seed(x, Math.floor(index / width) + 1)
    }
  } else {
    for (let index = 0; index < pixels; index++) {
      if (isBackground(index)) removed[index] = 1
    }
  }

  const feather = keying.feather
  if (keying.mode === 'global' && feather > 0) {
    // Colour-distance ramp: a pixel halfway between the key colour and the
    // tolerance band becomes half transparent.
    const tolerance = keying.tolerance
    for (let index = 0; index < pixels; index++) {
      if (removed[index]) {
        data[index * 4 + 3] = 0
        continue
      }
      const d = Math.sqrt(distance2(index))
      if (d < tolerance + feather) {
        const alpha = data[index * 4 + 3]!
        data[index * 4 + 3] = Math.min(alpha, Math.round((255 * (d - tolerance)) / feather))
      }
    }
  } else {
    for (let index = 0; index < pixels; index++) {
      if (removed[index]) data[index * 4 + 3] = 0
    }
    if (feather > 0 && keying.mode === 'edges') {
      // Pixel-distance ramp away from the removed area, so the cut edge fades
      // instead of showing the backdrop colour as a hard line.
      const distance = new Uint16Array(pixels)
      const queue: number[] = []
      const touch = (index: number, value: number) => {
        if (removed[index] || distance[index]) return
        distance[index] = value
        queue.push(index)
      }
      for (let index = 0; index < pixels; index++) {
        if (!removed[index]) continue
        const x = index % width
        if (x > 0) touch(index - 1, 1)
        if (x < width - 1) touch(index + 1, 1)
        if (index >= width) touch(index - width, 1)
        if (index < pixels - width) touch(index + width, 1)
      }
      for (let head = 0; head < queue.length; head++) {
        const index = queue[head]!
        const value = distance[index]!
        if (value >= feather) continue
        const x = index % width
        if (x > 0) touch(index - 1, value + 1)
        if (x < width - 1) touch(index + 1, value + 1)
        if (index >= width) touch(index - width, value + 1)
        if (index < pixels - width) touch(index + width, value + 1)
      }
      for (let index = 0; index < pixels; index++) {
        const value = distance[index]!
        if (!value) continue
        const alpha = data[index * 4 + 3]!
        data[index * 4 + 3] = Math.min(alpha, Math.round((255 * value) / feather))
      }
    }
  }

  ctx.putImageData(image, 0, 0)
  return createImageBitmap(canvas)
}

export interface KeyingProgress {
  (done: number, total: number): void
}

/**
 * Apply the keying to every frame of an animation and return a ready GifAsset.
 * Source bitmaps are left untouched: the result owns its own copies.
 */
export async function keyGif(
  source: GifAsset,
  input: LayerKeying,
  onProgress?: KeyingProgress,
): Promise<GifAsset> {
  const keying = normalizeKeying(input)
  const canvas = document.createElement('canvas')
  const frames: GifFrame[] = []
  try {
    for (const [index, frame] of source.frames.entries()) {
      frames.push({ bitmap: await keyBitmap(frame.bitmap, keying, canvas), delay: frame.delay })
      onProgress?.(index + 1, source.frames.length)
      if (index % 6 === 5) await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } catch (error) {
    frames.forEach((frame) => frame.bitmap.close())
    throw error
  }
  return {
    width: source.width,
    height: source.height,
    frames,
    duration: source.duration,
    ...(source.region ? { region: source.region } : {}),
  }
}

/** Keying for a still image; returns a single-frame GifAsset for one code path. */
export async function keyStill(
  bitmap: ImageBitmap,
  input: LayerKeying,
  onProgress?: KeyingProgress,
): Promise<GifAsset> {
  const keying = normalizeKeying(input)
  const canvas = document.createElement('canvas')
  const keyed = await keyBitmap(bitmap, keying, canvas)
  onProgress?.(1, 1)
  return { width: bitmap.width, height: bitmap.height, frames: [{ bitmap: keyed, delay: 0 }], duration: 0 }
}
