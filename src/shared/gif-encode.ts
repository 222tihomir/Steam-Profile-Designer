import { GIFEncoder } from 'gifenc'
import {
  accumulateFrame,
  buildHistogram,
  buildPalettes,
  createHistogramAccumulator,
  finishHistogram,
  nearestRgbIndex,
  paletteTable,
  type Palette,
} from './quantize'

// ---------------------------------------------------------------------------
// GIF encoding with an honest size budget.
//
// Every frame is rendered from the same composition the screen shows. Steam
// rejects illustrations over 5 MB, so with palette reduction enabled the encoder
// retries with a smaller colour budget. Delta frames and their unchanged-pixel
// tolerance are a separate switch: the ladder never turns either on or off. With
// both off the encoder writes one full-palette pass with every frame complete,
// using the caller's dither setting only.
//
// Delta frames share one palette for the whole animation. A delta pixel keeps
// the colour it had a frame ago, so if every frame quantized with its own table,
// kept pixels would carry the previous palette's version of a colour next to
// neighbours drawn with the new one — that seam is the stained outline that used
// to follow moving art. One table makes "kept" and "redrawn" literally the same
// colour, and it costs less: frame 0 writes it as the global colour table and
// later frames skip 768 bytes of local table each.
//
// Performance notes (all of them keep the produced file identical):
//
// * Palettes for every rung of the ladder come from one PNN merge run per frame
//   (see quantize.ts), not one full quantization per rung. A delta export needs
//   a single palette up front, so it merges one histogram of up to 24 sampled
//   frames — the count is what keeps that extra pass cheap on long clips.
// * Only pixels that are actually written ask for a palette index. Delta frames
//   in a mostly still scene skip almost all nearest-colour lookups.
// * Frames stream one at a time. Collecting all of them used to hold hundreds of
//   megabytes for a 2× export, which is what made some exports crawl.
// ---------------------------------------------------------------------------

export interface GifAttempt {
  /** Colour budget, including the reserved transparent index. */
  colors: number
  /** Squared RGB distance under which a pixel counts as unchanged. */
  tolerance: number
  dither: boolean
  delta: boolean
}

/**
 * Squared RGB distance under which a delta frame keeps the previous pixel.
 *
 * Palette entries sit several levels apart even at 256 colours, so the earlier
 * value of 12 (two levels per channel) never fired: delta was effectively
 * "skip only identical pixels" and the tolerance setting did nothing. 120 makes
 * the switch real without a visible cost — measured on a detailed panning
 * background it saves 5 % at 16 frames and 29 % at 120 frames with a mean error
 * of +0.24 out of 255. It stays well below the 26-level ladder that used to
 * leave a stained outline around moving art.
 */
const DELTA_TOLERANCE = 120

/** Frames sampled for the shared delta palette; statistics settle long before. */
const SHARED_PALETTE_SAMPLES = 24

/**
 * Colour budgets the ladder walks down while the file is still too big. The
 * caller's own budget is tried first, then these steps. Palette, tolerance and
 * dithering are set by the caller, so a rung only ever changes the colour count.
 */
const GIF_COLOR_STEPS = [256, 192, 128, 96, 64]

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Ordered 4×4 dithering, anchored to the pixel, so still areas stay stable. */
export function orderedDither(rgba: Uint8ClampedArray, width: number, height: number, spread: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length)
  for (let y = 0, p = 0; y < height; y++) {
    const row = (y & 3) << 2
    for (let x = 0; x < width; x++, p += 4) {
      const shift = ((BAYER[row + (x & 3)]! + 0.5) / 16 - 0.5) * spread
      out[p] = rgba[p]! + shift
      out[p + 1] = rgba[p + 1]! + shift
      out[p + 2] = rgba[p + 2]! + shift
      out[p + 3] = rgba[p + 3]!
    }
  }
  return out
}

