import type { BackgroundTile, ShowcaseKind } from '../types'
import {
  PROFILE_BACKGROUND_WIDTH,
  PROFILE_COLUMN_X,
  PROFILE_FIRST_SHOWCASE_Y,
  SHOWCASES,
} from '../geometry'

// ---------------------------------------------------------------------------
// Reading the live Steam profile page.
//
// Everything here is read-only except `applyBackground`, which swaps the CSS
// image of the profile background element and can restore it exactly. We never
// rewrite Steam's DOM structure, so other extensions (Steam Profile Modifier
// included) keep working; if one of them changes the background while our
// preview is on, we simply stop owning the style and leave it alone.
// ---------------------------------------------------------------------------

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface ShowcaseAnchor {
  kind: ShowcaseKind | 'other'
  title: string
  rect: RectLike
  /** Top-left of the showcase image area on the 1920 px profile canvas. */
  origin?: { x: number; y: number }
}

/** Where the background image is actually painted, in viewport pixels. */
export interface BackgroundFrame {
  /** Viewport px per profile px, horizontal. */
  scaleX: number
  /** Viewport px per profile px, vertical. */
  scaleY: number
  /** Viewport position of the image's top-left corner. */
  left: number
  top: number
}

export interface PageState {
  isProfile: boolean
  rootRect: RectLike | null
  /** Viewport px per profile px (1920 px wide canvas). */
  scale: number
  /** Real painted rect of the background image, when it can be read. */
  backgroundFrame: BackgroundFrame | null
  /** Repeat grid when Steam uses a tiled background, `null` otherwise. */
  backgroundTile: BackgroundTile | null
  backgroundUrl: string | null
  backgroundElement: HTMLElement | null
  anchors: ShowcaseAnchor[]
  leftColumn: RectLike | null
  persona: string | null
  steamId: string | null
  spmDetected: boolean
  backgroundSize: string
  /** Steam Profile Modifier draws animated backgrounds with a <video>. */
  backgroundIsVideo: boolean
  /** That element, so its real frames can be sampled into GIF frames. */
  backgroundVideo: HTMLVideoElement | null
}

export interface PageReadOptions {
  /** Natural size of the profile background bitmap, when the editor knows it. */
  backgroundSize?: { width: number; height: number } | null
}

const BACKGROUND_SELECTORS = [
  '.profile_page.has_profile_background',
  '.profile_page',
  '#responsive_page_template_content > .has_profile_background',
  '#responsive_page_template_content .has_profile_background',
  '#profile_background',
  '.profile_background_image_content',
]

