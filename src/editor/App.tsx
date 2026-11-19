import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_EXPORT,
  type Background,
  type BackgroundOption,
  type Cutout,
  type Layer,
  type LayerKeying,
  type Project,
  type ProjectIndexEntry,
  type ShowcaseKind,
} from '../shared/types'
import { SHOWCASES, clampCanvasHeight, clampShowcaseHeight, projectSlotRect, slotRectFor } from '../shared/geometry'
import { AssetLibrary, addLayerForAsset } from '../shared/assets'
import { CompositionRenderer, hasAnimatedLayers, hasVideoBackground } from '../shared/render'
import { decodeGif, type GifAsset } from '../shared/gif-decode'
import { encodeGif } from '../shared/gif-encode'
import { exportProject, downloadBlob, safeFileName, type ExportedFile, type ExportProgress } from '../shared/export'
import { packProject, unpackProject } from '../shared/project-file'
import { captureVideoFrames, captureVideoUrl, FULL_MAX_SIDE } from '../shared/steam/video-frames'
import { keyingSignature, normalizeKeying } from '../shared/keying'
import {
  deleteProject as deleteProjectRecord,
  estimateStorage,
  listProjects,
  loadAsset,
  loadProject,
  loadSettings,
  saveAsset,
  saveProject,
  saveSettings,
  type SavedSettings,
} from '../shared/storage'
import { readPageState, observePage, BackgroundOverride, UPLOAD_PAGE, type PageState } from '../shared/steam/page'
import { loadInventoryBackgrounds } from '../shared/steam/inventory'
import type { EditorApi, InventoryState, PanelTab, SelfTestResult } from './api'
import { BackgroundPanel, ArtPanel, ExportPanel, PreviewPanel, SimplePanel, WindowPanel } from './panels'
import { Stage } from './Stage'
import { PagePreview } from './PagePreview'
import { HelpModal, ProjectsModal } from './modals'
import { Icon, Logo, Toasts, useToasts } from './bits'

export interface AppProps {
  surface: 'overlay' | 'studio'
  /** Content script hides the panel and leaves the launcher. */
  onHideUi?: () => void
}

let seq = 0
const uid = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

function createProject(name = 'Мой профиль'): Project {
  const now = Date.now()
  return {
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    background: null,
    canvasHeight: 1080,
    cutouts: [],
    layers: [],
    target: 'featured',
    showcaseHeight: 420,
    previewBackground: true,
    export: { ...DEFAULT_EXPORT },
    version: 1,
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    // Errors coming from another world (Steam scripts, extension frames) can
    // miss the Error prototype but still carry a message.
    const value = error as { message?: unknown; name?: unknown }
    if (typeof value.message === 'string' && value.message) return value.message
    if (typeof value.name === 'string' && value.name && value.name !== 'Error') return value.name
  }
  return 'Неизвестная ошибка'
}

/** Stable id for an in-memory asset captured from a URL. */
function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = (hash * 33) ^ value.charCodeAt(index)
  return (hash >>> 0).toString(36)
}

function sameRect(a: PageState['rootRect'], b: PageState['rootRect']): boolean {
  if (!a || !b) return a === b
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

function sameFrame(a: PageState['backgroundFrame'], b: PageState['backgroundFrame']): boolean {
  if (!a || !b) return a === b
  return a.scaleX === b.scaleX && a.scaleY === b.scaleY && a.left === b.left && a.top === b.top
}

function sameTile(a: PageState['backgroundTile'], b: PageState['backgroundTile']): boolean {
  if (!a || !b) return a === b
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.offsetX === b.offsetX &&
    a.offsetY === b.offsetY &&
    a.repeatX === b.repeatX &&
    a.repeatY === b.repeatY
  )
}

function samePage(a: PageState | null, b: PageState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (
    a.isProfile !== b.isProfile ||
    a.scale !== b.scale ||
    !sameFrame(a.backgroundFrame, b.backgroundFrame) ||
    !sameTile(a.backgroundTile, b.backgroundTile) ||
    a.backgroundUrl !== b.backgroundUrl ||
    a.backgroundElement !== b.backgroundElement ||
    a.steamId !== b.steamId ||
    a.persona !== b.persona ||
    a.spmDetected !== b.spmDetected ||
    a.backgroundIsVideo !== b.backgroundIsVideo ||
    a.backgroundVideo !== b.backgroundVideo ||
    (a.backgroundVideo?.currentSrc ?? '') !== (b.backgroundVideo?.currentSrc ?? '') ||
    !sameRect(a.rootRect, b.rootRect) ||
    !sameRect(a.leftColumn, b.leftColumn) ||
    a.anchors.length !== b.anchors.length
  ) {
    return false
  }
  return a.anchors.every((anchor, index) => {
    const other = b.anchors[index]!
    return anchor.kind === other.kind && anchor.title === other.title && sameRect(anchor.rect, other.rect)
  })
}

/** Page information passed by the content script when it opens the studio tab. */
function readStudioPage(): PageState {
  let params: URLSearchParams | null = null
  try {
    params = new URLSearchParams(location.search)
  } catch {
    params = null
  }
  return {
    isProfile: false,
    rootRect: null,
    scale: 1,
    backgroundFrame: null,
    backgroundTile: null,
    backgroundUrl: params?.get('bg') || null,
    backgroundElement: null,
    anchors: [],
    leftColumn: null,
    persona: params?.get('persona') || null,
    steamId: params?.get('steamid') || null,
    spmDetected: params?.get('spm') === '1',
    backgroundSize: '',
    backgroundIsVideo: false,
    backgroundVideo: null,
  }
}

function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas не смог закодировать изображение'))), type)
  })
}

function globalChrome(): typeof chrome | null {
  try {
    return typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome : null
  } catch {
    return null
  }
}

const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: 'background', label: 'Фон', icon: 'image' },
  { id: 'window', label: 'Окно', icon: 'scissors' },
  { id: 'art', label: 'Картинка', icon: 'layers' },
  { id: 'preview', label: 'Профиль', icon: 'eye' },
  { id: 'export', label: 'Экспорт', icon: 'download' },
]

