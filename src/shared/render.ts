import type { BackgroundTile, Layer, Project, Rect } from './types'
import type { AssetLibrary } from './assets'
import type { GifAsset } from './gif-decode'

// ---------------------------------------------------------------------------
// Composition renderer.
//
// One renderer owns the "plate": the Steam background with the transparent
// windows punched out. The plate, the cut-out mask and all layers are rendered in
// profile coordinates (1920 px wide) at an arbitrary resolution, so an export at
// 2x is a real 2x render of the sources, not an upscaled screenshot.
// ---------------------------------------------------------------------------

export const PLATE_WIDTH = 1920

export function roundRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  const rr = typeof ctx.roundRect === 'function'
  if (rr) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    return
  }
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D недоступен в этом браузере')
  return ctx
}

interface MaskEntry {
  canvas: HTMLCanvasElement
  key: string
}

export class CompositionRenderer {
  private project: Project
  private assets: AssetLibrary
  private masks = new Map<number, MaskEntry>()

  constructor(project: Project, assets: AssetLibrary) {
    this.project = project
    this.assets = assets
  }

  update(project: Project, assets: AssetLibrary) {
    if (project !== this.project) {
      this.project = project
      this.masks.clear()
    }
    this.assets = assets
  }

  /** Signature of everything that changes the transparent-window mask. */
  private maskKey(): string {
    const { canvasHeight, cutouts } = this.project
    return `${canvasHeight}|${JSON.stringify(cutouts)}`
  }

  private backgroundBitmapAt(timeMs: number): ImageBitmap | null {
    const bg = this.project.background
    if (!bg) return null
    // A video background captured from SPM wins over the still poster: its GIF
    // frames are what the page actually shows. The poster stays as a fallback
    // when the capture failed (cross-origin video, unsupported codec).
    if (bg.videoAssetId) {
      const animated = this.assets.bitmapAt(bg.videoAssetId, timeMs)
      if (animated) return animated
    }
    if (!bg.assetId) return null
    // bitmapAt picks the GIF frame for this moment, so an animated background
    // plays in the preview and in the exported GIF timeline.
    return this.assets.bitmapAt(bg.assetId, timeMs)
  }

  private getCutoutMask(scale: number): HTMLCanvasElement | null {
    const project = this.project
    const active = project.cutouts.filter((c) => c.enabled && c.w > 0 && c.h > 0)
    if (!active.length) return null
    const key = this.maskKey()
    const cached = this.masks.get(scale)
    if (cached && cached.key === key) return cached.canvas
    const mask = createCanvas(PLATE_WIDTH * scale, project.canvasHeight * scale)
    const mctx = context2d(mask)
    mctx.scale(scale, scale)
    mctx.fillStyle = '#fff'
    for (const cutout of active) {
      mctx.save()
      mctx.filter = cutout.feather > 0 ? `blur(${Math.max(0.5, cutout.feather / 2)}px)` : 'none'
      roundRectPath(mctx, cutout.x, cutout.y, cutout.w, cutout.h, cutout.radius)
      mctx.fill()
      mctx.restore()
    }
    this.masks.set(scale, { canvas: mask, key })
    if (this.masks.size > 3) {
      const first = this.masks.keys().next().value
      if (first !== undefined && first !== scale) this.masks.delete(first)
    }
    return mask
  }

