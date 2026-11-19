// Builds the bundled background catalogue from the MIT-licensed
// https://github.com/sweety1lime/profile-editor daily dump of Steam Points Shop
// items. We keep a searchable sample instead of all 64k entries so the extension
// stays small; the live inventory picker covers "what I actually own".
//
// Usage: npm run catalog

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../src/shared/data/catalog-backgrounds.json')
const BASE = 'https://raw.githubusercontent.com/sweety1lime/profile-editor/main/apps/web/public/catalog/'
const SAMPLE_PER_SHARD = 110
const SHARDS = 13

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

const picked = []
const seen = new Set()

for (let shard = 0; shard < SHARDS; shard++) {
  const items = await getJson(`${BASE}backgrounds-${shard}.json`)
  // Deterministic spread through the shard so the sample is not all one era.
  const step = Math.max(1, Math.floor(items.length / SAMPLE_PER_SHARD))
  for (let i = 0; i < items.length && picked.length < SAMPLE_PER_SHARD * (shard + 1); i += step) {
    const item = items[i]
    if (!item?.n || !item?.i) continue
    const key = `${item.a}/${item.i}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({
      n: String(item.n).slice(0, 80),
      a: item.a,
      i: item.i,
      ...(item.w ? { w: item.w } : {}),
    })
  }
  process.stdout.write(`shard ${shard + 1}/${SHARDS}: ${picked.length} items\n`)
}

picked.sort((a, b) => a.n.localeCompare(b.n, 'en'))
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify({ source: 'profile-editor catalog (MIT)', version: 1, items: picked }))
console.log(`wrote ${picked.length} backgrounds to ${OUT}`)