export function toRectLike(rect: DOMRect | null | undefined): RectLike | null {
  if (!rect) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export function parseCssUrl(value: string | null | undefined): string | null {
  if (!value || value === 'none') return null
  const match = /url\((['"]?)(.*?)\1\)/.exec(value)
  return match?.[2]?.trim() || null
}

function readBackgroundElement(): {
  element: HTMLElement | null
  url: string | null
  video: HTMLVideoElement | null
} {
  const profilePage = document.querySelector<HTMLElement>('.profile_page')

  // SPM's animated backgrounds are <video> elements and are the visible layer.
  // The poster is a normal image URL used as a fallback; the element itself is
  // kept so the editor can sample its frames and export a real GIF.
  const animated = document.querySelector<HTMLVideoElement>('.profile_animated_background video')
  if (animated) {
    const poster = animated.poster || null
    return { element: profilePage ?? animated.parentElement, url: poster, video: animated }
  }

  // Steam Profile Modifier draws its preview with an inline backgroundImage on
  // .profile_page. Prefer that over the stock background node underneath it,
  // because the inline style is the background the user actually sees.
  const spmUrl = parseCssUrl(profilePage?.style.backgroundImage)
  if (profilePage && spmUrl) return { element: profilePage, url: spmUrl, video: null }

  for (const selector of BACKGROUND_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) continue
    const url = parseCssUrl(getComputedStyle(element).backgroundImage) ?? parseCssUrl(element.style.backgroundImage)
    if (url) return { element, url, video: null }
  }
  for (const selector of BACKGROUND_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element) {
      const url = parseCssUrl(getComputedStyle(element).backgroundImage)
      return { element, url, video: null }
    }
  }
  const bodyUrl = parseCssUrl(getComputedStyle(document.body).backgroundImage)
  return { element: document.body, url: bodyUrl, video: null }
}

function headerText(block: Element): string {
  const header = block.querySelector('.profile_customization_header, .profile_recentgame_header')
  return (header?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function classify(block: Element): ShowcaseKind | 'other' {
  // Steam's workshop showcase is the only block with this holder. Its header is
  // localized, so the class is the reliable signal.
  if (block.querySelector('.myworkshop_showcase')) return 'workshop'
  const text = headerText(block).toLowerCase()
  if (/workshop|мастерск/.test(text)) return 'workshop'
  if (/screenshot|скриншот/.test(text)) return 'screenshot'
  if (/featured|избранн/.test(text)) return 'featured'
  if (/artwork|illustration|иллюстрац|арт/.test(text)) return 'artwork'
  if (block.querySelector('.screenshot_showcase_primary img')) return 'artwork'
  if (block.querySelector('.showcase_content img')) return 'artwork'
  return 'other'
}

function showcaseImage(block: Element, kind: ShowcaseKind | 'other'): Element | null {
  if (kind === 'workshop') {
    // The image area starts at the first workshop item, not at the whole block:
    // the block also has the author row above it.
    return (
      block.querySelector('.workshop_showcase_multiitem img') ??
      block.querySelector('.workshop_showcase_multiitem') ??
      block.querySelector('.myworkshop_showcase') ??
      block
    )
  }
  // Real Steam wraps featured/artwork/screenshot images in
  // .screenshot_showcase_primary; older layouts used .showcase_content.
  return (
    block.querySelector('.screenshot_showcase_primary img') ??
    block.querySelector('.showcase_content img') ??
    block.querySelector('.screenshot_showcase_primary') ??
    block.querySelector('.showcase_content') ??
    block.querySelector('.profile_customization_block') ??
    null
  )
}

export function readAnchors(): ShowcaseAnchor[] {
  const blocks = [...document.querySelectorAll('.profile_leftcol .profile_customization')].filter(
    (block) => !block.parentElement?.closest('.profile_customization'),
  )
  const anchors: ShowcaseAnchor[] = []
  for (const block of blocks) {
    const kind = classify(block)
    const target = showcaseImage(block, kind)
    const rect = toRectLike(target?.getBoundingClientRect())
    if (!rect || rect.width < 10 || rect.height < 10) continue
    anchors.push({ kind, title: headerText(block), rect })
  }
  return anchors
}

export function readPersona(): string | null {
  return document.querySelector('.actual_persona_name')?.textContent?.trim() ?? null
}

export function readSteamId(): string | null {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel=canonical]')?.href
  const fromCanonical = canonical && /\/profiles\/(\d{17})/.exec(canonical)?.[1]
  if (fromCanonical) return fromCanonical
  const fromLocation = /\/profiles\/(\d{17})/.exec(location.pathname)?.[1]
  if (fromLocation) return fromLocation
  return null
}

type FrameSource = Pick<PageState, 'backgroundFrame' | 'rootRect' | 'scale'>

/** Steam profile backgrounds are 1920×1080; `background-size: auto` keeps that. */
const ASSUMED_BACKGROUND = { width: PROFILE_BACKGROUND_WIDTH, height: 1080 }

function cssLength(token: string | undefined, base: number): number | null {
  const value = (token ?? '').trim().toLowerCase()
  if (!value || value === 'auto') return null
  if (value.endsWith('%')) {
    const percent = Number.parseFloat(value)
    return Number.isFinite(percent) ? (percent / 100) * base : null
  }
  const pixels = Number.parseFloat(value)
  return Number.isFinite(pixels) ? pixels : null
}

/** Size of one background tile, in viewport px. */
function paintedBackgroundSize(
  css: string,
  area: { width: number; height: number },
  natural: { width: number; height: number },
): { width: number; height: number } {
  const value = (css || 'auto').trim().toLowerCase()
  if (value === 'cover' || value === 'contain') {
    const fitX = area.width / natural.width
    const fitY = area.height / natural.height
    const fit = value === 'cover' ? Math.max(fitX, fitY) : Math.min(fitX, fitY)
    return { width: natural.width * fit, height: natural.height * fit }
  }
  const tokens = value.split(/\s+/).filter(Boolean)
  let width = cssLength(tokens[0], area.width)
  let height = cssLength(tokens[1], area.height)
  if (width === null && height === null) return { ...natural }
  const ratio = natural.height / natural.width
  if (width === null) width = (height ?? natural.height) / ratio
  if (height === null) height = width * ratio
  return { width, height }
}

function positionValue(token: string, area: number, size: number): number {
  const value = token.trim().toLowerCase()
  if (value === 'left' || value === 'top') return 0
  if (value === 'right' || value === 'bottom') return area - size
  if (value === 'center') return (area - size) / 2
  if (value.endsWith('%')) {
    const percent = Number.parseFloat(value)
    return Number.isFinite(percent) ? ((area - size) * percent) / 100 : (area - size) / 2
  }
  const pixels = Number.parseFloat(value)
  return Number.isFinite(pixels) ? pixels : (area - size) / 2
}

function edgeValue(edge: string, offset: string | undefined, area: number, size: number): number {
  const pixels = Number.parseFloat(offset ?? '') || 0
  return edge === 'right' || edge === 'bottom' ? area - size - pixels : pixels
}

/** Offset of the first background tile from the element's (or viewport's) top-left. */
function backgroundOffset(
  css: string,
  area: { width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const tokens = (css || '0% 0%').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) {
    return { x: (area.width - size.width) / 2, y: (area.height - size.height) / 2 }
  }
  if (tokens.length === 1) {
    const only = tokens[0]!
    if (only === 'top' || only === 'bottom') {
      return { x: (area.width - size.width) / 2, y: positionValue(only, area.height, size.height) }
    }
    return { x: positionValue(only, area.width, size.width), y: (area.height - size.height) / 2 }
  }
  if (tokens.length >= 4) {
    return {
      x: edgeValue(tokens[0]!, tokens[1], area.width, size.width),
      y: edgeValue(tokens[2]!, tokens[3], area.height, size.height),
    }
  }
  if (tokens.length === 3) {
    // `right 10px center` — an edge keyword with its offset plus the other axis.
    if (tokens[0] === 'left' || tokens[0] === 'right') {
      return {
        x: edgeValue(tokens[0], tokens[1], area.width, size.width),
        y: positionValue(tokens[2]!, area.height, size.height),
      }
    }
    if (tokens[0] === 'top' || tokens[0] === 'bottom') {
      return {
        x: positionValue(tokens[2]!, area.width, size.width),
        y: edgeValue(tokens[0], tokens[1], area.height, size.height),
      }
    }
  }
  const [first, second] = tokens
  // `top center` is valid: the keyword order does not have to be x then y.
  const verticalFirst = first === 'top' || first === 'bottom'
  const xToken = verticalFirst ? second! : first!
  const yToken = verticalFirst ? first! : second!
  return {
    x: positionValue(xToken, area.width, size.width),
    y: positionValue(yToken, area.height, size.height),
  }
}

function frameFromPainted(
  painted: { width: number; height: number },
  natural: { width: number; height: number },
  left: number,
  top: number,
): BackgroundFrame {
  // The export plate is always 1920 px wide and keeps the bitmap's aspect ratio,
  // so viewport → plate mapping uses those dimensions, not the showcase's.
  const plateHeight = (PROFILE_BACKGROUND_WIDTH * natural.height) / natural.width
  return {
    scaleX: painted.width / PROFILE_BACKGROUND_WIDTH,
    scaleY: painted.height / plateHeight,
    left,
    top,
  }
}

/** `background-repeat` split into axes; `space`/`round` still repeat. */
function repeatAxes(css: string): { x: boolean; y: boolean } {
  const value = (css || 'repeat').trim().toLowerCase()
  if (value === 'repeat-x') return { x: true, y: false }
  if (value === 'repeat-y') return { x: false, y: true }
  if (value === 'no-repeat') return { x: false, y: false }
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length >= 2) {
    return { x: tokens[0] !== 'no-repeat', y: tokens[1] !== 'no-repeat' }
  }
  return { x: value !== 'no-repeat', y: value !== 'no-repeat' }
}

/** Positive phase of the first tile inside the profile canvas, in whole px. */
function tilePhase(origin: number, canvasOrigin: number, size: number): number {
  const period = Math.max(1, Math.round(size))
  return ((Math.round(origin - canvasOrigin) % period) + period) % period
}

export interface BackgroundPlacement {
  frame: BackgroundFrame
  /** Repeat grid, when the bitmap is painted as a tile rather than a cover. */
  tile: BackgroundTile | null
}

/**
 * Where the visible background bitmap is actually painted.
 *
 * `background-size: auto` keeps Steam's 1920×1080 image at natural size, so the
 * profile canvas is 1:1 with CSS px even when the window is much wider and the
 * image is centered with a negative left offset. Using `.profile_page` width as
 * the scale made the preview frame ~1.4× too large on wide windows.
 *
 * Tiled backgrounds (a small seamless bitmap repeated over the page, e.g. the
 * Steam Scream 2023 tentacles) are also 1:1, but the profile canvas shows a grid
 * whose phase comes from Steam's centred `background-position`.
 */
export function readBackgroundPlacement(
  element: HTMLElement | null,
  video: HTMLVideoElement | null,
  backgroundSize?: { width: number; height: number } | null,
): BackgroundPlacement | null {
  if (video) {
    const rect = video.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const natural = {
      width: video.videoWidth || ASSUMED_BACKGROUND.width,
      height: video.videoHeight || ASSUMED_BACKGROUND.height,
    }
    const fit = (getComputedStyle(video).objectFit || 'fill').toLowerCase()
    const painted =
      fit === 'cover' || fit === 'contain'
        ? paintedBackgroundSize(fit, { width: rect.width, height: rect.height }, natural)
        : { width: rect.width, height: rect.height }
    return {
      tile: null,
      frame: frameFromPainted(
        painted,
        natural,
        rect.left + (rect.width - painted.width) / 2,
        rect.top + (rect.height - painted.height) / 2,
      ),
    }
  }
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const style = getComputedStyle(element)
  if (!parseCssUrl(style.backgroundImage)) return null
  const natural =
    backgroundSize && backgroundSize.width > 0 && backgroundSize.height > 0
      ? backgroundSize
      : ASSUMED_BACKGROUND
  const fixed = style.backgroundAttachment === 'fixed'
  const area = fixed
    ? { width: window.innerWidth, height: window.innerHeight }
    : { width: rect.width, height: rect.height }
  const painted = paintedBackgroundSize(style.backgroundSize, area, natural)
  const offset = backgroundOffset(style.backgroundPosition, area, painted)
  const repeat = repeatAxes(style.backgroundRepeat)

  // A repeated bitmap smaller than the profile canvas is the tiled variant.
  // 1920×1080 profile backgrounds stay on the regular single-image path.
  const tilesX = repeat.x && painted.width < PROFILE_BACKGROUND_WIDTH - 0.5
  const tilesY = repeat.y && painted.height < ASSUMED_BACKGROUND.height - 0.5
  if (tilesX || tilesY) {
    // The profile canvas is the centred 1920 px slice of the page; with
    // `background-attachment: fixed` the grid is anchored to the viewport.
    const left = fixed
      ? (window.innerWidth - PROFILE_BACKGROUND_WIDTH) / 2
      : rect.left + (rect.width - PROFILE_BACKGROUND_WIDTH) / 2
    const top = fixed ? 0 : rect.top
    const originX = (fixed ? 0 : rect.left) + offset.x
    const originY = (fixed ? 0 : rect.top) + offset.y
    return {
      frame: { scaleX: 1, scaleY: 1, left, top },
      tile: {
        width: painted.width,
        height: painted.height,
        offsetX: tilePhase(originX, left, painted.width),
        offsetY: tilePhase(originY, top, painted.height),
        repeatX: repeat.x,
        repeatY: repeat.y,
      },
    }
  }

  return {
    tile: null,
    frame: frameFromPainted(
      painted,
      natural,
      (fixed ? 0 : rect.left) + offset.x,
      (fixed ? 0 : rect.top) + offset.y,
    ),
  }
}

export function readBackgroundFrame(
  element: HTMLElement | null,
  video: HTMLVideoElement | null,
  backgroundSize?: { width: number; height: number } | null,
): BackgroundFrame | null {
  return readBackgroundPlacement(element, video, backgroundSize)?.frame ?? null
}

/**
 * Mapping used when the profile has no readable background bitmap. Steam keeps
 * the 976 px content column at 1:1 CSS px, and a 1920 px background is centred,
 * so anchoring the column to `PROFILE_COLUMN_X` reproduces the painted frame.
 */
function contentFrame(rootRect: RectLike | null, leftColumn: RectLike | null): BackgroundFrame | null {
  const left = leftColumn
    ? leftColumn.left - PROFILE_COLUMN_X
    : rootRect
      ? rootRect.left + (rootRect.width - PROFILE_BACKGROUND_WIDTH) / 2
      : null
  if (left === null) return null
  return { scaleX: 1, scaleY: 1, left, top: rootRect?.top ?? 0 }
}

/** Profile-canvas px → viewport px. */
export function profileToViewport(state: FrameSource, x: number, y: number): { left: number; top: number } {
  const frame = state.backgroundFrame
  if (frame) return { left: frame.left + x * frame.scaleX, top: frame.top + y * frame.scaleY }
  const scale = state.scale || 1
  return {
    left: (state.rootRect?.left ?? 0) + x * scale,
    top: (state.rootRect?.top ?? 0) + y * scale,
  }
}

/** Viewport px → profile-canvas px, the space layer/export coordinates live in. */
export function viewportToProfile(
  state: FrameSource,
  left: number,
  top: number,
): { x: number; y: number } | null {
  const frame = state.backgroundFrame
  if (frame) return { x: (left - frame.left) / frame.scaleX, y: (top - frame.top) / frame.scaleY }
  if (!state.rootRect) return null
  const scale = state.scale || 1
  return { x: (left - state.rootRect.left) / scale, y: (top - state.rootRect.top) / scale }
}

export function readPageState(options?: PageReadOptions): PageState {
  const { element, url, video } = readBackgroundElement()
  const root = document.querySelector<HTMLElement>('.profile_page') ?? document.querySelector<HTMLElement>('.profile_content')
  const rootRect = toRectLike(root?.getBoundingClientRect())
  const leftColumn = toRectLike(document.querySelector('.profile_leftcol')?.getBoundingClientRect())
  // The background image is the profile canvas. Its painted rect (which depends
  // on background-size/position, not on the viewport) is what maps profile px to
  // viewport px; falling back to `.profile_page` width broke every layout where
  // the image is painted at its natural 1920 px size in a wider window.
  const placement = readBackgroundPlacement(element, video, options?.backgroundSize ?? null)
  const backgroundFrame = placement?.frame ?? contentFrame(rootRect, leftColumn)
  const scale = backgroundFrame?.scaleX ?? 1
  const anchors = readAnchors().map((anchor) => {
    const origin = viewportToProfile({ backgroundFrame, rootRect, scale }, anchor.rect.left, anchor.rect.top)
    return origin ? { ...anchor, origin } : anchor
  })
  return {
    isProfile: !!root && !!document.querySelector('.profile_header, .profile_leftcol'),
    rootRect,
    scale,
    backgroundFrame,
    backgroundTile: placement?.tile ?? null,
    backgroundUrl: url,
    backgroundElement: element,
    anchors,
    leftColumn,
    persona: readPersona(),
    steamId: readSteamId(),
    spmDetected: detectSpm(),
    backgroundSize: element ? getComputedStyle(element).backgroundSize : '',
    backgroundIsVideo: !!video,
    backgroundVideo: video,
  }
}

/** Steam Profile Modifier previews with a #spm-… hash and writes .profile_page inline styles. */
export function detectSpm(): boolean {
  if (/^#spm/i.test(location.hash)) return true
  if (
    document.querySelector(
      '.profile_animated_background, .miniprofile_nameplatecontainer, [data-spm], #spm-root, [class^="spm-"], [id^="spm-"]',
    )
  ) {
    return true
  }
  const profilePage = document.querySelector<HTMLElement>('.profile_page')
  const preview = parseCssUrl(profilePage?.style.backgroundImage)
  if (!preview) return false
  // SPM keeps the stock background on a separate node and previews on
  // .profile_page. A plain Steam page (or our mock) has only one of them.
  const stock = document.querySelector<HTMLElement>('#responsive_page_template_content > .has_profile_background')
  if (!stock || stock === profilePage) return false
  const stockUrl =
    parseCssUrl(stock.style.backgroundImage) ?? parseCssUrl(getComputedStyle(stock).backgroundImage)
  return !!stockUrl && stockUrl !== preview
}

export interface AnchorRect {
  /** Viewport position of the image area. */
  left: number
  top: number
  width: number
  /** Always the design width, even when Steam's container is a few px wider. */
  designWidth: number
  /** Top-left of the image area on the 1920 px profile canvas. */
  origin: { x: number; y: number } | null
}

/**
 * Where the target showcase's image area sits in the viewport.
 *
 * The frame width comes from the real showcase image, scaled by the ratio of its
 * first slice: Steam's `.showcase_content` is the full 652 px column while the
 * actual image is 615 or 630 px wide. The profile-px origin comes from the
 * background bitmap's painted rect, so it stays correct when the window is wider
 * than the 1920 px background.
 */
export function anchorFor(state: PageState, kind: ShowcaseKind): AnchorRect | null {
  const showcase = SHOWCASES[kind]
  const designWidth = showcase.width
  const profileScale = state.backgroundFrame?.scaleX ?? (state.scale || 1)
  const match = state.anchors.find((anchor) => anchor.kind === kind)
  if (match) {
    // The first slice is the image Steam shows for every showcase kind, so its
    // measured width gives the content scale (not `.showcase_content`'s width).
    const firstSlice = showcase.slices[0]?.width ?? designWidth
    const contentScale = firstSlice > 0 ? match.rect.width / firstSlice : profileScale
    const origin =
      match.origin ?? viewportToProfile(state, match.rect.left, match.rect.top)
    return {
      left: match.rect.left,
      top: match.rect.top,
      width: designWidth * contentScale,
      designWidth,
      origin,
    }
  }
  if (state.leftColumn) {
    const topLeft = viewportToProfile(state, state.leftColumn.left, state.leftColumn.top)
    const origin = {
      x: (topLeft?.x ?? PROFILE_COLUMN_X) + showcase.inner.x,
      y: (topLeft?.y ?? PROFILE_FIRST_SHOWCASE_Y) + showcase.inner.y,
    }
    const view = profileToViewport(state, origin.x, origin.y)
    return {
      left: view.left,
      top: view.top,
      width: designWidth * profileScale,
      designWidth,
      origin,
    }
  }
  if (state.rootRect) {
    const origin = { x: PROFILE_COLUMN_X + showcase.inner.x, y: PROFILE_FIRST_SHOWCASE_Y + showcase.inner.y }
    const view = profileToViewport(state, origin.x, origin.y)
    return {
      left: view.left,
      top: view.top,
      width: designWidth * profileScale,
      designWidth,
      origin,
    }
  }
  return null
}

/** Swap the profile background image and restore it byte for byte afterwards. */
export class BackgroundOverride {
  private element: HTMLElement | null = null
  private originalInline = ''
  private applied: string | null = null

  apply(element: HTMLElement | null, url: string) {
    if (!element) return
    if (this.element && this.element !== element) this.restore()
    if (!this.element) {
      this.element = element
      this.originalInline = element.style.backgroundImage
    }
    element.style.backgroundImage = `url("${url}")`
    this.applied = element.style.backgroundImage
  }

  /** True when our style is still the one on the page. */
  get owned(): boolean {
    return !!this.element && this.element.style.backgroundImage === this.applied
  }

  restore() {
    if (this.element && this.owned) {
      this.element.style.backgroundImage = this.originalInline
    }
    this.element = null
    this.applied = null
  }
}

/** Scroll/resize listener that coalesces into one animation frame. */
export function observePage(callback: () => void): () => void {
  let frame = 0
  const run = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      callback()
    })
  }
  window.addEventListener('scroll', run, { passive: true })
  window.addEventListener('resize', run)
  const observer = new ResizeObserver(run)
  observer.observe(document.documentElement)
  const content = document.querySelector('.profile_leftcol')
  if (content) observer.observe(content)
  return () => {
    window.removeEventListener('scroll', run)
    window.removeEventListener('resize', run)
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}

/** Upload page for illustrations, where the helper takes over. */
export const UPLOAD_PAGE = 'https://steamcommunity.com/sharedfiles/edititem/767/3/'
