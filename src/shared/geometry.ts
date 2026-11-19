import type { Project, ProjectSlot, Rect, ShowcaseKind } from './types'

// ---------------------------------------------------------------------------
// Steam profile geometry.
//
// The numbers below were measured on live Steam profiles by the MIT-licensed
// project https://github.com/sweety1lime/profile-editor (packages/core/src/layout.ts
// and geometry.ts) and are reused here with attribution. If Steam changes the
// profile layout, these are the constants to re-measure.
// ---------------------------------------------------------------------------

export const PROFILE_BACKGROUND_WIDTH = 1920

export const PROFILE_LAYOUT = {
  navHeight: 104,
  contentWidth: 976,
  headerHeight: 202,
  headerGap: 22,
  columnsPadding: 12,
  columnsPaddingTop: 16,
  leftWidth: 652,
  rightWidth: 288,
  columnsGap: 12,
  showcaseGap: 12,
  showcaseHeader: 40,
} as const

/** Left edge of the left column on the 1920 px profile canvas. */
export const PROFILE_COLUMN_X =
  (PROFILE_BACKGROUND_WIDTH - PROFILE_LAYOUT.contentWidth) / 2 + PROFILE_LAYOUT.columnsPadding

/** Top of the first showcase image on the profile canvas. */
export const PROFILE_FIRST_SHOWCASE_Y =
  PROFILE_LAYOUT.headerHeight + PROFILE_LAYOUT.headerGap + PROFILE_LAYOUT.columnsPaddingTop

export interface ShowcaseSlice {
  id: string
  x: number
  width: number
}

export interface ShowcaseDef {
  kind: ShowcaseKind
  title: string
  /** Total width of the showcase in profile px, including gaps between parts. */
  width: number
  slices: ShowcaseSlice[]
  /** Where the first image starts inside the showcase block. */
  inner: { x: number; y: number }
  /** Nine-slice-style counter under the image (Steam shows "+N"). */
  hasCounter: boolean
  /** What Steam calls this showcase in the upload flow. */
  uploadName: string
  /** Suggested upload page field `file_type`. */
  fileType?: string
}

const TWO_COLUMNS: ShowcaseSlice[] = [
  { id: 'main', x: 0, width: 506 },
  { id: 'side', x: 515, width: 100 },
]

const WORKSHOP_COLUMN = 126.4
const WORKSHOP_MARGIN = 2
const round1 = (n: number) => Math.round(n * 10) / 10

export const SHOWCASES: Record<ShowcaseKind, ShowcaseDef> = {
  featured: {
    kind: 'featured',
    title: 'Избранная иллюстрация',
    width: 630,
    slices: [{ id: 'main', x: 0, width: 630 }],
    inner: { x: 11, y: 16 },
    hasCounter: false,
    uploadName: 'Featured Artwork Showcase',
  },
  artwork: {
    kind: 'artwork',
    title: 'Витрина иллюстраций',
    width: 615,
    slices: TWO_COLUMNS,
    inner: { x: 11, y: 16 },
    hasCounter: true,
    uploadName: 'Artwork Showcase',
  },
  screenshot: {
    kind: 'screenshot',
    title: 'Витрина скриншотов',
    width: 615,
    slices: TWO_COLUMNS,
    inner: { x: 11, y: 61 },
    hasCounter: true,
    uploadName: 'Screenshot Showcase',
    fileType: '5',
  },
  workshop: {
    kind: 'workshop',
    title: 'Витрина мастерской',
    width: round1(WORKSHOP_COLUMN * 5 - WORKSHOP_MARGIN * 2),
    slices: Array.from({ length: 5 }, (_, i) => ({
      id: String(i + 1),
      x: round1(WORKSHOP_COLUMN * i),
      width: round1(WORKSHOP_COLUMN - WORKSHOP_MARGIN * 2),
    })),
    inner: { x: 12, y: 140 },
    hasCounter: false,
    uploadName: 'Workshop Showcase',
    fileType: '0',
  },
}

/** Showcases in the order they are offered in the UI. */
export const SHOWCASE_ORDER: ShowcaseKind[] = ['featured', 'artwork', 'workshop', 'screenshot']