  /** Background plate for one moment: background frame + transparent windows. */
  private drawPlate(ctx: CanvasRenderingContext2D, timeMs: number, scale: number) {
    const project = this.project
    const bg = project.background
    const video = bg?.videoAssetId ? this.assets.get(bg.videoAssetId)?.gif : null
    // Frames cropped to the showcase cover only that rect, so the rest of the
    // plate keeps the still poster instead of turning transparent.
    const animated = bg?.videoAssetId ? this.assets.bitmapAt(bg.videoAssetId, timeMs) : null
    const region = animated ? video?.region : undefined
    if (region && bg?.assetId) {
      const poster = this.assets.bitmapAt(bg.assetId, 0)
      if (poster) {
        const posterHeight = (PLATE_WIDTH * poster.height) / poster.width
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(poster, 0, 0, PLATE_WIDTH, posterHeight)
      }
    }
    const bitmap = animated ?? this.backgroundBitmapAt(timeMs)
    if (bitmap) {
      ctx.imageSmoothingQuality = 'high'
      if (region) {
        ctx.drawImage(bitmap, region.x, region.y, region.w, region.h)
      } else if (bg?.tile) {
        this.drawTiledPlate(ctx, bitmap, bg.tile, project.canvasHeight)
      } else {
        const drawHeight = (PLATE_WIDTH * bitmap.height) / bitmap.width
        ctx.drawImage(bitmap, 0, 0, PLATE_WIDTH, drawHeight)
      }
    }
    const mask = this.getCutoutMask(scale)
    if (mask) {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.drawImage(mask, 0, 0, PLATE_WIDTH, project.canvasHeight)
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  /**
   * Paint a repeating background the way the Steam page does: one small seamless
   * bitmap at 1:1 over the whole plate, shifted so its grid starts where Steam's
   * centred `background-position` puts it. The page also has a black base.
   */
  private drawTiledPlate(
    ctx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    tile: BackgroundTile,
    height: number,
  ) {
    ctx.save()
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, PLATE_WIDTH, height)
    const mode = tile.repeatX
      ? tile.repeatY
        ? 'repeat'
        : 'repeat-x'
      : tile.repeatY
        ? 'repeat-y'
        : 'no-repeat'
    const pattern = ctx.createPattern(bitmap, mode)
    if (!pattern) {
      ctx.restore()
      return
    }
    // `background-size` can paint a tile larger or smaller than the bitmap.
    const scaleX = bitmap.width > 0 && tile.width > 0 ? tile.width / bitmap.width : 1
    const scaleY = bitmap.height > 0 && tile.height > 0 ? tile.height / bitmap.height : 1
    ctx.translate(tile.offsetX, tile.offsetY)
    ctx.scale(scaleX, scaleY)
    ctx.fillStyle = pattern
    // Fill past the plate on every side so the phase shift never leaves a gap.
    ctx.fillRect(
      -tile.offsetX / scaleX,
      -tile.offsetY / scaleY,
      PLATE_WIDTH / scaleX + tile.width,
      height / scaleY + tile.height,
    )
    ctx.restore()
  }

  /**
   * Draw one layer in profile coordinates.
   *
   * `ctx` is already scaled by the output scale, so positions and sizes must be
   * given in profile px. Multiplying by the scale here too made layers four
   * times too large and twice as far from the origin in 2x exports, which pushed
   * them outside the exported slice entirely (the preview at 1x still looked
   * fine, so the bug only showed up in the exported PNG/GIF).
   */
  private drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, timeMs: number) {
    if (!layer.visible || layer.opacity <= 0) return
    const record = this.assets.get(layer.assetId)
    if (!record) return
    const bitmap = this.assets.bitmapAt(layer.assetId, timeMs, layer.keying)
    if (!bitmap) return

    const crop = layer.crop
    const sx = bitmap.width * crop.x
    const sy = bitmap.height * crop.y
    const sw = Math.max(1, bitmap.width * crop.w)
    const sh = Math.max(1, bitmap.height * crop.h)

    const s = layer.scale
    ctx.save()
    ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity))
    ctx.globalCompositeOperation = layer.blend
    ctx.translate(layer.cx, layer.cy)
    if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180)
    if (layer.flipX) ctx.scale(-1, 1)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, sx, sy, sw, sh, (-sw * s) / 2, (-sh * s) / 2, sw * s, sh * s)
    ctx.restore()
  }

  /**
   * Draw a rectangle of the profile canvas into `ctx`, scaled by `scale`
   * (output px per profile px). The destination canvas must be
   * `view.w * scale` by `view.h * scale`.
   */
  draw(ctx: CanvasRenderingContext2D, view: Rect, timeMs: number, scale: number, includeLayers = true) {
    const project = this.project
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.scale(scale, scale)
    ctx.translate(-view.x, -view.y)
    this.drawPlate(ctx, timeMs, scale)
    if (includeLayers) {
      for (const layer of project.layers) this.drawLayer(ctx, layer, timeMs)
    }
    ctx.restore()
  }

  /** Offscreen render of a rect, ready to be encoded or blitted. */
  renderView(view: Rect, scale: number, timeMs: number, includeLayers = true): HTMLCanvasElement {
    const canvas = createCanvas(view.w * scale, view.h * scale)
    const ctx = context2d(canvas)
    this.draw(ctx, view, timeMs, scale, includeLayers)
    return canvas
  }

  renderFull(scale: number, timeMs: number, includeLayers = true): HTMLCanvasElement {
    return this.renderView({ x: 0, y: 0, w: PLATE_WIDTH, h: this.project.canvasHeight }, scale, timeMs, includeLayers)
  }

  /** True when the background image is decoded and can be drawn. */
  get ready(): boolean {
    if (!this.project.background) return true
    return this.backgroundBitmapAt(0) !== null
  }
}

/** The animation that drives the exported timeline, background first. */
export function backgroundAnimation(project: Project, assets: AssetLibrary): GifAsset | null {
  const background = project.background
  if (!background) return null
  if (background.videoAssetId) {
    const captured = assets.get(background.videoAssetId)?.gif
    if (captured && captured.frames.length > 1) return captured
  }
  if (background.assetId) {
    const record = assets.get(background.assetId)?.gif
    if (record && record.frames.length > 1) return record
  }
  return null
}

/** True when anything in the scene changes over time. */
export function hasAnimatedLayers(project: Project, assets: AssetLibrary): boolean {
  if (backgroundAnimation(project, assets)) return true
  return project.layers.some((layer) => {
    const record = assets.get(layer.assetId)
    return !!record?.gif && record.gif.frames.length > 1
  })
}

/** Longest animation duration among visible layers and the background. */
export function animationDuration(project: Project, assets: AssetLibrary): number {
  let duration = backgroundAnimation(project, assets)?.duration ?? 0
  for (const layer of project.layers) {
    if (!layer.visible) continue
    const record = assets.get(layer.assetId)
    if (record?.gif) duration = Math.max(duration, record.gif.duration)
  }
  return duration
}

/** True when SPM draws the profile background with a <video>. */
export function hasVideoBackground(project: Project): boolean {
  return !!project.background?.videoUrl
}
