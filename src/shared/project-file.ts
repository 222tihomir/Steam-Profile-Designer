import JSZip from 'jszip'
import type { AssetMeta, Project } from './types'
import type { AssetLibrary } from './assets'
import { normalizeProject } from './storage'

export interface ProjectArchive {
  project: Project
  assets: { meta: AssetMeta; blob: Blob }[]
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
}

const KIND_EXT: Record<string, string> = { gif: 'gif', video: 'mp4', image: 'png' }

/** ZIP entries lose the MIME type; restore it from the file extension. */
const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
)
EXT_MIME.jpg = 'image/jpeg'
EXT_MIME.jpeg = 'image/jpeg'

function assetFileName(meta: AssetMeta, blob: Blob): string {
  const ext = MIME_EXT[blob.type] ?? KIND_EXT[meta.kind] ?? 'png'
  return `assets/${meta.id}.${ext}`
}

/** Project file: a zip with project.json and every image the project uses. */
export async function packProject(project: Project, assets: AssetLibrary): Promise<Blob> {
  const zip = new JSZip()
  const ids = new Set<string>()
  project.layers.forEach((layer) => ids.add(layer.assetId))
  if (project.background?.assetId) ids.add(project.background.assetId)

  const manifestAssets: Record<string, string> = {}
  for (const id of ids) {
    const record = assets.get(id)
    if (!record) continue
    const path = assetFileName(record.meta, record.blob)
    manifestAssets[id] = path
    zip.file(path, record.blob)
  }

  zip.file(
    'project.json',
    JSON.stringify(
      {
        format: 'steam-profile-designer',
        version: 1,
        project,
        assets: Object.fromEntries(
          [...ids]
            .map((id) => assets.get(id))
            .filter((r): r is NonNullable<typeof r> => !!r)
            .map((r) => [r.meta.id, { fileName: manifestAssets[r.meta.id], meta: r.meta }]),
        ),
      },
      null,
      2,
    ),
  )
  zip.file('README.txt', 'Проект Steam Profile Designer. Открывается через «Проекты → Импорт».\n')
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

export async function unpackProject(file: File): Promise<ProjectArchive> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    throw new Error('Это не файл проекта Steam Profile Designer (ожидается .spd.zip)')
  }
  const projectFile = zip.file('project.json')
  if (!projectFile) throw new Error('В архиве нет project.json')
  const parsed = JSON.parse(await projectFile.async('string')) as {
    format?: string
    project?: Project
    assets?: Record<string, { fileName: string; meta: AssetMeta }>
  }
  if (!parsed.project) throw new Error('В project.json нет данных проекта')

  const assets: { meta: AssetMeta; blob: Blob }[] = []
  for (const [id, entry] of Object.entries(parsed.assets ?? {})) {
    const zipFile = zip.file(entry.fileName)
    if (!zipFile) continue
    const ext = /\.([a-z0-9]+)$/i.exec(entry.fileName)?.[1]?.toLowerCase() ?? ''
    const type = EXT_MIME[ext] ?? ''
    const raw = await zipFile.async('blob')
    assets.push({ meta: { ...entry.meta, id }, blob: type ? raw.slice(0, raw.size, type) : raw })
  }
  return { project: normalizeProject(parsed.project), assets }
}
