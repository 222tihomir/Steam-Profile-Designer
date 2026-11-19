import type { AssetLibrary } from '../shared/assets'
import type { CompositionRenderer } from '../shared/render'
import type { BackgroundOption, BackgroundSource, Cutout, Layer, Project } from '../shared/types'
import type { ExportedFile, ExportProgress } from '../shared/export'
import type { PageState } from '../shared/steam/page'

export type PanelTab = 'background' | 'window' | 'art' | 'preview' | 'export'

export interface InventoryState {
  items: BackgroundOption[]
  loading: boolean
  error: string | null
  loaded: boolean
}

export interface SelfTestResult {
  ok: boolean
  lines: string[]
}

export interface EditorApi {
  project: Project
  assets: AssetLibrary
  renderer: CompositionRenderer
  assetsVersion: number
  surface: 'overlay' | 'studio'
  page: PageState | null
  tab: PanelTab
  setTab: (tab: PanelTab) => void
  expanded: boolean
  setExpanded: (value: boolean) => void
  busy: string | null
  /** How the SPM video background is doing: reading, ready or blocked by CORS. */
  videoCapture: 'idle' | 'reading' | 'ready' | 'failed'
  progress: ExportProgress | null
  selection: { layerId: string | null; cutoutId: string | null }
  selectLayer: (id: string | null) => void
  selectCutout: (id: string | null) => void
  patchProject: (patch: Partial<Project>) => void
  updateProject: (updater: (project: Project) => Project) => void
  updateLayer: (layer: Layer) => void
  updateCutout: (cutout: Cutout) => void
  removeLayer: (id: string) => void
  duplicateLayer: (id: string) => void
  moveLayer: (id: string, direction: -1 | 1) => void
  addLayerToWindow: (layerId?: string) => void
  addArtFiles: (files: FileList | File[]) => Promise<void>
  pickBackground: (url: string, name: string, source: BackgroundSource) => Promise<void>
  uploadBackground: (file: File) => Promise<void>
  useProfileBackground: () => Promise<void>
  inventory: InventoryState
  loadInventory: () => Promise<void>
  makeCenterTransparent: () => void
  addCutout: () => void
  removeCutout: (id: string) => void
  fitCutoutToSlot: (id: string) => void
  centerCutout: (id: string) => void
  toast: (text: string, kind?: 'info' | 'ok' | 'error') => void
  previewOn: boolean
  setPreviewOn: (value: boolean) => void
  compare: boolean
  setCompare: (value: boolean) => void
  editableOnPage: boolean
  setEditableOnPage: (value: boolean) => void
  refreshPage: () => void
  hideUi: () => void
  exportFiles: ExportedFile[] | null
  exportWarnings: string[]
  exportFormat: 'png' | 'gif'
  exportNow: (zip: boolean) => Promise<void>
  downloadFile: (file: ExportedFile) => void
  exportProjectFile: () => Promise<void>
  selfTest: () => Promise<void>
  selfTestResult: SelfTestResult | null
  openUploadPage: () => void
}
