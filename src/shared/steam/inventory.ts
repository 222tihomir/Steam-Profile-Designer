import type { BackgroundOption } from '../types'

// Public Steam inventory, no API key required. Backgrounds are items of class
// `item_class_3` inside app 753 / context 6, and their economy image is the
// actual 1920×1080 artwork.

const ASSETS = 'https://shared.fastly.steamstatic.com/community_assets/images/items/'
const ECONOMY = 'https://community.cloudflare.steamstatic.com/economy/image/'

interface InventoryTag {
  category: string
  internal_name: string
  localized_tag_name?: string
}

interface InventoryDescription {
  classid: string
  instanceid: string
  name: string
  type: string
  icon_url?: string
  tags?: InventoryTag[]
}

interface InventoryResponse {
  success?: number
  Error?: string
  total_inventory_count?: number
  descriptions?: InventoryDescription[]
  assets?: { classid: string; instanceid: string }[]
}

export function economyBackgroundUrl(iconUrl: string, size = '1920x1080'): string {
  return `${ECONOMY}${iconUrl}/${size}`
}

export function catalogBackgroundUrl(itemId: number, file: string): string {
  return `${ASSETS}${itemId}/${file}`
}

function tag(description: InventoryDescription, category: string): InventoryTag | undefined {
  return description.tags?.find((t) => t.category === category)
}

export function isBackgroundDescription(description: InventoryDescription): boolean {
  return (
    /profile background|фон профиля/i.test(description.type) ||
    !!description.tags?.some((t) => t.internal_name === 'item_class_3') ||
    /background/i.test(description.name) && !!description.icon_url
  )
}

/**
 * Load the profile backgrounds of a public inventory. Throws a readable error
 * for private inventories instead of pretending there are none.
 */
export async function loadInventoryBackgrounds(steamId: string): Promise<BackgroundOption[]> {
  const url = `https://steamcommunity.com/inventory/${encodeURIComponent(steamId)}/753/6?l=english&count=2000`
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Steam ответил ${res.status}. Инвентарь может быть закрыт.`)
  const data = (await res.json()) as InventoryResponse
  if (!data.success) {
    throw new Error(
      data.Error === 'There was an error getting the inventory'
        ? 'Инвентарь закрыт или недоступен. Откройте «Инвентарь» в настройках приватности Steam.'
        : data.Error || 'Не удалось получить инвентарь',
    )
  }
  const descriptions = data.descriptions ?? []
  const owned = new Set((data.assets ?? []).map((asset) => `${asset.classid}_${asset.instanceid}`))
  const options: BackgroundOption[] = []
  const seen = new Set<string>()
  for (const description of descriptions) {
    const key = `${description.classid}_${description.instanceid}`
    if (owned.size && !owned.has(key)) continue
    if (!isBackgroundDescription(description)) continue
    if (!description.icon_url) continue
    const name = description.name || 'Фон Steam'
    const game = tag(description, 'Game')?.localized_tag_name
    const id = `inv-${key}`
    if (seen.has(id)) continue
    seen.add(id)
    options.push({
      id,
      name,
      appName: game === 'Steam' ? undefined : game,
      url: economyBackgroundUrl(description.icon_url),
      source: 'inventory',
    })
  }
  return options
}
