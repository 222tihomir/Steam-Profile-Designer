// ---------------------------------------------------------------------------
// Palette building for the GIF encoder.
//
// This is a faithful, typed-array port of gifenc's PNN (pairwise nearest
// neighbour) quantizer. For the same pixels and colour budget it returns the
// same palette gifenc does — the tests compare both — but it removes most of the
// work a size ladder used to repeat:
//
// 1. The rgb565 histogram is built once per frame and can be reused.
// 2. PNN merges the closest pair of bins over and over, and that choice depends
//    on the histogram only, never on the target colour count: the palette for N
//    colours is the state after `bins - N` merges. The export ladder needs
//    256/192/128/96/64, so one run down to the smallest count is snapshotted at
//    every rung instead of running the whole merge train 5-7 times.
//
// On a photographic 1260×840 frame this turns 5 × ~200 ms of palette work into
// one ~100 ms run, and the hourly cost of a retry stops being "quantize again".
// ---------------------------------------------------------------------------

const BIN_COUNT = 65536
/** gifenc compares merge stamps against `bins.length - 1`, not against the
 * number of non-empty bins. Keep the same sentinel so merges behave identically. */
const DELETED = BIN_COUNT - 1

export interface Palette {
  /** Number of colours in `rgb`. */
  size: number
  /** `size` r,g,b triples, 0-255 each. */
  rgb: Uint8Array
  /** gifenc's colour-table form (`[[0,0,0,0], [r,g,b], …]`), built on demand. */
  table?: number[][]
}

export interface Histogram {
  /** Non-empty rgb565 bins. */
  size: number
  /** Mean channel values of each bin (0-255, not rounded). */
  r: Float64Array
  g: Float64Array
  b: Float64Array
  /** Pixel count per bin. */
  count: Float64Array
}

// Scratch histogram, reused between frames. Counts and sums are integers, so
// accumulating them in doubles is exact and matches gifenc bit for bit.
const sumR = new Float64Array(BIN_COUNT)
const sumG = new Float64Array(BIN_COUNT)
const sumB = new Float64Array(BIN_COUNT)
const binCount = new Float64Array(BIN_COUNT)

/**
 * Build the rgb565 histogram gifenc's quantizer works on.
 *
 * gifenc quantizes the raw RGBA buffer and ignores alpha in this format, so
 * fully transparent pixels contribute their (usually black) colour too. Doing
 * the same keeps the palette identical.
 */
export function buildHistogram(rgba: Uint8ClampedArray): Histogram {
  const pixels = new Uint32Array(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length >>> 2)
  let size = 0
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i]!
    // rgb888_to_rgb565(r, g, b) with r/g/b unpacked from ABGR little-endian.
    const key = ((color & 0xf8) << 8) | ((color >> 6) & 0x03e0) | ((color >> 19) & 0x1f)
    if (binCount[key] === 0) size++
    binCount[key] += 1
    sumR[key] += color & 0xff
    sumG[key] += (color >> 8) & 0xff
    sumB[key] += (color >> 16) & 0xff
  }

  const r = new Float64Array(size)
  const g = new Float64Array(size)
  const b = new Float64Array(size)
  const count = new Float64Array(size)
  // gifenc compacts the bins in ascending key order, and the merge result
  // depends on that order, so sweep the whole range again instead of sorting.
  let at = 0
  for (let key = 0; key < BIN_COUNT; key++) {
    const pixelsInBin = binCount[key]!
    if (pixelsInBin === 0) continue
    const d = 1 / pixelsInBin
    r[at] = sumR[key]! * d
    g[at] = sumG[key]! * d
    b[at] = sumB[key]! * d
    count[at] = pixelsInBin
    at++
    binCount[key] = 0
    sumR[key] = 0
    sumG[key] = 0
    sumB[key] = 0
  }

  return { size, r, g, b, count }
}

/**
 * Running rgb565 histogram over several frames.
 *
 * A palette shared by the whole animation has to see every frame before the
 * first one is written, so counts accumulate here and are compacted once at the
 * end. The maths matches `buildHistogram`, so a single-frame accumulator yields
 * the very same histogram the per-frame path produces.
 */
export interface HistogramAccumulator {
  sumR: Float64Array
  sumG: Float64Array
  sumB: Float64Array
  count: Float64Array
}

export function createHistogramAccumulator(): HistogramAccumulator {
  return {
    sumR: new Float64Array(BIN_COUNT),
    sumG: new Float64Array(BIN_COUNT),
    sumB: new Float64Array(BIN_COUNT),
    count: new Float64Array(BIN_COUNT),
  }
}

export function accumulateFrame(acc: HistogramAccumulator, rgba: Uint8ClampedArray): void {
  const pixels = new Uint32Array(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length >>> 2)
  const { sumR, sumG, sumB, count } = acc
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i]!
    const key = ((color & 0xf8) << 8) | ((color >> 6) & 0x03e0) | ((color >> 19) & 0x1f)
    count[key] = count[key]! + 1
    sumR[key] = sumR[key]! + (color & 0xff)
    sumG[key] = sumG[key]! + ((color >> 8) & 0xff)
    sumB[key] = sumB[key]! + ((color >> 16) & 0xff)
  }
}