export interface EncodeGifOptions {
  width: number
  height: number
  /** Renders frame `index` into the provided canvas. */
  renderFrame: (index: number) => HTMLCanvasElement
  /** Frame delay in ms; its length defines the frame count. */
  delays: number[]
  /** Highest colour budget to try. Lower values make the file smaller. */
  colors: number
  dither: boolean
  /**
   * Write only pixels that changed since the previous frame, leaving the rest
   * transparent. Off writes every frame in full.
   */
  useDelta?: boolean
  /**
   * Retry with a smaller palette when the file exceeds maxBytes. Off keeps the
   * chosen colour budget and reports the oversized file instead.
   */
  reducePalette?: boolean
  maxBytes: number
  signal?: AbortSignal
  /**
   * Encoding progress. `done`/`total` cover the whole encode (frame analysis
   * plus every attempt), so it is safe to turn into a percentage.
   */
  onProgress?: (done: number, total: number, attempt: number, attemptCount: number) => void
}

export interface EncodeGifResult {
  bytes: Uint8Array
  attempts: number
  delta: boolean
  /** True when even the last attempt exceeds maxBytes. */
  tooBig: boolean
}

const TRANSPARENT_THRESHOLD = 128

interface PassResult {
  bytes: Uint8Array
  /** A pixel went from opaque to transparent: a delta frame cannot express that. */
  erasure: boolean
}

interface Workspace {
  pixels: Uint8Array
  cache: Int32Array
}

/** Colour budget → the quantizer's `maxColors` (index 0 stays transparent). */
function targetFor(colors: number): number {
  return Math.max(2, Math.min(256, colors)) - 1
}

/**
 * Encode every frame once at a fixed colour budget.
 *
 * Frames are streamed instead of buffered: only the frame being written and the
 * `shown` composite live in memory. That keeps a 2× 120-frame export from
 * holding ~500 MB of pixels.
 */
