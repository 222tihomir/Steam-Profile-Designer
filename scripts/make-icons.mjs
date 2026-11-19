import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Generates the extension icons without any image dependency: a tiny software
// renderer (4× supersampling) plus a hand-written PNG encoder.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public/icons')
mkdirSync(outDir, { recursive: true })

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBytes, data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))

function roundRect(px, py, x0, y0, x1, y1, radius) {
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
  const cx = Math.max(x0 + r, Math.min(px, x1 - r))
  const cy = Math.max(y0 + r, Math.min(py, y1 - r))
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r + 1e-9 && px >= x0 && px <= x1 && py >= y0 && py <= y1
}

function mix(a, b, t) {
  return a + (b - a) * t
}

function sample(x, y, size) {
  const n = x / size
  const m = y / size
  if (!roundRect(n, m, 0.02, 0.02, 0.98, 0.98, 0.22)) return [0, 0, 0, 0]
  let color = [0x2c, 0x43, 0x57, 1]
  if (roundRect(n, m, 0.045, 0.045, 0.955, 0.955, 0.2)) color = [0x16, 0x21, 0x2c, 1]
  if (roundRect(n, m, 0.15, 0.22, 0.85, 0.7, 0.07)) {
    const t = clamp01((m - 0.22) / 0.48)
    color = [Math.round(mix(0x66, 0x2f, t)), Math.round(mix(0xc0, 0x74, t)), Math.round(mix(0xf4, 0xa8, t)), 1]
  }
  if (roundRect(n, m, 0.3, 0.4, 0.68, 0.66, 0.05)) color = [0x0d, 0x15, 0x1d, 0.94]
  const dx = n - 0.7
  const dy = m - 0.33
  if (dx * dx + dy * dy <= 0.075 ** 2) {
    const t = clamp01((m - 0.26) / 0.14)
    color = [Math.round(mix(0xa4, 0x6e, t)), Math.round(mix(0xd0, 0x92, t)), Math.round(mix(0x07, 0x11, t)), 1]
  }
  return color
}

function render(size, ss = 4) {
  const high = size * ss
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = sample((x + (sx + 0.5) / ss) * ss, (y + (sy + 0.5) / ss) * ss, high)
          r += cr * ca
          g += cg * ca
          b += cb * ca
          a += ca
        }
      }
      const index = (y * size + x) * 4
      if (a > 0) {
        data[index] = Math.round(r / a)
        data[index + 1] = Math.round(g / a)
        data[index + 2] = Math.round(b / a)
        data[index + 3] = Math.round((a / (ss * ss)) * 255)
      }
    }
  }
  return encodePng(size, size, data)
}

for (const size of [16, 32, 48, 128]) {
  const file = resolve(outDir, `icon${size}.png`)
  writeFileSync(file, render(size))
  console.log(`icon${size}.png`)
}