export function finishHistogram(acc: HistogramAccumulator): Histogram {
  let size = 0
  for (let key = 0; key < BIN_COUNT; key++) if (acc.count[key]! > 0) size++

  const r = new Float64Array(size)
  const g = new Float64Array(size)
  const b = new Float64Array(size)
  const count = new Float64Array(size)
  let at = 0
  for (let key = 0; key < BIN_COUNT; key++) {
    const pixelsInBin = acc.count[key]!
    if (pixelsInBin === 0) continue
    const d = 1 / pixelsInBin
    r[at] = acc.sumR[key]! * d
    g[at] = acc.sumG[key]! * d
    b[at] = acc.sumB[key]! * d
    count[at] = pixelsInBin
    at++
  }

  return { size, r, g, b, count }
}

// PNN workspace, grown on demand and reused across frames.
let wR = new Float64Array(0)
let wG = new Float64Array(0)
let wB = new Float64Array(0)
let wCount = new Float64Array(0)
let wErr = new Float64Array(0)
let wNN = new Int32Array(0)
let wFW = new Int32Array(0)
let wBK = new Int32Array(0)
let wTM = new Int32Array(0)
let wMTM = new Int32Array(0)
let wHeap = new Int32Array(0)

function ensureWorkspace(size: number) {
  if (wR.length >= size) return
  wR = new Float64Array(size)
  wG = new Float64Array(size)
  wB = new Float64Array(size)
  wCount = new Float64Array(size)
  wErr = new Float64Array(size)
  wNN = new Int32Array(size)
  wFW = new Int32Array(size)
  wBK = new Int32Array(size)
  wTM = new Int32Array(size)
  wMTM = new Int32Array(size)
  wHeap = new Int32Array(size + 1)
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Palettes for every requested colour budget, all taken from one merge run.
 *
 * `targets` are the quantizer's `maxColors` values (one less than the frame's
 * colour budget, because index 0 is reserved for transparency).
 */
export function buildPalettes(hist: Histogram, targets: number[]): Map<number, Palette> {
  const wanted = [...new Set(targets.map((target) => Math.max(1, Math.min(255, Math.round(target)))))]
  const out = new Map<number, Palette>()
  // gifenc turns square-root weighting off for very small budgets, and that
  // flag changes the whole merge order. Rungs with different flags cannot share
  // a run; in practice every rung of the export ladder keeps it on.
  const groups = new Map<boolean, number[]>()
  for (const target of wanted) {
    const useSqrt = !((target * target) / hist.size < 0.022)
    const list = groups.get(useSqrt)
    if (list) list.push(target)
    else groups.set(useSqrt, [target])
  }
  for (const [useSqrt, list] of groups) {
    // Most colours first: fewest merges needed before the first snapshot.
    list.sort((a, b) => b - a)
    mergeRun(hist, list, useSqrt, out)
  }
  return out
}