export default function App({ surface, onHideUi }: AppProps) {
  const assetsRef = useRef<AssetLibrary | null>(null)
  if (!assetsRef.current) assetsRef.current = new AssetLibrary()
  const assets = assetsRef.current

  const [project, setProject] = useState<Project>(() => createProject())
  const rendererRef = useRef<CompositionRenderer | null>(null)
  if (!rendererRef.current) rendererRef.current = new CompositionRenderer(project, assets)
  const renderer = rendererRef.current
  renderer.update(project, assets)

  const [assetsVersion, setAssetsVersion] = useState(0)
  const [ready, setReady] = useState(false)
  const [projects, setProjects] = useState<ProjectIndexEntry[]>([])
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [modal, setModal] = useState<'projects' | 'help' | null>(null)

  const [tab, setTab] = useState<PanelTab>(surface === 'overlay' ? 'art' : 'background')
  const [expanded, setExpanded] = useState(false)
  const [panelVisible, setPanelVisible] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [gifProgress, setGifProgress] = useState<{
    name: string
    done: number
    total: number
    kind: 'gif' | 'video'
  } | null>(null)
  const [videoCapture, setVideoCapture] = useState<'idle' | 'reading' | 'ready' | 'failed'>('idle')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [selection, setSelection] = useState<{ layerId: string | null; cutoutId: string | null }>({
    layerId: null,
    cutoutId: null,
  })

  const [page, setPage] = useState<PageState | null>(() => (surface === 'studio' ? readStudioPage() : null))
  const [previewOn, setPreviewOn] = useState(surface === 'overlay')
  const [compare, setCompare] = useState(false)
  const [editableOnPage, setEditableOnPage] = useState(surface === 'overlay')

  const [inventory, setInventory] = useState<InventoryState>({
    items: [],
    loading: false,
    error: null,
    loaded: false,
  })

  const [exportFiles, setExportFiles] = useState<ExportedFile[] | null>(null)
  const [exportWarnings, setExportWarnings] = useState<string[]>([])
  const [exportFormat, setExportFormat] = useState<'png' | 'gif'>('png')
  const [selfTestResult, setSelfTestResult] = useState<SelfTestResult | null>(null)

  const { toasts, push } = useToasts()
  const toast = useCallback((text: string, kind: 'info' | 'ok' | 'error' = 'info') => push(text, kind), [push])

  const settingsRef = useRef<SavedSettings>({})
  const saveErrorRef = useRef(false)
  const overrideRef = useRef<BackgroundOverride | null>(null)
  if (!overrideRef.current) overrideRef.current = new BackgroundOverride()
  const frozenBackgroundRef = useRef<string | null>(null)
  const autoBackgroundRef = useRef<string | null>(null)

  // ------------------------------------------------------------------ assets

  /** Throttled decode progress for the "GIF is loading" banner. */
  const gifProgressReporter = useCallback(
    (name: string) => (done: number, total: number) => {
      if (done !== 0 && done !== total && done % 5 !== 0) return
      const kind: 'gif' | 'video' = /\.(mp4|m4v|webm|mov|ogv)$/i.test(name) ? 'video' : 'gif'
      setGifProgress({ name, done, total, kind })
    },
    [],
  )

  const hydrateProjectAssets = useCallback(
    async (next: Project) => {
      const ids = new Set<string>()
      next.layers.forEach((layer) => ids.add(layer.assetId))
      if (next.background?.assetId) ids.add(next.background.assetId)
      for (const id of ids) {
        if (assets.get(id)) continue
        try {
          const stored = await loadAsset(id)
          if (stored) await assets.restore(stored.meta, stored.blob, gifProgressReporter(stored.meta.name))
        } catch {
          // A damaged blob should not prevent the rest of the project from opening.
        }
      }
      setGifProgress(null)
      setAssetsVersion((value) => value + 1)
    },
    [assets, gifProgressReporter],
  )

  // Background removal is asynchronous: each (asset, settings) pair is processed
  // once, then the canvas repaints. Slider drags are debounced, so only the final
  // tolerance pays for a pass over every frame.
  const keyingSpec = useMemo(
    () =>
      project.layers
        .filter((layer) => layer.keying?.enabled)
        .map((layer) => `${layer.assetId}|${keyingSignature(normalizeKeying(layer.keying))}`)
        .join(','),
    [project.layers],
  )

  // A failure must not retry in a loop: the effect bumps assetsVersion after
  // every pass, so remember which exact settings already failed. Changing a
  // slider produces a new signature and tries again.
  const keyingFailures = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!keyingSpec) {
      // Turning the last removal off must not leave "Убираю фон…" in the status.
      setBusy((current) => (current && current.startsWith('Убираю фон') ? null : current))
      return
    }
    const pending: { assetId: string; keying: LayerKeying }[] = []
    const seen = new Set<string>()
    for (const layer of project.layers) {
      if (!layer.keying?.enabled) continue
      const keying = normalizeKeying(layer.keying)
      const key = `${layer.assetId}|${keyingSignature(keying)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (assets.hasKeying(layer.assetId, keying) || keyingFailures.current.has(key)) continue
      pending.push({ assetId: layer.assetId, keying })
    }
    if (!pending.length) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          for (const job of pending) {
            if (cancelled) return
            setBusy('Убираю фон…')
            const ok = await assets.prepareKeying(job.assetId, job.keying, (done, total) => {
              if (cancelled) return
              setBusy(`Убираю фон: ${Math.round((done / Math.max(1, total)) * 100)}%`)
            })
            if (cancelled) return
            const jobKey = `${job.assetId}|${keyingSignature(job.keying)}`
            if (!ok) {
              keyingFailures.current.add(jobKey)
              toast('Не удалось убрать фон у одного из слоёв', 'error')
              continue
            }
            keyingFailures.current.delete(jobKey)
          }
          if (cancelled) return
          setAssetsVersion((value) => value + 1)
        } catch (error) {
          if (!cancelled) toast(`Не удалось убрать фон: ${errorText(error)}`, 'error')
        } finally {
          if (!cancelled) setBusy(null)
        }
      })()
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [assets, assetsVersion, keyingSpec, project.layers, toast])

  const thumbnailFor = useCallback(
    (target: Project): string | undefined => {      try {
        renderer.update(target, assets)
        const slot = projectSlotRect(target)
        const canvas = renderer.renderView(slot, Math.min(0.5, 320 / slot.w), 0)
        return canvas.toDataURL('image/jpeg', 0.62)
      } catch {
        return undefined
      }
    },
    [assets, renderer],
  )

  const persistProject = useCallback(
    async (target: Project) => {
      await saveProject(target, thumbnailFor(target))
      const entries = await listProjects()
      setProjects(entries)
      const settings = { ...settingsRef.current, lastProjectId: target.id }
      settingsRef.current = settings
      void saveSettings(settings)
    },
    [thumbnailFor],
  )

  // ------------------------------------------------------------------ startup

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const settings = await loadSettings()
        settingsRef.current = settings
        const [entries, estimate] = await Promise.all([listProjects(), estimateStorage()])
        if (!alive) return
        setProjects(entries)
        setStorage(estimate)

        let next: Project | null = null
        if (settings.lastProjectId) next = await loadProject(settings.lastProjectId)
        if (!next && entries[0]) next = await loadProject(entries[0].id)
        if (!next) next = createProject()

        await hydrateProjectAssets(next)
        if (!alive) return
        setProject(next)
        setReady(true)
      } catch (error) {
        if (!alive) return
        setReady(true)
        toast(`Не удалось открыть сохранённый проект: ${errorText(error)}`, 'error')
      }
    })()
    return () => {
      alive = false
    }
    // Runs once per mounted editor; the asset library is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => {
      void persistProject(project).catch(() => {
        if (saveErrorRef.current) return
        saveErrorRef.current = true
        toast('Не удалось сохранить проект. Возможно, в браузере закончилось место.', 'error')
      })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [project, ready, persistProject, toast])

  // ------------------------------------------------------------------ page

  // Natural size of the profile background bitmap the editor loaded. CSS only
  // reports `background-size: auto`, so this is how we know how large the bitmap
  // is actually painted (custom SPM backgrounds are not always 1920 px wide).
  const profileBackgroundSizeRef = useRef<{ width: number; height: number } | null>(null)

  const syncPage = useCallback(() => {
    if (surface !== 'overlay') return
    const next = readPageState({ backgroundSize: profileBackgroundSizeRef.current })
    if (overrideRef.current?.owned && frozenBackgroundRef.current) {
      // Our own background swap must not look like a new profile background.
      next.backgroundUrl = frozenBackgroundRef.current
    }
    setPage((previous) => (previous && samePage(previous, next) ? previous : next))
  }, [surface])

  useEffect(() => {
    if (surface !== 'overlay') return
    syncPage()
    const stop = observePage(syncPage)
    // Watching the whole document for every child/style change made the page
    // sync run dozens of times per second on busy Steam pages. That is what
    // looked like a background "process": there is no worker, only a read-only
    // layout watcher. Watch the profile subtree and coalesce bursts.
    let timer = 0
    const schedule = () => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = 0
        syncPage()
      }, 200)
    }
    const observer = new MutationObserver(schedule)
    // One subtree is enough: SPM and Steam both change nodes inside the profile
    // root. Watching nested containers too only multiplied the callbacks.
    const root =
      document.querySelector('.profile_page') ??
      document.querySelector('#responsive_page_template_content')
    if (root) {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
    }
    return () => {
      stop()
      observer.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [surface, syncPage])

  // Re-measure once the profile background bitmap's real dimensions are known.
  // Before that the frame uses Steam's 1920×1080 default, which is wrong for a
  // custom SPM background of another size.
  useEffect(() => {
    const background = project.background
    const usable =
      background && background.source === 'profile' && background.width > 0 && background.height > 0
        ? { width: background.width, height: background.height }
        : null
    const previous = profileBackgroundSizeRef.current
    profileBackgroundSizeRef.current = usable
    if (
      !!previous !== !!usable ||
      previous?.width !== usable?.width ||
      previous?.height !== usable?.height
    ) {
      syncPage()
    }
  }, [project.background, syncPage])

  // A tiled profile background (a small seamless bitmap Steam repeats 1:1) keeps
  // its grid on the background itself, so the preview and the export draw the
  // same plate the page shows. Ordinary 1920 backgrounds and SPM videos never
  // produce a tile, so their behaviour is unchanged.
  useEffect(() => {
    const background = project.background
    const tile = page?.backgroundTile
    if (!background || background.source !== 'profile' || !tile) return
    if (background.url !== page?.backgroundUrl) return
    const current = background.tile
    if (
      current &&
      current.width === tile.width &&
      current.height === tile.height &&
      current.offsetX === tile.offsetX &&
      current.offsetY === tile.offsetY &&
      current.repeatX === tile.repeatX &&
      current.repeatY === tile.repeatY
    ) {
      return
    }
    setProject((value) =>
      value.background && value.background.url === background.url
        ? { ...value, background: { ...value.background, tile }, updatedAt: Date.now() }
        : value,
    )
  }, [page?.backgroundTile, page?.backgroundUrl, project.background])

  const refreshPage = useCallback(() => {
    if (surface !== 'overlay') {
      toast('Живая страница доступна в панели расширения на профиле Steam', 'info')
      return
    }
    syncPage()
    toast('Разметка профиля обновлена', 'ok')
  }, [surface, syncPage, toast])

  /** Measured top-left of a showcase on the live profile canvas. */
  const originForKind = useCallback(
    (kind: ShowcaseKind): { x: number; y: number } | null => {
      const anchor = page?.anchors.find((item) => item.kind === kind)
      return anchor?.origin ? { x: anchor.origin.x, y: anchor.origin.y } : null
    },
    [page],
  )

  /**
   * Slot of a showcase right now: the measured page position when the panel
   * runs on a profile, otherwise the fixed design layout. This is a pure lookup
   * and never writes back into the project — the previous auto-sync effect did,
   * which moved layers and broke showcase detection on every page update.
   */
  const slotFor = useCallback(
    (kind: ShowcaseKind, height = project.showcaseHeight) =>
      slotRectFor(kind, height, originForKind(kind) ?? undefined),
    [originForKind, project.showcaseHeight],
  )

  const activeSlot = slotFor(project.target)

  /**
   * Capture geometry for the SPM video background.
   *
   * `old` keeps the 960 px long side, `full` samples the native frame up to
   * 1920 px, and `slot` samples only the showcase area, so every exported pixel
   * comes from a real video pixel instead of an upscaled 960 px frame.
   *
   * The id carries the mode and (for `slot`) the snapped region: changing the
   * dropdown, the showcase size or the page layout must capture new frames
   * rather than reuse old ones. Snapping the region to 32 px keeps small layout
   * shifts from invalidating the cache.
   */
  const videoPlanFor = useCallback(
    (src: string) => {
      const mode = project.export.gifBackground
      if (mode === 'slot') {
        const slot = slotFor(project.target, project.showcaseHeight)
        const pad = 80
        const snap = 32
        const left = Math.floor((slot.x - pad) / snap) * snap
        const top = Math.floor((slot.y - pad) / snap) * snap
        const right = Math.ceil((slot.x + slot.w + pad) / snap) * snap
        const bottom = Math.ceil((slot.y + slot.h + pad) / snap) * snap
        const crop = { x: left, y: top, w: right - left, h: bottom - top }
        return {
          maxSide: FULL_MAX_SIDE,
          crop,
          id: `video-${hashString(`${src}|slot|${crop.x},${crop.y},${crop.w},${crop.h}`)}`,
        }
      }
      // The number is the long side of the sampled frame; capture never upscales
      // past the video's own resolution.
      const maxSide = Math.max(64, Math.round(mode))
      return {
        maxSide,
        crop: null,
        id: `video-${hashString(`${src}|side|${maxSide}`)}`,
      }
    },
    [project.export.gifBackground, project.showcaseHeight, project.target, slotFor],
  )

  // The background is only swapped visually; Steam's DOM structure is untouched.
  const backgroundRecord = project.background?.assetId ? assets.get(project.background.assetId) : undefined
  const backgroundBlobUrl = useObjectUrl(backgroundRecord?.blob)
  const rawBackgroundUrl = project.background?.url ?? ''
  const backgroundSwapUrl = project.background
    ? /^(https?:|data:|blob:)/i.test(rawBackgroundUrl)
      ? rawBackgroundUrl
      : backgroundBlobUrl
    : null

  useEffect(() => {
    const override = overrideRef.current!
    // SPM already renders the video/poster on the page. Swapping its style for
    // a video URL would break it, so leave the element alone while the project
    // background is the profile's video.
    const pageOwnsVideo = !!page?.backgroundIsVideo && project.background?.source === 'profile'
    const active =
      surface === 'overlay' &&
      !!page?.isProfile &&
      previewOn &&
      !compare &&
      project.previewBackground &&
      !!project.background &&
      !pageOwnsVideo

    if (!active) {
      if (override.owned) override.restore()
      frozenBackgroundRef.current = null
      return
    }
    const element = page?.backgroundElement
    if (!element || !backgroundSwapUrl) return
    const sameAsPage =
      page.backgroundUrl === backgroundSwapUrl ||
      (!!project.background?.url && page.backgroundUrl === project.background.url)
    if (sameAsPage) {
      if (override.owned) override.restore()
      frozenBackgroundRef.current = null
      return
    }
    if (!override.owned) frozenBackgroundRef.current = page.backgroundUrl
    override.apply(element, backgroundSwapUrl)
  }, [
    surface,
    page?.isProfile,
    page?.backgroundElement,
    page?.backgroundUrl,
    previewOn,
    compare,
    project.previewBackground,
    project.background,
    backgroundSwapUrl,
  ])

  useEffect(
    () => () => {
      overrideRef.current?.restore()
      frozenBackgroundRef.current = null
    },
    [],
  )

  // ------------------------------------------------------------------ project flow

  const updateProject = useCallback((updater: (current: Project) => Project) => {
    setProject((current) => {
      const next = updater(current)
      if (next === current) return current
      return next.updatedAt === current.updatedAt ? { ...next, updatedAt: Date.now() } : next
    })
  }, [])

  const patchProject = useCallback(
    (patch: Partial<Project>) => {
      updateProject((current) => {
        let next: Project = { ...current, ...patch }
        if (patch.canvasHeight !== undefined) next.canvasHeight = clampCanvasHeight(patch.canvasHeight)
        if (patch.showcaseHeight !== undefined) next.showcaseHeight = clampShowcaseHeight(patch.showcaseHeight)

        if (patch.target && patch.target !== current.target) {
          // Switching the target showcase means the whole composition moves to
          // that block. The delta uses the same measured/design slot the preview
          // uses, so Workshop gets its image even when it sits lower than the
          // featured block.
          const oldSlot = slotFor(current.target, current.showcaseHeight)
          const nextSlot = slotFor(patch.target, next.showcaseHeight)
          const dx = nextSlot.x - oldSlot.x
          const dy = nextSlot.y - oldSlot.y
          next = {
            ...next,
            layers: next.layers.map((layer) => ({ ...layer, cx: layer.cx + dx, cy: layer.cy + dy })),
            cutouts: next.cutouts.map((cutout) => ({ ...cutout, x: cutout.x + dx, y: cutout.y + dy })),
          }
        }

        return next
      })
    },
    [slotFor, updateProject],
  )

  // ------------------------------------------------------------------ video background

  /**
   * In-flight capture per video URL. Keeping the promise (instead of an "already
   * running" flag) matters because the profile background is loaded
   * asynchronously: the first effect run may start a capture, then a background
   * reload re-runs the effect. Aborting on every re-render used to throw the
   * captured frames away and leave the scene as a still poster.
   */
  const videoCaptureRef = useRef<{ src: string; promise: Promise<GifAsset | null> } | null>(null)

  // SPM's animated background is a <video>. Capture its real frames so the
  // preview animates and the export is a GIF rather than the poster still.
  useEffect(() => {
    if (surface !== 'overlay') return
    const video = page?.backgroundVideo
    if (!video) {
      videoCaptureRef.current = null
      setVideoCapture('idle')
      return
    }
    const src = video.currentSrc || video.poster || page?.backgroundUrl || 'spm-video'
    const background = project.background
    // Only attach frames to the profile background; a user-picked background
    // must not be replaced by the page video.
    if (background && background.source !== 'profile') {
      setVideoCapture('idle')
      return
    }
    const plan = videoPlanFor(src)

    // Record the video source right away. Even if decoding fails (cross-origin
    // without CORS), the export still knows the scene moves and stays GIF.
    if (background && background.videoUrl !== src) {
      updateProject((current) => {
        const existing = current.background
        if (!existing || existing.source !== 'profile' || existing.videoUrl === src) return current
        return { ...current, background: { ...existing, videoUrl: src } }
      })
    }

    if (background?.videoAssetId === plan.id && assets.get(plan.id)) {
      setVideoCapture('ready')
      return
    }

    let pending = videoCaptureRef.current
    if (!pending || pending.src !== plan.id) {
      pending = {
        src: plan.id,
        promise: captureVideoFrames(video, { crop: plan.crop, maxSide: plan.maxSide }),
      }
      videoCaptureRef.current = pending
    }
    setVideoCapture('reading')
    let alive = true
    void pending.promise
      .then((gif) => {
        if (!alive) return
        if (!gif || !gif.frames.length) {
          // Allow a later attempt on the next page update.
          if (videoCaptureRef.current === pending) videoCaptureRef.current = null
          setVideoCapture('failed')
          return
        }
        const id = plan.id
        assets.registerGif(id, 'Видео-фон SPM', 'background', gif)
        setAssetsVersion((value) => value + 1)
        setVideoCapture('ready')
        updateProject((current) => {
          const existing = current.background
          if (existing && existing.source !== 'profile') return current
          return {
            ...current,
            background: {
              url: existing?.url || page?.backgroundUrl || '',
              assetId: existing?.assetId,
              videoUrl: src,
              videoAssetId: id,
              name: existing?.name || 'Видео-фон SPM',
              source: 'profile',
              width: gif.width,
              height: gif.height,
            },
            // A video background must leave as GIF.
            export: { ...current.export, format: 'gif' },
          }
        })
      })
      .catch(() => {
        if (videoCaptureRef.current === pending) videoCaptureRef.current = null
        if (alive) setVideoCapture('failed')
      })
    return () => {
      alive = false
    }
  }, [surface, page?.backgroundVideo, page?.backgroundUrl, project.background, assets, updateProject, videoPlanFor])

  // The studio tab has no profile <video>, but the saved project remembers the
  // SPM clip URL. Capture it from there too, so exporting from the studio keeps
  // the animation instead of silently falling back to the poster.
  useEffect(() => {
    if (surface !== 'studio') return
    const background = project.background
    if (!background || background.source !== 'profile' || !background.videoUrl) return
    const src = background.videoUrl
    const plan = videoPlanFor(src)
    if (background.videoAssetId === plan.id && assets.get(plan.id)?.gif) {
      setVideoCapture('ready')
      return
    }
    let pending = videoCaptureRef.current
    if (!pending || pending.src !== plan.id) {
      pending = {
        src: plan.id,
        promise: captureVideoUrl(src, { crop: plan.crop, maxSide: plan.maxSide }),
      }
      videoCaptureRef.current = pending
    }
    setVideoCapture('reading')
    let alive = true
    void pending.promise
      .then((gif) => {
        if (!alive) return
        if (!gif || !gif.frames.length) {
          if (videoCaptureRef.current === pending) videoCaptureRef.current = null
          setVideoCapture('failed')
          return
        }
        const id = plan.id
        assets.registerGif(id, 'Видео-фон SPM', 'background', gif)
        setAssetsVersion((value) => value + 1)
        setVideoCapture('ready')
        updateProject((current) => {
          const existing = current.background
          if (!existing || existing.source !== 'profile' || existing.videoUrl !== src) return current
          // Keep the shown dimensions in sync with the sampled frame: the studio
          // has no <video>, so this is the only place that records whether the
          // chosen resolution was actually applied (and it updates the badge).
          if (existing.videoAssetId === id && existing.width === gif.width && existing.height === gif.height) {
            return current
          }
          return { ...current, background: { ...existing, videoAssetId: id, width: gif.width, height: gif.height } }
        })
      })
      .catch(() => {
        if (videoCaptureRef.current === pending) videoCaptureRef.current = null
        if (alive) setVideoCapture('failed')
      })
    return () => {
      alive = false
    }
  }, [surface, project.background, assets, updateProject, videoPlanFor])

  // A video tells us its real frame size only after metadata loads. The page
  // state read before that used a placeholder size, so refresh placement once.
  useEffect(() => {
    if (surface !== 'overlay') return
    const video = page?.backgroundVideo
    if (!video || (video.videoWidth > 0 && video.videoHeight > 0)) return
    const refresh = () => syncPage()
    video.addEventListener('loadedmetadata', refresh)
    return () => video.removeEventListener('loadedmetadata', refresh)
  }, [surface, page?.backgroundVideo, syncPage])

  // An animated scene always leaves as GIF.
  const animatedScene = hasAnimatedLayers(project, assets) || hasVideoBackground(project)
  useEffect(() => {
    if (!ready || !animatedScene) return
    if (project.export.format === 'gif') return
    updateProject((current) =>
      current.export.format === 'gif'
        ? current
        : { ...current, export: { ...current.export, format: 'gif' } },
    )
  }, [ready, animatedScene, project.export.format, updateProject])

  const updateLayer = useCallback(
    (layer: Layer) => {
      updateProject((current) => ({
        ...current,
        layers: current.layers.map((item) => (item.id === layer.id ? layer : item)),
      }))
    },
    [updateProject],
  )

  const updateCutout = useCallback(
    (cutout: Cutout) => {
      updateProject((current) => ({
        ...current,
        cutouts: current.cutouts.map((item) => (item.id === cutout.id ? cutout : item)),
      }))
    },
    [updateProject],
  )

  const selectLayer = useCallback((id: string | null) => {
    setSelection((current) => ({ ...current, layerId: id }))
  }, [])

  const selectCutout = useCallback((id: string | null) => {
    setSelection((current) => ({ ...current, cutoutId: id }))
  }, [])

  const removeLayer = useCallback(
    (id: string) => {
      updateProject((current) => ({ ...current, layers: current.layers.filter((layer) => layer.id !== id) }))
      setSelection((current) => (current.layerId === id ? { ...current, layerId: null } : current))
    },
    [updateProject],
  )

  const duplicateLayer = useCallback(
    (id: string) => {
      let copyId: string | null = null
      updateProject((current) => {
        const index = current.layers.findIndex((layer) => layer.id === id)
        if (index < 0) return current
        const source = current.layers[index]!
        const copy: Layer = {
          ...source,
          id: uid('l'),
          name: `${source.name} копия`,
          cx: source.cx + 18,
          cy: source.cy + 18,
        }
        copyId = copy.id
        const layers = [...current.layers]
        layers.splice(index + 1, 0, copy)
        return { ...current, layers }
      })
      if (copyId) setSelection((current) => ({ ...current, layerId: copyId }))
    },
    [updateProject],
  )

  const moveLayer = useCallback(
    (id: string, direction: -1 | 1) => {
      updateProject((current) => {
        const index = current.layers.findIndex((layer) => layer.id === id)
        const target = index + direction
        if (index < 0 || target < 0 || target >= current.layers.length) return current
        const layers = [...current.layers]
        const [layer] = layers.splice(index, 1)
        layers.splice(target, 0, layer!)
        return { ...current, layers }
      })
    },
    [updateProject],
  )

  const addLayerToWindow = useCallback(
    (layerId?: string) => {
      const layer =
        project.layers.find((item) => item.id === (layerId ?? selection.layerId)) ??
        project.layers[project.layers.length - 1]
      if (!layer) {
        toast('Сначала добавьте картинку', 'error')
        return
      }
      const record = assets.get(layer.assetId)
      if (!record) return
      const cutout = project.cutouts.find((item) => item.enabled && item.w > 0 && item.h > 0)
      const targetRect = cutout ?? slotFor(project.target)
      const sourceWidth = record.meta.width * layer.crop.w
      const sourceHeight = record.meta.height * layer.crop.h
      const fit = Math.min(targetRect.w / Math.max(1, sourceWidth), targetRect.h / Math.max(1, sourceHeight)) * 0.92
      updateLayer({
        ...layer,
        cx: targetRect.x + targetRect.w / 2,
        cy: targetRect.y + targetRect.h / 2,
        scale: Number.isFinite(fit) && fit > 0 ? fit : layer.scale,
      })
      toast(cutout ? 'Картинка вписана в прозрачное окно' : 'Картинка вписана в витрину', 'ok')
    },
    [assets, project, selection.layerId, slotFor, toast, updateLayer],
  )

  const addArtFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files]
      if (!list.length) return
      setBusy('Читаю файлы…')
      let working = project
      const added: Layer[] = []
      let failed = 0
      let hasAnimatedGif = false
      const artSlot = slotFor(working.target, working.showcaseHeight)
      try {
        for (const file of list) {
          try {
            const record = await assets.addFile(file, 'art', gifProgressReporter(file.name))
            await saveAsset(record.meta, record.blob)
            if (record.gif && record.gif.frames.length > 1) hasAnimatedGif = true
            const cutout = working.cutouts.find((item) => item.enabled && item.w > 0 && item.h > 0)
            const targetRect = cutout ?? artSlot
            const layer = addLayerForAsset(record, targetRect, working.layers)
            working = { ...working, layers: [...working.layers, layer], updatedAt: Date.now() }
            added.push(layer)
          } catch (error) {
            failed += 1
            toast(`${file.name}: ${errorText(error)}`, 'error')
          }
        }
        if (added.length) {
          if (hasAnimatedGif) working = { ...working, export: { ...working.export, format: 'gif' } }
          setProject(working)
          setAssetsVersion((value) => value + 1)
          setSelection((current) => ({ ...current, layerId: added[added.length - 1]!.id }))
          const gifs = added.filter((layer) => {
            const item = assets.get(layer.assetId)
            return item?.meta.kind === 'gif' && (item.gif?.frames.length ?? 0) > 1
          }).length
          const videos = added.filter((layer) => assets.get(layer.assetId)?.meta.kind === 'video').length
          toast(
            added.length === 1
              ? videos
                ? `Видео добавлено: ${added[0]!.name}`
                : gifs
                  ? `GIF добавлен: ${added[0]!.name}`
                  : `Картинка добавлена: ${added[0]!.name}`
              : `Добавлено файлов: ${added.length}`,
            'ok',
          )
        }
        if (failed && !added.length) toast('Не удалось прочитать файлы', 'error')
      } finally {
        setBusy(null)
        setGifProgress(null)
      }
    },
    [assets, gifProgressReporter, project, slotFor, toast],
  )

  const loadBackground = useCallback(
    async (url: string, name: string, source: Background['source'], silent = false) => {
      const value = url.trim()
      if (!value) {
        toast('Пустая ссылка на изображение', 'error')
        return
      }
      if (!silent) setBusy('Загружаю фон…')
      try {
        const record = await assets.addUrl(
          value,
          'background',
          `${name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 50) || 'background'}.img`,
          gifProgressReporter(name),
        )
        await saveAsset(record.meta, record.blob).catch(() => undefined)
        const background: Background = {
          url: value,
          assetId: record.meta.id,
          name,
          source,
          width: record.meta.width,
          height: record.meta.height,
        }
        setProject((current) => ({ ...current, background, updatedAt: Date.now() }))
        setAssetsVersion((version) => version + 1)
        if (!silent) toast(source === 'profile' ? 'Фон профиля загружен' : `Фон выбран: ${name}`, 'ok')
      } catch (error) {
        if (!silent) {
          toast(
            `Не удалось загрузить фон: ${errorText(error)}. Попробуйте выбрать файл с компьютера.`,
            'error',
          )
        }
      } finally {
        if (!silent) setBusy(null)
        setGifProgress(null)
      }
    },
    [assets, gifProgressReporter, toast],
  )

  const pickBackground = useCallback(
    (url: string, name: string, source: Background['source']) => loadBackground(url, name, source, false),
    [loadBackground],
  )

  const uploadBackground = useCallback(
    async (file: File) => {
      setBusy('Читаю фон…')
      try {
        const record = await assets.addFile(file, 'background', gifProgressReporter(file.name))
        await saveAsset(record.meta, record.blob)
        const background: Background = {
          url: record.meta.name,
          assetId: record.meta.id,
          name: record.meta.name.replace(/\.[^.]+$/, ''),
          source: 'file',
          width: record.meta.width,
          height: record.meta.height,
        }
        setProject((current) => ({ ...current, background, updatedAt: Date.now() }))
        setAssetsVersion((value) => value + 1)
        toast('Свой фон загружен', 'ok')
      } catch (error) {
        toast(`Не удалось прочитать фон: ${errorText(error)}`, 'error')
      } finally {
        setBusy(null)
        setGifProgress(null)
      }
    },
    [assets, gifProgressReporter, toast],
  )

  const useProfileBackground = useCallback(async () => {
    const url = page?.backgroundUrl
    if (!url) {
      toast('На странице не найден фон профиля. Откройте свой профиль Steam.', 'error')
      return
    }
    if (project.background?.url === url) {
      toast('Этот фон уже выбран', 'info')
      return
    }
    await loadBackground(url, 'Фон с профиля', 'profile', false)
  }, [loadBackground, page?.backgroundUrl, project.background?.url, toast])

  // Keep the project's plate in sync with the live profile: a new project takes
  // the background it sees, and a profile background changed by SPM is picked up
  // without touching SPM's own style.
  useEffect(() => {
    if (!ready || !page?.backgroundUrl) return
    const current = project.background
    const shouldRefresh = !current || (current.source === 'profile' && current.url !== page.backgroundUrl)
    if (!shouldRefresh || autoBackgroundRef.current === page.backgroundUrl) return
    autoBackgroundRef.current = page.backgroundUrl
    void loadBackground(page.backgroundUrl, 'Фон с профиля', 'profile', true)
  }, [ready, project.background, page?.backgroundUrl, loadBackground])

  // ------------------------------------------------------------------ windows

  const makeCenterTransparent = useCallback(() => {
    if (project.cutouts.length) {
      const first = project.cutouts[0]!
      setSelection((current) => ({ ...current, cutoutId: first.id }))
      toast('Прозрачное окно уже создано — двигайте его на холсте', 'info')
      return
    }
    const slot = activeSlot
    const w = Math.round(slot.w * 0.76)
    const h = Math.round(slot.h * 0.76)
    const cutout: Cutout = {
      id: uid('c'),
      x: Math.round(slot.x + (slot.w - w) / 2),
      y: Math.round(slot.y + (slot.h - h) / 2),
      w,
      h,
      radius: 22,
      feather: 0,
      enabled: true,
    }
    updateProject((current) => ({ ...current, cutouts: [...current.cutouts, cutout] }))
    setSelection((current) => ({ ...current, cutoutId: cutout.id }))
    toast('Центр прозрачный. Настройте окно на вкладке «Окно».', 'ok')
  }, [activeSlot, toast, updateProject])

  const addCutout = useCallback(() => {
    const slot = activeSlot
    const offset = ((project.cutouts.length % 4) + 1) * 12
    const w = Math.round(slot.w * 0.38)
    const h = Math.round(slot.h * 0.52)
    const cutout: Cutout = {
      id: uid('c'),
      x: Math.round(slot.x + (slot.w - w) / 2 + offset),
      y: Math.round(slot.y + (slot.h - h) / 2 + offset),
      w,
      h,
      radius: 18,
      feather: 0,
      enabled: true,
    }
    updateProject((current) => ({ ...current, cutouts: [...current.cutouts, cutout] }))
    setSelection((current) => ({ ...current, cutoutId: cutout.id }))
  }, [activeSlot, project.cutouts.length, updateProject])

  const removeCutout = useCallback(
    (id: string) => {
      updateProject((current) => ({ ...current, cutouts: current.cutouts.filter((cutout) => cutout.id !== id) }))
      setSelection((current) => (current.cutoutId === id ? { ...current, cutoutId: null } : current))
    },
    [updateProject],
  )

  const fitCutoutToSlot = useCallback(
    (id: string) => {
      const cutout = project.cutouts.find((item) => item.id === id)
      if (!cutout) return
      const slot = activeSlot
      updateCutout({ ...cutout, x: slot.x, y: slot.y, w: slot.w, h: slot.h })
    },
    [activeSlot, project, updateCutout],
  )

  const centerCutout = useCallback(
    (id: string) => {
      const cutout = project.cutouts.find((item) => item.id === id)
      if (!cutout) return
      const slot = activeSlot
      updateCutout({
        ...cutout,
        x: Math.round(slot.x + (slot.w - cutout.w) / 2),
        y: Math.round(slot.y + (slot.h - cutout.h) / 2),
      })
    },
    [activeSlot, project, updateCutout],
  )

  // ------------------------------------------------------------------ inventory

  const loadInventory = useCallback(async () => {
    const steamId = page?.steamId
    if (!steamId) {
      setInventory((current) => ({
        ...current,
        error: 'SteamID не найден. Откройте панель на странице своего профиля Steam.',
        loaded: false,
      }))
      return
    }
    setInventory((current) => ({ ...current, loading: true, error: null }))
    try {
      const items: BackgroundOption[] = await loadInventoryBackgrounds(steamId)
      setInventory({
        items,
        loading: false,
        error: items.length ? null : 'В инвентаре не найдено фонов профиля.',
        loaded: true,
      })
    } catch (error) {
      setInventory({ items: [], loading: false, error: errorText(error), loaded: false })
    }
  }, [page?.steamId])

  // ------------------------------------------------------------------ export

  const exportNow = useCallback(
    async (zip: boolean) => {
      if (busy) return
      setBusy('Готовлю экспорт…')
      setProgress({ label: 'Подготовка', done: 0, total: 1 })
      let stage = 'Подготовка'
      try {
        // Changing the SPM video resolution starts a fresh capture. If the
        // download is clicked before that finishes, the export would silently
        // keep the previous sample size, so wait for the current capture plan.
        let exportSource = project
        const background = project.background
        if (background?.source === 'profile' && background.videoUrl) {
          const plan = videoPlanFor(background.videoUrl)
          if (background.videoAssetId !== plan.id || !assets.get(plan.id)?.gif) {
            stage = 'Читаю кадры видео-фона'
            setProgress({ label: stage, done: 0, total: 1 })
            const pending = videoCaptureRef.current
            const promise =
              pending?.src === plan.id
                ? pending.promise
                : surface === 'overlay' && page?.backgroundVideo
                  ? captureVideoFrames(page.backgroundVideo, { crop: plan.crop, maxSide: plan.maxSide })
                  : captureVideoUrl(background.videoUrl, { crop: plan.crop, maxSide: plan.maxSide })
            const gif = await promise
            if (gif?.frames.length) {
              assets.registerGif(plan.id, 'Видео-фон SPM', 'background', gif)
              setAssetsVersion((value) => value + 1)
              exportSource = {
                ...project,
                background: { ...background, videoAssetId: plan.id, width: gif.width, height: gif.height },
              }
            }
          }
        }
        // A freshly enabled background removal may still be processing its
        // frames. Export has to wait, otherwise the first GIF would contain the
        // original backdrop.
        for (const layer of project.layers) {
          if (!layer.keying?.enabled) continue
          stage = 'Убираю фон'
          setProgress({ label: `Убираю фон: ${layer.name}`, done: 0, total: 1 })
          await assets.prepareKeying(layer.assetId, layer.keying, (done, total) => {
            setProgress({ label: `Убираю фон: ${layer.name}`, done, total })
          })
          const ready = assets.hasKeying(layer.assetId, layer.keying)
          if (!ready) throw new Error(`не удалось обработать слой «${layer.name}»`)
        }
        // The measured showcase origin is an export-time override, not project
        // state. This keeps exports aligned with the real block without moving
        // the composition on the next page update.
        const measured = originForKind(project.target) ?? undefined
        const result = await exportProject(
          exportSource,
          assets,
          (value) => {
            stage = value.label
            setProgress(value)
          },
          { slot: measured },
        )
        setExportFiles(result.files)
        setExportWarnings(result.warnings)
        setExportFormat(result.format)
        if (zip) {
          stage = 'Скачивание ZIP'
          downloadBlob(result.zip, `${safeFileName(project.name)}-${project.target}.zip`)
          toast(`ZIP готов: ${result.files.length} файл(ов) · ${result.format.toUpperCase()}`, 'ok')
        } else {
          toast(`Сформировано файлов: ${result.files.length} · ${result.format.toUpperCase()}`, 'ok')
        }
      } catch (error) {
        // The page console used to show only React's broken "Error generating
        // stack" message. Log the raw error and the stage it happened in.
        console.error(`[SPD] экспорт не удался на шаге «${stage}»:`, error)
        toast(`Экспорт не удался (${stage}): ${errorText(error)}`, 'error')
      } finally {
        setBusy(null)
        setProgress(null)
      }
    },
    [assets, busy, originForKind, page?.backgroundVideo, project, surface, toast, videoPlanFor],
  )

  const downloadFile = useCallback((file: ExportedFile) => {
    downloadBlob(file.blob, file.name)
  }, [])

  const exportProjectFile = useCallback(async () => {
    setBusy('Собираю файл проекта…')
    try {
      const blob = await packProject(project, assets)
      downloadBlob(blob, `${safeFileName(project.name)}.spd.zip`)
      toast('Файл проекта скачан', 'ok')
    } catch (error) {
      toast(`Не удалось собрать проект: ${errorText(error)}`, 'error')
    } finally {
      setBusy(null)
    }
  }, [assets, project, toast])

  const selfTest = useCallback(async () => {
    setBusy('Проверяю пайплайн…')
    const lines: string[] = []
    let ok = true
    const started = performance.now()
    let library: AssetLibrary | null = null
    try {
      library = new AssetLibrary()
      const source = document.createElement('canvas')
      source.width = 320
      source.height = 180
      const sourceCtx = source.getContext('2d')
      if (!sourceCtx) throw new Error('Canvas 2D недоступен')
      const gradient = sourceCtx.createLinearGradient(0, 0, 320, 180)
      gradient.addColorStop(0, '#66c0f4')
      gradient.addColorStop(1, '#1b2838')
      sourceCtx.fillStyle = gradient
      sourceCtx.fillRect(0, 0, 320, 180)
      const png = await canvasBlob(source, 'image/png')
      const record = await library.addFile(new File([png], 'self-test.png', { type: 'image/png' }), 'background')

      const testProject: Project = {
        ...createProject('self-test'),
        background: {
          url: '',
          assetId: record.meta.id,
          name: 'self-test',
          source: 'file',
          width: record.meta.width,
          height: record.meta.height,
        },
        canvasHeight: 180,
        cutouts: [{ id: 'test-window', x: 80, y: 50, w: 160, h: 80, radius: 12, feather: 0, enabled: true }],
        showcaseHeight: 120,
      }
      const testRenderer = new CompositionRenderer(testProject, library)
      const rendered = testRenderer.renderView({ x: 0, y: 0, w: 320, h: 180 }, 1, 0)
      const renderedCtx = rendered.getContext('2d')
      if (!renderedCtx) throw new Error('Canvas 2D недоступен')
      const center = renderedCtx.getImageData(160, 90, 1, 1).data[3]!
      const corner = renderedCtx.getImageData(4, 4, 1, 1).data[3]!
      lines.push(`Отрисовка 320×180: ${Math.round(performance.now() - started)} мс`)
      lines.push(`Прозрачность: центр alpha=${center}, край alpha=${corner}`)
      if (center !== 0 || corner < 250) {
        ok = false
        lines.push('Прозрачность: не совпадает с ожидаемой (центр 0, край 255)')
      }

      const frame = (index: number) => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 64
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas 2D недоступен')
        ctx.fillStyle = index === 0 ? '#66c0f4' : '#a4d007'
        ctx.fillRect(0, 0, 64, 64)
        ctx.fillStyle = '#0f1319'
        ctx.fillRect(8 + index * 22, 18, 22, 28)
        return canvas
      }
      const encoded = await encodeGif({
        width: 64,
        height: 64,
        delays: [80, 120],
        colors: 64,
        dither: false,
        maxBytes: 1_000_000,
        renderFrame: frame,
      })
      const decoded = await decodeGif(encoded.bytes)
      const duration = decoded.duration
      lines.push(
        `GIF: ${encoded.bytes.length} Б, ${decoded.frames.length} кадра, ${duration} мс, попыток ${encoded.attempts}`,
      )
      if (decoded.frames.length !== 2 || duration < 160) {
        ok = false
        lines.push('GIF: число кадров или длительность не совпали')
      }
      decoded.frames.forEach((item) => item.bitmap.close())
      lines.push(`Общее время: ${Math.round(performance.now() - started)} мс`)
      lines.push(ok ? 'Итог: отрисовка, прозрачность и GIF работают' : 'Итог: есть ошибки, см. выше')
    } catch (error) {
      ok = false
      lines.push(`Ошибка: ${errorText(error)}`)
    } finally {
      library?.dispose()
      setSelfTestResult({ ok, lines })
      setBusy(null)
      toast(ok ? 'Проверка пройдена' : 'Проверка нашла проблему', ok ? 'ok' : 'error')
    }
  }, [toast])

  const openUploadPage = useCallback(() => {
    const runtime = globalChrome()
    if (runtime) {
      void runtime.tabs.create({ url: UPLOAD_PAGE })
      return
    }
    window.open(UPLOAD_PAGE, '_blank', 'noopener')
  }, [])

  // ------------------------------------------------------------------ projects

  const openProjects = useCallback(() => {
    void (async () => {
      const [entries, estimate] = await Promise.all([listProjects(), estimateStorage()])
      setProjects(entries)
      setStorage(estimate)
      setModal('projects')
    })()
  }, [])

  const newProject = useCallback(async () => {
    setBusy('Создаю проект…')
    try {
      await persistProject(project).catch(() => undefined)
      const next = createProject()
      setProject(next)
      setSelection({ layerId: null, cutoutId: null })
      setTab('background')
      setModal(null)
      toast('Создан новый проект', 'ok')
    } finally {
      setBusy(null)
    }
  }, [persistProject, project, toast])

  const openProject = useCallback(
    async (id: string) => {
      if (id === project.id) return
      setBusy('Открываю проект…')
      try {
        await persistProject(project).catch(() => undefined)
        const stored = await loadProject(id)
        if (!stored) throw new Error('Проект не найден в этом браузере')
        await hydrateProjectAssets(stored)
        setProject(stored)
        setSelection({ layerId: null, cutoutId: null })
        setTab('background')
        setModal(null)
        toast(`Открыт проект «${stored.name}»`, 'ok')
      } catch (error) {
        toast(`Не удалось открыть проект: ${errorText(error)}`, 'error')
      } finally {
        setBusy(null)
      }
    },
    [hydrateProjectAssets, persistProject, project, toast],
  )

  const duplicateProject = useCallback(async () => {
    setBusy('Дублирую проект…')
    try {
      await persistProject(project).catch(() => undefined)
      const copy: Project = {
        ...project,
        id: uid('p'),
        name: `${project.name} копия`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        layers: project.layers.map((layer) => ({ ...layer, crop: { ...layer.crop } })),
        cutouts: project.cutouts.map((cutout) => ({ ...cutout })),
        export: { ...project.export },
      }
      await persistProject(copy)
      setProject(copy)
      setModal(null)
      toast('Проект продублирован', 'ok')
    } catch (error) {
      toast(`Не удалось дублировать проект: ${errorText(error)}`, 'error')
    } finally {
      setBusy(null)
    }
  }, [persistProject, project, toast])

  const removeProject = useCallback(
    async (id: string) => {
      setBusy('Удаляю проект…')
      try {
        await deleteProjectRecord(id)
        const entries = await listProjects()
        setProjects(entries)
        if (id === project.id) {
          const next = createProject()
          setProject(next)
          setSelection({ layerId: null, cutoutId: null })
        }
        toast('Проект удалён', 'ok')
      } catch (error) {
        toast(`Не удалось удалить проект: ${errorText(error)}`, 'error')
      } finally {
        setBusy(null)
      }
    },
    [project.id, toast],
  )

  const renameProject = useCallback(
    (name: string) => {
      const value = name.trim()
      if (!value) return
      updateProject((current) => ({ ...current, name: value }))
    },
    [updateProject],
  )

  const importProject = useCallback(
    async (file: File) => {
      setBusy('Импортирую проект…')
      try {
        await persistProject(project).catch(() => undefined)
        const archive = await unpackProject(file)
        for (const asset of archive.assets) {
          await saveAsset(asset.meta, asset.blob)
          await assets.restore(asset.meta, asset.blob, gifProgressReporter(asset.meta.name))
        }
        const imported: Project = {
          ...archive.project,
          id: uid('p'),
          updatedAt: Date.now(),
        }
        await persistProject(imported)
        setProject(imported)
        setSelection({ layerId: null, cutoutId: null })
        setAssetsVersion((value) => value + 1)
        setModal(null)
        toast(`Импортирован проект «${imported.name}»`, 'ok')
      } catch (error) {
        toast(`Не удалось импортировать проект: ${errorText(error)}`, 'error')
      } finally {
        setBusy(null)
        setGifProgress(null)
      }
    },
    [assets, gifProgressReporter, persistProject, project, toast],
  )

  // ------------------------------------------------------------------ chrome

  const openStudio = useCallback(() => {
    const params = new URLSearchParams()
    if (page?.steamId) params.set('steamid', page.steamId)
    if (page?.persona) params.set('persona', page.persona)
    if (page?.backgroundUrl) params.set('bg', page.backgroundUrl)
    if (page?.spmDetected) params.set('spm', '1')
    const query = params.toString()
    const runtime = globalChrome()
    const base = runtime?.runtime.getURL('studio.html') ?? `${location.origin}/studio.html`
    const url = query ? `${base}?${query}` : base
    if (runtime) {
      void runtime.tabs.create({ url })
      return
    }
    window.open(url, '_blank', 'noopener')
  }, [page?.backgroundUrl, page?.persona, page?.spmDetected, page?.steamId])

  const hideUi = useCallback(() => {
    if (surface === 'overlay') {
      setPanelVisible(false)
      onHideUi?.()
      return
    }
    toast('Панель уже открыта в отдельной вкладке', 'info')
  }, [onHideUi, surface, toast])

  // The content script keeps the composition alive while the launcher can reopen the panel.
  useEffect(() => {
    if (surface !== 'overlay') return
    const show = () => setPanelVisible(true)
    const hide = () => setPanelVisible(false)
    window.addEventListener('spd:show-panel', show)
    window.addEventListener('spd:hide-panel', hide)
    return () => {
      window.removeEventListener('spd:show-panel', show)
      window.removeEventListener('spd:hide-panel', hide)
    }
  }, [surface])

  const uploadWithProfile = useCallback(() => {
    const runtime = globalChrome()
    if (runtime && page?.steamId) {
      void runtime.tabs.create({ url: `https://steamcommunity.com/profiles/${page.steamId}` })
      return
    }
    const runtime2 = globalChrome()
    if (runtime2) {
      void runtime2.tabs.create({ url: 'https://steamcommunity.com/my/' })
      return
    }
    window.open('https://steamcommunity.com/my/', '_blank', 'noopener')
  }, [page?.steamId])

  // ------------------------------------------------------------------ api

  const api: EditorApi = {
    project,
    assets,
    renderer,
    assetsVersion,
    surface,
    page,
    tab,
    setTab,
    expanded,
    setExpanded,
    busy,
    videoCapture,
    progress,
    selection,
    selectLayer,
    selectCutout,
    patchProject,
    updateProject,
    updateLayer,
    updateCutout,
    removeLayer,
    duplicateLayer,
    moveLayer,
    addLayerToWindow,
    addArtFiles,
    pickBackground,
    uploadBackground,
    useProfileBackground,
    inventory,
    loadInventory,
    makeCenterTransparent,
    addCutout,
    removeCutout,
    fitCutoutToSlot,
    centerCutout,
    toast,
    previewOn,
    setPreviewOn,
    compare,
    setCompare,
    editableOnPage,
    setEditableOnPage,
    refreshPage,
    hideUi,
    exportFiles,
    exportWarnings,
    exportFormat,
    exportNow,
    downloadFile,
    exportProjectFile,
    selfTest,
    selfTestResult,
    openUploadPage,
  }

  const gifPercent =
    gifProgress && gifProgress.total > 0
      ? Math.min(100, Math.round((gifProgress.done / gifProgress.total) * 100))
      : 0
  const mediaLabel = gifProgress?.kind === 'video' ? 'Разбираю видео' : 'Загружаю GIF'
  const gifStatus = gifProgress
    ? gifProgress.total > 0
      ? `${mediaLabel}: ${gifPercent}%`
      : `${mediaLabel}…`
    : null

  const status = gifStatus
    ? gifStatus
    : !ready
      ? 'Загружаю проект…'
      : busy
        ? busy
        : surface === 'overlay'
          ? previewOn
            ? compare
              ? 'Показан профиль без композиции'
              : 'Предпросмотр на странице · профиль не изменяется'
            : 'Предпросмотр выключен'
          : 'Автосохранение в браузере'

  const panel = (
    <>
      {surface === 'overlay' ? (
        <div className="spd-head">
          <div className="spd-brand">
            <Logo size={26} />
            <div style={{ minWidth: 0 }}>
              <div className="spd-brand-title">Steam Profile Designer</div>
              <div className="spd-brand-sub">
                {project.name}
                {page?.persona ? ` · ${page.persona}` : ''}
              </div>
            </div>
          </div>
          <div className="spd-head-actions">
            <button
              className="icon ghost"
              title={expanded ? 'Обычная ширина панели' : 'Широкая панель'}
              onClick={() => setExpanded(!expanded)}
            >
              <Icon name="grid" />
            </button>
            <button className="icon ghost" title="Проекты" onClick={openProjects}>
              <Icon name="folder" />
            </button>
            <button className="icon ghost" title="Справка" onClick={() => setModal('help')}>
              <Icon name="help" />
            </button>
            <button className="icon ghost" title="Скрыть панель" onClick={hideUi}>
              <Icon name="eyeOff" />
            </button>
          </div>
        </div>
      ) : null}

      {surface === 'overlay' ? null : (
        <div className="spd-tabs">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              className={`spd-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
              title={item.label}
            >
              <span className="num">{index + 1}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}

      {gifProgress ? (
        <div className="spd-gif-loading">
          <div className="spd-gif-loading-head">
            <span className="spd-gif-loading-name" title={gifProgress.name}>
              {gifProgress.kind === 'video' ? 'Разбираю видео' : 'Загружаю GIF'}: {gifProgress.name}
            </span>
            <span className="spd-gif-loading-count">
              {gifProgress.total > 0
                ? `${gifPercent}% · ${Math.min(gifProgress.done, gifProgress.total)} / ${gifProgress.total} кадров`
                : 'читаю…'}
            </span>
          </div>
          {gifProgress.total > 0 ? (
            <div className="spd-progress">
              <div style={{ width: `${gifPercent}%` }} />
            </div>
          ) : (
            <div className="spd-progress spd-progress-indeterminate">
              <div />
            </div>
          )}
        </div>
      ) : null}

      <div className="spd-body">
        {surface === 'overlay' ? <SimplePanel api={api} /> : null}
        {surface === 'studio' && tab === 'background' ? <BackgroundPanel api={api} /> : null}
        {surface === 'studio' && tab === 'window' ? <WindowPanel api={api} /> : null}
        {surface === 'studio' && tab === 'art' ? <ArtPanel api={api} /> : null}
        {surface === 'studio' && tab === 'preview' ? <PreviewPanel api={api} /> : null}
        {surface === 'studio' && tab === 'export' ? <ExportPanel api={api} /> : null}
      </div>

      <div className="spd-foot">
        <span className={`spd-dot ${busy || gifProgress ? 'busy' : ''}`} />
        <span className="spd-grow">{status}</span>
        {surface === 'overlay' ? (
          <button className="ghost" style={{ padding: '2px 6px' }} onClick={() => setModal('help')} title="Справка">
            <Icon name="help" size={14} />
          </button>
        ) : null}
      </div>
    </>
  )

  const modals = (
    <>
      {modal === 'projects' ? (
        <ProjectsModal
          project={project}
          projects={projects}
          storage={storage}
          onClose={() => setModal(null)}
          onOpen={(id) => void openProject(id)}
          onNew={() => void newProject()}
          onDuplicate={() => void duplicateProject()}
          onDelete={(id) => void removeProject(id)}
          onRename={renameProject}
          onImport={(file) => void importProject(file)}
          onExport={() => void exportProjectFile()}
        />
      ) : null}
      {modal === 'help' ? <HelpModal onClose={() => setModal(null)} surface={surface} /> : null}
    </>
  )

  if (surface === 'studio') {
    return (
      <div className="spd-root spd-studio-shell">
        <div className="spd-studio-top">
          <Logo size={28} />
          <div style={{ minWidth: 0 }}>
            <div className="title">Steam Profile Designer</div>
            <div className="sub">
              {project.name} · {SHOWCASES[project.target].title} · {project.export.scale}×
            </div>
          </div>
          <span className="spd-grow" />
          <button onClick={openStudio} title="Открыть новую вкладку студии">
            <Icon name="external" /> Вкладка
          </button>
          <button onClick={openProjects}>
            <Icon name="folder" /> Проекты
          </button>
          <button onClick={() => void exportNow(true)} disabled={!!busy}>
            <Icon name="download" /> ZIP
          </button>
          <button onClick={uploadWithProfile} title="Открыть профиль Steam">
            <Icon name="external" /> Профиль
          </button>
          <button className="icon" onClick={() => setModal('help')} title="Справка">
            <Icon name="help" />
          </button>
        </div>

        <div className="spd-studio-main">
          <div className="spd-studio-canvas">
            <div className="hint-row">
              <span>
                Холст 1920×{project.canvasHeight} · окно {project.cutouts.length}
              </span>
              <span>
                Экспорт: {SHOWCASES[project.target].title} · {SHOWCASES[project.target].width}×{project.showcaseHeight} px
              </span>
            </div>
            <Stage
              project={project}
              assets={assets}
              renderer={renderer}
              mode={tab === 'window' ? 'window' : 'art'}
              selectedLayerId={selection.layerId}
              selectedCutoutId={selection.cutoutId}
              onSelectLayer={selectLayer}
              onSelectCutout={selectCutout}
              onLayerChange={updateLayer}
              onCutoutChange={updateCutout}
              big
              onRequestBackground={() => setTab('background')}
              assetsVersion={assetsVersion}
            />
            <div className="hint-row">
              <span>Пунктир — границы экспорта в профиль. Перетаскивайте окна и картинки прямо здесь.</span>
              <span>Колесо мыши — масштаб выбранного слоя</span>
            </div>
          </div>
          <div className="spd-studio-side">{panel}</div>
        </div>

        <Toasts toasts={toasts} />
        {modals}
      </div>
    )
  }

  return (
    <div className="spd-root spd-overlay-root">
      <PagePreview
        project={project}
        assets={assets}
        renderer={renderer}
        page={page}
        visible={previewOn && !compare && !!page?.isProfile}
        editable={editableOnPage && !compare && panelVisible}
        assetsVersion={assetsVersion}
        selectedLayerId={selection.layerId}
        selectedCutoutId={selection.cutoutId}
        onSelectLayer={selectLayer}
        onSelectCutout={selectCutout}
        onLayerChange={updateLayer}
        onCutoutChange={updateCutout}
        onShowcaseHeightChange={(showcaseHeight) => patchProject({ showcaseHeight })}
      />
      {panelVisible ? <div className={`spd-panel ${expanded ? 'expanded' : ''}`}>{panel}</div> : null}
      <Toasts toasts={toasts} />
      {modals}
    </div>
  )
}
