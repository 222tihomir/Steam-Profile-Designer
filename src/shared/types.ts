// Domain model of a Steam Profile Designer project.
//
// All geometry is expressed in "profile pixels": the Steam profile background is
// 1920 px wide, so a rect at x=495 is exactly 495 px from the left edge of the
// background as it is rendered on a 1920 px wide profile page. Every export is a
// crop of that single coordinate space, which is what keeps the artwork aligned
// with the real page when it is uploaded back to Steam.

export type ShowcaseKind = 'featured' | 'artwork' | 'screenshot' | 'workshop'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type BlendMode =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'lighten'
  | 'darken'
  | 'color-dodge'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'luminosity'

/** A transparent window punched out of the background plate. */
export interface Cutout {
  id: string
  x: number
  y: number
  w: number
  h: number
  radius: number
  /** Soft edge in profile px. 0 = hard edge. */
  feather: number
  enabled: boolean
}

export interface LayerCrop {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Solid-colour background removal for one layer.
 *
 * `color` is the background to remove, `tolerance` is how far a pixel may be
 * from it (0–180 in RGB distance) and `feather` softens the edge so a JPEG-ish
 * background does not leave a hard staircase.
 */
export type KeyingMode = 'edges' | 'global'

export interface LayerKeying {
  enabled: boolean
  /** `#rrggbb` */
  color: string
  /** 0–180, Euclidean distance in RGB. */
  tolerance: number
  /** 0–64 px band where alpha ramps from 0 to 1. */
  feather: number
  /**
   * `edges` keeps same-coloured pixels inside the subject (flood fill from the
   * border), `global` removes every pixel of that colour.
   */
  mode: KeyingMode
}

/** One image/GIF/video placed on the profile canvas. cx/cy are its centre. */
export interface Layer {
  id: string
  assetId: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  blend: BlendMode
  cx: number
  cy: number
  /** profile px per asset px */
  scale: number
  rotation: number
  flipX: boolean
  crop: LayerCrop
  /** Optional solid-background removal; missing means "as imported". */
  keying?: LayerKeying
}

export type BackgroundSource = 'profile' | 'inventory' | 'catalog' | 'file' | 'url'

/**
 * Tiled ("repeat") Steam background: a small seamless bitmap that Steam paints
 * 1:1 over the whole page instead of stretching it over the 1920 px canvas.
 */
export interface BackgroundTile {
  /** Painted tile size in profile px (normally the bitmap's natural size). */
  width: number
  height: number
  /** Phase of the tiling grid inside the 1920 px profile canvas. */
  offsetX: number
  offsetY: number
  /** `background-repeat` axes; Steam's tiled backgrounds repeat on both. */
  repeatX: boolean
  repeatY: boolean
}

export interface Background {
  /** Remote URL, or empty when assetId is used. */
  url: string
  /** Local file kept in IndexedDB. */
  assetId?: string
  /** Source URL of an SPM <video> background, when the page uses one. */
  videoUrl?: string
  /** In-memory GIF captured from that video; re-captured on every page load. */
  videoAssetId?: string
  name: string
  source: BackgroundSource
  width: number
  height: number
  /** Present when Steam repeats the bitmap as a seamless tile. */
  tile?: BackgroundTile
}

export type ExportFormat = 'png' | 'gif'

export interface ExportSettings {
  /** 1 or 2. Output pixels per profile pixel. */
  scale: number
  format: ExportFormat
  gifColors: number
  gifDither: boolean
  /**
   * GIF frame rate in frames per second. `0` keeps the background/source
   * animation timing; a positive value resamples the timeline evenly at that
   * rate so the exported GIF stays in sync with an animated background.
   */
  gifFps: number
  /**
   * Frames to put into the GIF. `0` keeps every captured frame (up to the
   * safety cap); a positive value resamples the loop evenly to that many frames,
   * so even very short animations can be made smaller. The source frame count is
   * the upper bound.
   */
  gifFrames: number
  /**
   * Write only changed pixels as transparent delta frames on top of the base
   * frame. Off means every frame is written in full, which is safer after
   * Steam re-encodes the GIF but produces a larger file.
   */
  gifDelta: boolean
  /**
   * Lower the colour budget automatically when the GIF exceeds maxBytes. Off
   * keeps the chosen palette and reports an oversized file instead.
   */
  gifReducePalette: boolean
  /**
   * How much of the SPM video background is sampled into GIF frames.
   * `slot` samples only the showcase area at 1:1; a number caps the long side of
   * the full frame (480, 720, 960, 1080, 1440, 1920 px).
   */
  gifBackground: 'slot' | number
  /** Steam rejects files above 5 MB; stay a little below. */
  maxBytes: number
  /** Also save the plate (background with the transparent window) on its own. */
  savePlate: boolean
}

export interface ProjectSlot {
  /** Left edge of the showcase image area on the 1920 px profile canvas. */
  x: number
  /** Top edge of the showcase image area on the 1920 px profile canvas. */
  y: number
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  background: Background | null
  /** Height of the profile canvas in profile px. */
  canvasHeight: number
  cutouts: Cutout[]
  layers: Layer[]
  target: ShowcaseKind
  /**
   * @deprecated Measured showcase origins are supplied per render/export and
   * never stored in the project. Older saved projects may still contain this
   * field; it is ignored.
   */
  slot?: ProjectSlot
  /** Height of the exported showcase image in profile px. */
  showcaseHeight: number
  /** Background replacement while previewing on the page. */
  previewBackground: boolean
  export: ExportSettings
  version: 1
}

/** Metadata for a stored image; the bytes live in IndexedDB. */
export interface AssetMeta {
  id: string
  name: string
  /** `video` keeps the clip bytes; frames are re-sampled when the project opens. */
  kind: 'image' | 'gif' | 'video'
  width: number
  height: number
  bytes: number
  frames: number
  /** Total animation duration in ms (0 for stills). */
  duration: number
  role: 'art' | 'background'
  createdAt: number
}

export interface ProjectIndexEntry {
  id: string
  name: string
  updatedAt: number
  target: ShowcaseKind
  /** Small JPEG data URL for the project list. */
  thumbnail?: string
}

export interface BackgroundOption {
  id: string
  name: string
  url: string
  appName?: string
  source: BackgroundSource
}

export const DEFAULT_EXPORT: ExportSettings = {
  scale: 2,
  format: 'png',
  gifColors: 256,
  gifDither: false,
  gifFps: 0,
  gifFrames: 0,
  gifDelta: false,
  gifReducePalette: false,
  gifBackground: 960,
  maxBytes: 4_950_000,
  savePlate: false,
}