function mergeRun(hist: Histogram, targets: number[], useSqrt: boolean, out: Map<number, Palette>) {
  const size = hist.size
  ensureWorkspace(size)
  wR.set(hist.r, 0)
  wG.set(hist.g, 0)
  wB.set(hist.b, 0)
  wCount.set(hist.count, 0)
  wFW.fill(0, 0, size)
  wBK.fill(0, 0, size)
  wTM.fill(0, 0, size)
  wMTM.fill(0, 0, size)
  for (let i = 0; i < size - 1; i++) {
    wFW[i] = i + 1
    wBK[i + 1] = i
  }
  if (useSqrt) {
    for (let i = 0; i < size; i++) wCount[i] = Math.sqrt(wCount[i]!)
  }

  // Nearest neighbour of a bin: the closest bin later in the linked list.
  // gifenc walks `for (i = fw[idx]; i != 0; i = fw[i])`, so bin 0 is both the
  // list head and the terminator and is never a candidate. Replicate that.
  const findNN = (index: number) => {
    let nn = 0
    let err = 1e100
    const n1 = wCount[index]!
    const wr = wR[index]!
    const wg = wG[index]!
    const wb = wB[index]!
    for (let i = wFW[index]!; i !== 0; i = wFW[i]!) {
      const n2 = wCount[i]!
      const weight = (n1 * n2) / (n1 + n2)
      if (weight >= err) continue
      // `weight * (d * d)` — not `weight * d * d`: the association must match
      // gifenc exactly or a last-bit difference can reorder the merge heap.
      let dr = wR[i]! - wr
      let next = weight * (dr * dr)
      if (next >= err) continue
      let dg = wG[i]! - wg
      next += weight * (dg * dg)
      if (next >= err) continue
      let db = wB[i]! - wb
      next += weight * (db * db)
      if (next >= err) continue
      err = next
      nn = i
    }
    wErr[index] = err
    wNN[index] = nn
  }

  // Seed the merge heap with every bin's current nearest neighbour.
  let heapSize = 0
  for (let i = 0; i < size; i++) {
    findNN(i)
    const err = wErr[i]!
    let slot = ++heapSize
    while (slot > 1) {
      const parent = slot >> 1
      const other = wHeap[parent]!
      if (wErr[other]! <= err) break
      wHeap[slot] = other
      slot = parent
    }
    wHeap[slot] = i
  }

  let merged = 0
  for (const target of targets) {
    const need = Math.max(0, size - target)
    while (merged < need) {
      let bin = 0
      // Pop the pair with the smallest error, refreshing stale entries.
      for (;;) {
        bin = wHeap[1]!
        const stamp = wTM[bin]!
        const own = wMTM[bin]!
        if (stamp >= own && wMTM[wNN[bin]!]! <= stamp) break
        if (own === DELETED) {
          bin = wHeap[heapSize]!
          wHeap[1] = bin
          heapSize--
        } else {
          findNN(bin)
          wTM[bin] = merged
        }
        const err = wErr[bin]!
        let slot = 1
        let child = 0
        while ((child = slot + slot) <= heapSize) {
          if (child < heapSize && wErr[wHeap[child]!]! > wErr[wHeap[child + 1]!]!) child++
          const other = wHeap[child]!
          if (err <= wErr[other]!) break
          wHeap[slot] = other
          slot = child
        }
        wHeap[slot] = bin
      }

      const neighbour = wNN[bin]!
      const n1 = wCount[bin]!
      const n2 = wCount[neighbour]!
      const d = 1 / (n1 + n2)
      wR[bin] = d * (n1 * wR[bin]! + n2 * wR[neighbour]!)
      wG[bin] = d * (n1 * wG[bin]! + n2 * wG[neighbour]!)
      wB[bin] = d * (n1 * wB[bin]! + n2 * wB[neighbour]!)
      wCount[bin] = n1 + n2
      merged++
      wMTM[bin] = merged
      // `tm` is deliberately left alone: gifenc only bumps the merge stamp
      // (`mtm`) and lets the next pop decide whether the neighbour is stale.
      // Unchain the absorbed bin.
      wFW[wBK[neighbour]!] = wFW[neighbour]!
      wBK[wFW[neighbour]!] = wBK[neighbour]!
      wMTM[neighbour] = DELETED
    }
    out.set(target, snapshot(size, target))
  }
}

/** Walk the surviving bins in list order, exactly like gifenc's palette fill. */
function snapshot(size: number, target: number): Palette {
  const capacity = Math.max(1, Math.min(size, target))
  const rgb = new Uint8Array(capacity * 3)
  let count = 0
  let bin = 0
  for (;;) {
    const r = clamp(Math.round(wR[bin]!), 0, 255)
    const g = clamp(Math.round(wG[bin]!), 0, 255)
    const b = clamp(Math.round(wB[bin]!), 0, 255)
    let exists = false
    for (let i = 0; i < count; i++) {
      if (rgb[i * 3] === r && rgb[i * 3 + 1] === g && rgb[i * 3 + 2] === b) {
        exists = true
        break
      }
    }
    if (!exists) {
      rgb[count * 3] = r
      rgb[count * 3 + 1] = g
      rgb[count * 3 + 2] = b
      count++
    }
    bin = wFW[bin]!
    if (bin === 0) break
  }
  return { size: count, rgb: rgb.subarray(0, count * 3) }
}

/**
 * Nearest palette entry for one pixel, in gifenc's exact comparison order.
 * `applyPalette` is skipped entirely by the encoder: only pixels that are
 * actually written need an index, and their key-based cache makes the result
 * identical.
 */
export function nearestRgbIndex(rgb: Uint8Array, size: number, r: number, g: number, b: number): number {
  let index = 0
  let best = 1e100
  for (let i = 0; i < size; i++) {
    const r2 = rgb[i * 3]!
    let distance = (r2 - r) * (r2 - r)
    if (distance > best) continue
    const g2 = rgb[i * 3 + 1]!
    distance += (g2 - g) * (g2 - g)
    if (distance > best) continue
    const b2 = rgb[i * 3 + 2]!
    distance += (b2 - b) * (b2 - b)
    if (distance > best) continue
    best = distance
    index = i
  }
  return index
}

/** gifenc colour table: transparent slot first, then the palette. */
export function paletteTable(palette: Palette): number[][] {
  if (palette.table) return palette.table
  const table: number[][] = [[0, 0, 0, 0]]
  for (let i = 0; i < palette.size; i++) {
    table.push([palette.rgb[i * 3]!, palette.rgb[i * 3 + 1]!, palette.rgb[i * 3 + 2]!])
  }
  palette.table = table
  return table
}