export const DEFAULT_CANVAS_HEIGHT = 1080
export const MIN_SHOWCASE_HEIGHT = 80
export const MAX_SHOWCASE_HEIGHT = 2000
export const MIN_CANVAS_HEIGHT = 600
export const MAX_CANVAS_HEIGHT = 4000

export const clampShowcaseHeight = (h: number) =>
  Math.round(Math.min(MAX_SHOWCASE_HEIGHT, Math.max(MIN_SHOWCASE_HEIGHT, h)))

export const clampCanvasHeight = (h: number) =>
  Math.round(Math.min(MAX_CANVAS_HEIGHT, Math.max(MIN_CANVAS_HEIGHT, h)))

/** Rect of the first showcase of a kind, in profile px. */
export function defaultSlotRect(kind: ShowcaseKind, height: number): Rect {
  const showcase = SHOWCASES[kind]
  return {
    x: PROFILE_COLUMN_X + showcase.inner.x,
    y: PROFILE_FIRST_SHOWCASE_Y + showcase.inner.y,
    w: showcase.width,
    h: clampShowcaseHeight(height),
  }
}

/**
 * Rect of the target showcase. `slot` is an optional measured origin from the
 * live page and stays a per-call override: it is never written back into the
 * project. Keeping the project free of measured coordinates is what makes the
 * featured/artwork/screenshot placement stable — the old auto-sync rewrote the
 * project on every page update and dragged layers around with it.
 */
export function projectSlotRect(project: Project, slot?: ProjectSlot): Rect {
  const base = defaultSlotRect(project.target, project.showcaseHeight)
  return { ...base, x: slot?.x ?? base.x, y: slot?.y ?? base.y }
}

/** Same rect without a project, for UI that only knows the target. */
export function slotRectFor(kind: ShowcaseKind, height: number, slot?: ProjectSlot): Rect {
  const base = defaultSlotRect(kind, height)
  return { ...base, x: slot?.x ?? base.x, y: slot?.y ?? base.y }
}

export interface SlicePlan {
  id: string
  fileName: string
  /** Part rect in profile px. */
  rect: Rect
  /** Output width for this part. */
  outWidth: number
  outHeight: number
}

/**
 * File name rule shared with the upload helper: the first token tells the
 * helper which showcase the file belongs to.
 */
export function sliceFileName(kind: ShowcaseKind, index: number): string {
  const { slices } = SHOWCASES[kind]
  if (slices.length === 1) return kind
  if (kind === 'workshop') return `workshop_${index + 1}`
  return `${kind}_${index + 1}_${slices[index]?.id ?? index + 1}`
}

/** How the slot is split into files, and at what pixel size each part is exported. */
export function planSlices(project: Project, measuredSlot?: ProjectSlot): SlicePlan[] {
  const showcase = SHOWCASES[project.target]
  const slot = projectSlotRect(project, measuredSlot)
  const scale = project.export.scale
  return showcase.slices.map((slice, index) => {
    const outWidth = Math.max(1, Math.round(slice.width * scale))
    return {
      id: slice.id,
      fileName: sliceFileName(project.target, index),
      rect: { x: slot.x + slice.x, y: slot.y, w: slice.width, h: slot.h },
      outWidth,
      outHeight: Math.max(1, Math.round(slot.h * scale)),
    }
  })
}

/** Aspect ratio of one exported part (width / height). */
export const partAspect = (project: Project) =>
  defaultSlotRect(project.target, project.showcaseHeight).w / project.showcaseHeight

/** Does a rect stay inside the exported slot? Used to warn about clipped art. */
export function isInsideSlot(project: Project, rect: Rect, measuredSlot?: ProjectSlot): boolean {
  const slot = projectSlotRect(project, measuredSlot)
  return (
    rect.x >= slot.x - 0.5 &&
    rect.y >= slot.y - 0.5 &&
    rect.x + rect.w <= slot.x + slot.w + 0.5 &&
    rect.y + rect.h <= slot.y + slot.h + 0.5
  )
}

export const slotRect = defaultSlotRect

/** Human readable size for UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
