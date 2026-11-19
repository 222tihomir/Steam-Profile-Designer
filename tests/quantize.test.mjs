// Verifies that the local palette builder returns exactly the palettes gifenc
// would produce, while sharing one merge run between several colour budgets.
//
// If this test ever fails, the encoder's "no quality change" promise is broken:
// the export would use a different palette than the one the user's settings
// describe.
import { describe, expect, it } from 'vitest'
import { quantize } from 'gifenc'
import { buildHistogram, buildPalettes, nearestRgbIndex } from '../src/shared/quantize.ts'

/** Deterministic pseudo-random generator so failures reproduce. */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function makeImage(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4)
  fill(data, width, height)
  return data
}

const CASES = {
  /** Fine grain + gradients: thousands of rgb565 bins, like a video frame. */
  photographic(width, height) {
    const random = rng(12345)
    return makeImage(width, height, (data) => {
      for (let y = 0, p = 0; y < height; y++) {
        for (let x = 0; x < width; x++, p += 4) {
          const v = 0.5 + 0.5 * Math.sin(x / 7.3) * Math.cos(y / 5.1)
          data[p] = v * 220 + random() * 30
          data[p + 1] = (1 - v) * 200 + random() * 30
          data[p + 2] = 120 + 80 * Math.sin((x + y) / 17) + random() * 30
          data[p + 3] = 255
        }
      }
    })
  },
  /** Flat colours and a transparent window: few bins, alpha in play. */
  flatWithCutout(width, height) {
    return makeImage(width, height, (data, w, h) => {
      for (let y = 0, p = 0; y < h; y++) {
        for (let x = 0; x < w; x++, p += 4) {
          const inWindow = x > w / 4 && x < w / 2 && y > h / 4 && y < h / 2
          data[p] = (x * 255) / w
          data[p + 1] = (y * 255) / h
          data[p + 2] = inWindow ? 10 : 200
          data[p + 3] = inWindow ? 0 : 255
        }
      }
    })
  },
  /** One colour: far fewer bins than the requested palette. */
  solid(width, height) {
    return makeImage(width, height, (data) => {
      for (let p = 0; p < data.length; p += 4) {
        data[p] = 24
        data[p + 1] = 96
        data[p + 2] = 200
        data[p + 3] = 255
      }
    })
  },
}

const TARGETS = [1, 15, 39, 63, 95, 127, 191, 255]

function paletteOfGifenc(data, target) {
  return quantize(data, target, { format: 'rgb565' })
}

function expectSamePalette(actual, expected) {
  expect(actual.size).toBe(expected.length)
  const flat = []
  for (let i = 0; i < actual.size; i++) {
    flat.push([actual.rgb[i * 3], actual.rgb[i * 3 + 1], actual.rgb[i * 3 + 2]])
  }
  expect(flat).toEqual(expected.map(([r, g, b]) => [r, g, b]))
}

describe('buildPalettes', () => {
  for (const [name, fill] of Object.entries(CASES)) {
    it(`matches gifenc for ${name} frames`, () => {
      const data = fill(160, 120)
      const palettes = buildPalettes(buildHistogram(data), TARGETS)
      expect(palettes.size).toBe(TARGETS.length)
      for (const target of TARGETS) {
        expectSamePalette(palettes.get(target), paletteOfGifenc(data, target))
      }
    })
  }

  it('matches gifenc when several budgets share one run', () => {
    const data = CASES.photographic(200, 150)
    const hist = buildHistogram(data)
    const shared = buildPalettes(hist, [63, 95, 127, 191, 255])
    for (const target of [63, 95, 127, 191, 255]) {
      expectSamePalette(shared.get(target), paletteOfGifenc(data, target))
    }
  })

  it('reuses the histogram for a second frame', () => {
    const first = CASES.photographic(80, 60)
    const second = CASES.flatWithCutout(80, 60)
    buildPalettes(buildHistogram(first), [255])
    const palettes = buildPalettes(buildHistogram(second), [63, 255])
    expectSamePalette(palettes.get(63), paletteOfGifenc(second, 63))
    expectSamePalette(palettes.get(255), paletteOfGifenc(second, 255))
  })
})

describe('nearestRgbIndex', () => {
  it('matches gifenc applyPalette index for index', () => {
    const data = CASES.photographic(64, 48)
    const palette = buildPalettes(buildHistogram(data), [255]).get(255)
    const expected = quantize(data, 255, { format: 'rgb565' })
    // gifenc's applyPalette caches by rgb565 key, so only the first pixel of a
    // key decides the index. Compare exactly those lookups.
    const seen = new Set()
    for (let p = 0; p < data.length; p += 4) {
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      const key = ((r & 0xf8) << 8) | ((g << 2) & 0x03e0) | (b >> 3)
      if (seen.has(key)) continue
      seen.add(key)
      let best = 0
      let bestDistance = Infinity
      for (let i = 0; i < expected.length; i++) {
        const [r2, g2, b2] = expected[i]
        const distance = (r2 - r) ** 2 + (g2 - g) ** 2 + (b2 - b) ** 2
        // gifenc keeps the last entry that is not worse, so ties go high.
        if (distance > bestDistance) continue
        bestDistance = distance
        best = i
      }
      expect(nearestRgbIndex(palette.rgb, palette.size, r, g, b)).toBe(best)
    }
  })
})