async function encodePass(
  options: EncodeGifOptions,
  attempt: GifAttempt,
  paletteAt: (index: number, data: Uint8ClampedArray) => Palette,
  readFrame: (index: number) => Uint8ClampedArray,
  workspace: Workspace,
  sharedPalette: boolean,
  onFrame: (() => void) | null,
): Promise<PassResult> {
  const { width, height, delays, signal } = options
  const gif = GIFEncoder()
  const shown = new Uint8ClampedArray(width * height * 4)
  const pixels = workspace.pixels
  const cache = workspace.cache
  const spread = attempt.dither ? 12 : 0
  // Delta frames must be composited on top of everything shown before them,
  // including the very first frame. Disposal 2 on frame 0 would clear that base
  // frame before the first delta arrives, leaving every delta to play over an
  // empty canvas. Disposal 1 keeps the base image for the whole loop.
  const dispose = attempt.delta ? 1 : 2
  let erasure = false

  for (let i = 0; i < delays.length; i++) {
    if (signal?.aborted) throw new DOMException('Отменено', 'AbortError')
    const source = readFrame(i)
    const data = spread ? orderedDither(source, width, height, spread) : source
    const palette = paletteAt(i, data)
    const rgb = palette.rgb
    const size = palette.size
    const table = paletteTable(palette)
    cache.fill(-1)
    const useDelta = attempt.delta && i > 0

    for (let p = 0, q = 0; p < pixels.length; p++, q += 4) {
      const r = data[q]!
      const g = data[q + 1]!
      const b = data[q + 2]!
      // Seed the cache in raster order, exactly like gifenc's applyPalette, so
      // a pixel that maps to the same rgb565 key always gets the same index
      // even when a delta frame skips it.
      const key = ((r & 0xf8) << 8) | ((g << 2) & 0x03e0) | (b >> 3)
      let index = cache[key]!
      if (index < 0) {
        index = nearestRgbIndex(rgb, size, r, g, b)
        cache[key] = index
      }
      const alpha = data[q + 3]!
      if (alpha < TRANSPARENT_THRESHOLD) {
        pixels[p] = 0
        if (useDelta && shown[q + 3]! >= TRANSPARENT_THRESHOLD) erasure = true
        shown[q + 3] = 0
        continue
      }
      if (useDelta && shown[q + 3]! >= TRANSPARENT_THRESHOLD) {
        // Compare with the colour the decoder is actually showing, not with the
        // source pixel: the previous frame stored a palette entry, and a kept
        // pixel must match it closely or the difference becomes a visible seam.
        const pr = rgb[index * 3]!
        const pg = rgb[index * 3 + 1]!
        const pb = rgb[index * 3 + 2]!
        const dr = shown[q]! - pr
        const dg = shown[q + 1]! - pg
        const db = shown[q + 2]! - pb
        if (dr * dr + dg * dg + db * db <= attempt.tolerance) {
          pixels[p] = 0
          continue
        }
      }
      pixels[p] = index + 1
      shown[q] = rgb[index * 3]!
      shown[q + 1] = rgb[index * 3 + 1]!
      shown[q + 2] = rgb[index * 3 + 2]!
      shown[q + 3] = 255
    }

    gif.writeFrame(pixels, width, height, {
      // Frame 0 writes the global colour table; delta frames reuse it instead of
      // repeating 768 bytes of identical local table on every frame.
      palette: sharedPalette && i > 0 ? undefined : table,
      delay: Math.max(20, Math.round(delays[i] ?? 100)),
      transparent: true,
      transparentIndex: 0,
      repeat: 0,
      dispose,
    })
    onFrame?.()
    // Let the UI breathe between frames.
    if (i % 6 === 5) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  gif.finish()
  return { bytes: gif.bytes(), erasure }
}

/**
 * Encode the animation, retrying with a smaller palette until it fits Steam's
 * 5 MB limit. Returns the bytes plus whether the result still exceeds the limit,
 * so the UI can offer explicit trade-offs instead of silently shipping a file
 * Steam will reject.
 */
export async function encodeGif(options: EncodeGifOptions): Promise<EncodeGifResult> {
  const { width, height, delays, maxBytes, signal } = options
  if (delays.length === 0) throw new Error('Нет кадров для GIF')
  if (!width || !height) throw new Error('Нулевой размер кадра')

  const frameBytes = width * height * 4
  const attempts = buildAttempts(
    options.colors,
    options.dither,
    options.useDelta === true,
    options.reducePalette === true,
  )
  // Rendered frames are only worth keeping when something replays them: a
  // multi-rung palette ladder or a possible delta→full repair. A plain single
  // pass streams (and renders) each frame exactly once.
  const replay = attempts.length > 1 || options.useDelta === true
  // 192 MB covers a full 1× export (120 frames at 630×420) and a 2× export up to
  // ~45 frames, so a ladder does not redraw every frame for every rung. Longer
  // 2× exports stream instead of buffering.
  const cacheable = replay && frameBytes * delays.length <= 192 * 1024 * 1024
  const cache: Uint8ClampedArray[] = []

  const readFrame = (index: number): Uint8ClampedArray => {
    const cached = cache[index]
    if (cached) return cached
    const rendered = options.renderFrame(index)
    const rctx = rendered.getContext('2d', { willReadFrequently: true })
    if (!rctx) throw new Error('Canvas 2D недоступен')
    let data: Uint8ClampedArray
    try {
      data = rctx.getImageData(0, 0, width, height).data
    } catch (error) {
      if (error instanceof DOMException && error.name === 'SecurityError') {
        throw new Error(
          'Браузер запретил читать пиксели кадра: в сцену попало изображение с чужого сайта без CORS. ' +
            'Загрузите фон файлом или используйте фон профиля Steam.',
        )
      }
      throw error
    }
    if (cacheable) cache[index] = data
    return data
  }

  const targets = [...new Set(attempts.map((attempt) => targetFor(attempt.colors)))]
  const palettes: (Map<number, Palette> | undefined)[] = new Array(delays.length)
  const spread = options.dither ? 12 : 0

  // Delta frames share one palette for the whole animation, so it has to be
  // built before frame 0 is written.
  const shared = options.useDelta === true
  // Even stride over the animation: all frames for short clips, 24 for long ones.
  const step = shared ? Math.max(1, Math.ceil(delays.length / SHARED_PALETTE_SAMPLES)) : 1
  const sampled = shared ? Math.ceil(delays.length / step) : 0

  // A single attempt (the common case: both compression switches off) needs no
  // separate analysis pass at all. Building each frame's palette inside the one
  // encode pass gives byte-identical output and halves the work.
  const fused = attempts.length === 1

  // Progress covers frame analysis plus one pass per attempt (or just one pass
  // when the analysis is fused into it).
  const total = shared
    ? sampled + delays.length * attempts.length
    : delays.length * (fused ? 1 : attempts.length + 1)
  let done = 0
  const tick = (attempt: number) => {
    done += 1
    options.onProgress?.(done, total, attempt, attempts.length)
  }

  let sharedPalettes: Map<number, Palette> | null = null
  if (shared) {
    // Colour statistics settle after a handful of frames, so sampling keeps the
    // extra palette pass cheap: a 120-frame export reads 24 of them.
    const acc = createHistogramAccumulator()
    for (let i = 0; i < delays.length; i += step) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError')
      const source = readFrame(i)
      accumulateFrame(acc, spread ? orderedDither(source, width, height, spread) : source)
      tick(0)
      if (i % 6 === 5) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    sharedPalettes = buildPalettes(finishHistogram(acc), targets)
  }

  if (!shared && !fused) {
    // Analysis pass: one histogram per frame, one merge run for every rung.
    for (let i = 0; i < delays.length; i++) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError')
      const source = readFrame(i)
      const data = spread ? orderedDither(source, width, height, spread) : source
      palettes[i] = buildPalettes(buildHistogram(data), targets)
      tick(0)
      if (i % 6 === 5) await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  const paletteLookup = (target: number) => (index: number, data: Uint8ClampedArray): Palette => {
    const common = sharedPalettes?.get(target)
    if (common) return common
    const known = palettes[index]?.get(target)
    if (known) return known
    // Defensive: something asked for a rung the analysis did not cover.
    const built = buildPalettes(buildHistogram(data), [target]).get(target)
    if (!built) throw new Error('Не удалось собрать палитру кадра')
    const map = palettes[index] ?? new Map<number, Palette>()
    map.set(target, built)
    palettes[index] = map
    return built
  }

  const workspace: Workspace = {
    pixels: new Uint8Array(width * height),
    cache: new Int32Array(65536),
  }

  let last: Uint8Array | null = null
  let lastDelta = false

  for (let a = 0; a < attempts.length; a++) {
    const attempt = attempts[a]!
    const paletteAt = paletteLookup(targetFor(attempt.colors))
    let result = await encodePass(options, attempt, paletteAt, readFrame, workspace, shared, () =>
      tick(a + 1),
    )
    let usedDelta = attempt.delta
    if (result.erasure && attempt.delta) {
      // A pixel went from opaque to transparent, which a delta frame cannot
      // express. Rewrite the pass in full; no progress, it is a rare repair.
      result = await encodePass(
        options,
        { ...attempt, delta: false },
        paletteAt,
        readFrame,
        workspace,
        shared,
        null,
      )
      usedDelta = false
    }
    last = result.bytes
    lastDelta = usedDelta
    if (result.bytes.length <= maxBytes) {
      return { bytes: result.bytes, attempts: a + 1, delta: usedDelta, tooBig: false }
    }
  }

  return { bytes: last!, attempts: attempts.length, delta: lastDelta, tooBig: true }
}

function buildAttempts(
  colors: number,
  dither: boolean,
  useDelta: boolean,
  reducePalette: boolean,
): GifAttempt[] {
  // Delta tolerance follows the delta switch alone, never the palette ladder:
  // with a zero tolerance only pixel-exact matches are skipped, so on a moving
  // video background delta used to save almost nothing.
  const tolerance = useDelta ? DELTA_TOLERANCE : 0
  const single: GifAttempt = { colors, tolerance, dither, delta: useDelta }
  if (!reducePalette) return [single]
  // Start at the caller's budget, then walk down the ladder. Duplicate budgets
  // collapse into one rung: every rung shares the same tolerance and dithering
  // now, so encoding the same colour count twice would produce the same bytes.
  const budgets = [colors, ...GIF_COLOR_STEPS.filter((step) => step <= colors)]
  return [...new Set(budgets)].map((budget) => ({ ...single, colors: budget }))
}

/** Width/height of the animation master (the longest GIF among visible layers). */
export function masterDelays(durations: { delays: number[]; duration: number }[]): number[] {
  if (!durations.length) return []
  const master = durations.reduce((a, b) => (b.duration > a.duration ? b : a))
  return master.delays
}
