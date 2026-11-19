import raw from '../data/catalog-backgrounds.json'

// A searchable slice of the Steam Points Shop background catalogue. Full-size
// files come from the same CDN path Steam uses for profile backgrounds, thumbs
// from the economy endpoint that serves the shop grid.

export interface CatalogItem {
  n: string
  a: number
  i: string
  /** Animated variants ship a separate file; we keep the still frame. */
  w?: string
}

interface CatalogFile {
  source: string
  version: number
  items: CatalogItem[]
}

const catalog = raw as unknown as CatalogFile

const ASSETS = 'https://shared.fastly.steamstatic.com/community_assets/images/items/'
const THUMBS = 'https://community.fastly.steamstatic.com/economy/profilebackground/items/'

export const catalogItems: CatalogItem[] = catalog.items

export const catalogFullUrl = (item: CatalogItem) => `${ASSETS}${item.a}/${item.i}`
export const catalogThumbUrl = (item: CatalogItem) => `${THUMBS}${item.a}/${item.i}?size=320x200`
export const catalogAnimated = (item: CatalogItem) => !!item.w

export interface CatalogResult {
  items: CatalogItem[]
  total: number
}

export function searchCatalog(query: string, limit = 120, offset = 0): CatalogResult {
  const q = query.trim().toLowerCase()
  if (!q) {
    return { items: catalogItems.slice(offset, offset + limit), total: catalogItems.length }
  }
  const terms = q.split(/\s+/).filter(Boolean)
  const matches: CatalogItem[] = []
  for (const item of catalogItems) {
    const name = item.n.toLowerCase()
    if (terms.every((term) => name.includes(term))) matches.push(item)
  }
  return { items: matches.slice(offset, offset + limit), total: matches.length }
}

export function findCatalogItem(name: string): CatalogItem | undefined {
  return catalogItems.find((item) => item.n.toLowerCase() === name.toLowerCase())
}
