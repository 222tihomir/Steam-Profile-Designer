import { createStore, get, set, del, keys } from 'idb-keyval'
import type { AssetMeta, Project, ProjectIndexEntry } from './types'

const store = createStore('steam-profile-designer', 'kv')

const INDEX_KEY = 'projects'
const PROJECT_PREFIX = 'project:'
const ASSET_PREFIX = 'asset:'
const ASSET_META_PREFIX = 'asset-meta:'
const SETTINGS_KEY = 'settings'

export interface SavedSettings {
  lastProjectId?: string
  panelCollapsed?: boolean
  acknowledgedIntro?: boolean
}

export async function listProjects(): Promise<ProjectIndexEntry[]> {
  return (await get<ProjectIndexEntry[]>(INDEX_KEY, store)) ?? []
}

async function writeIndex(entries: ProjectIndexEntry[]) {
  await set(INDEX_KEY, entries, store)
}

export async function saveProject(project: Project, thumbnail?: string): Promise<void> {
  const stored: Project = { ...project, updatedAt: Date.now() }
  await set(PROJECT_PREFIX + project.id, stored, store)
  const entries = await listProjects()
  const entry: ProjectIndexEntry = {
    id: project.id,
    name: project.name,
    updatedAt: stored.updatedAt,
    target: project.target,
    thumbnail,
  }
  const index = entries.findIndex((e) => e.id === project.id)
  if (index >= 0) entries[index] = { ...entries[index]!, ...entry }
  else entries.unshift(entry)
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  await writeIndex(entries.slice(0, 100))
}

export async function loadProject(id: string): Promise<Project | null> {
  const project = await get<Project>(PROJECT_PREFIX + id, store)
  if (!project) return null
  // A project written by an older build may miss new fields: fill them defensively.
  return normalizeProject(project)
}

export async function deleteProject(id: string): Promise<void> {
  const project = await get<Project>(PROJECT_PREFIX + id, store)
  await del(PROJECT_PREFIX + id, store)
  const entries = (await listProjects()).filter((e) => e.id !== id)
  await writeIndex(entries)
  if (project) {
    const keep = new Set<string>()
    for (const entry of entries) {
      const other = await get<Project>(PROJECT_PREFIX + entry.id, store)
      other?.layers.forEach((l) => keep.add(l.assetId))
      if (other?.background?.assetId) keep.add(other.background.assetId)
    }
    const referenced = new Set<string>()
    project.layers.forEach((l) => referenced.add(l.assetId))
    if (project.background?.assetId) referenced.add(project.background.assetId)
    for (const assetId of referenced) {
      if (!keep.has(assetId)) await deleteAsset(assetId)
    }
  }
}

export async function saveAsset(meta: AssetMeta, blob: Blob): Promise<void> {
  await set(ASSET_PREFIX + meta.id, blob, store)
  await set(ASSET_META_PREFIX + meta.id, meta, store)
}

export async function loadAsset(id: string): Promise<{ meta: AssetMeta; blob: Blob } | null> {
  const [meta, blob] = await Promise.all([
    get<AssetMeta>(ASSET_META_PREFIX + id, store),
    get<Blob>(ASSET_PREFIX + id, store),
  ])
  if (!meta || !blob) return null
  return { meta, blob }
}

export async function deleteAsset(id: string): Promise<void> {
  await del(ASSET_PREFIX + id, store)
  await del(ASSET_META_PREFIX + id, store)
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

export async function loadSettings(): Promise<SavedSettings> {
  return (await get<SavedSettings>(SETTINGS_KEY, store)) ?? {}
}

export async function saveSettings(settings: SavedSettings): Promise<void> {
  await set(SETTINGS_KEY, settings, store)
}

/** All stored blob keys, handy for the diagnostics panel. */
export async function storageKeys(): Promise<string[]> {
  return (await keys(store)).map(String)
}

export function normalizeProject(input: Project): Project {
  // Older projects had one `reduceQuality` switch that enabled both delta
  // frames and the automatic palette ladder.
  const legacy = input.export as
    | (typeof input.export & { reduceQuality?: boolean; gifQuality?: 'smooth' | 'quality' })
    | undefined
  const legacyReduce = legacy?.reduceQuality
  // The old quality preset capped the GIF at 24 frames; the frame count is now
  // an explicit 1…N value (`0` = every source frame).
  const legacyFrames = legacy?.gifQuality === 'quality' ? 24 : 0
  return {
    ...input,
    version: 1,
    canvasHeight: input.canvasHeight || 1080,
    cutouts: Array.isArray(input.cutouts) ? input.cutouts : [],
    layers: Array.isArray(input.layers) ? input.layers : [],
    previewBackground: input.previewBackground ?? true,
    export: {
      scale: input.export?.scale ?? 2,
      format: input.export?.format ?? 'png',
      gifColors: input.export?.gifColors ?? 256,
      gifDither: input.export?.gifDither ?? false,
      gifFps: input.export?.gifFps ?? 0,
      gifFrames: Math.max(0, Math.round(input.export?.gifFrames ?? legacyFrames)),
      gifDelta: input.export?.gifDelta ?? legacyReduce ?? false,
      gifReducePalette: input.export?.gifReducePalette ?? legacyReduce ?? false,
      gifBackground: normalizeGifBackground(input.export?.gifBackground),
      maxBytes: input.export?.maxBytes ?? 4_950_000,
      savePlate: input.export?.savePlate ?? false,
    },
  }
}

/** Legacy `old`/`full` background modes become explicit long-side values. */
function normalizeGifBackground(value: unknown): 'slot' | number {
  if (value === 'slot') return 'slot'
  if (value === 'full') return 1920
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value)
  }
  return 960
}
