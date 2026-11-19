import { useEffect, useRef } from 'react'
import type { AssetLibrary } from '../shared/assets'
import type { CompositionRenderer } from '../shared/render'
import { hasAnimatedLayers } from '../shared/render'
import { SHOWCASES, clampShowcaseHeight, projectSlotRect } from '../shared/geometry'
import type { Cutout, Layer, Project, Rect } from '../shared/types'
import { anchorFor, type PageState } from '../shared/steam/page'
import { layerBounds } from '../shared/assets'
import { useStageTime } from './Stage'
import { Icon } from './bits'

const MIN_CUTOUT = 16

type Drag =
  | { kind: 'layer'; id: string; startX: number; startY: number; cx: number; cy: number }
  | {
      kind: 'layer-scale'
      id: string
      startX: number
      startY: number
      cx: number
      cy: number
      scale: number
      startDistance: number
    }
  | { kind: 'cutout'; id: string; startX: number; startY: number; x: number; y: number }
  | { kind: 'cutout-resize'; id: string; handle: string; startX: number; startY: number; rect: Rect }
  | { kind: 'frame-height'; startY: number; height: number }

export interface PagePreviewProps {
  project: Project
  assets: AssetLibrary
  renderer: CompositionRenderer
  page: PageState | null
  visible: boolean
  editable: boolean
  assetsVersion: number
  selectedLayerId: string | null
  selectedCutoutId: string | null
  onSelectLayer: (id: string | null) => void
  onSelectCutout: (id: string | null) => void
  onLayerChange: (layer: Layer) => void
  onCutoutChange: (cutout: Cutout) => void
  onShowcaseHeightChange: (height: number) => void
}

/** The composition drawn over the real showcase position, in viewport coordinates. */
export function PagePreview({
  project,
  assets,
  renderer,
  page,
  visible,
  editable,
  assetsVersion,
  selectedLayerId,
  selectedCutoutId,
  onSelectLayer,
  onSelectCutout,
  onLayerChange,
  onCutoutChange,
  onShowcaseHeightChange,
}: PagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<Drag | null>(null)
  // Follow the page's own background video so the overlay and the visible
  // profile stay on the same frame.
  const time = useStageTime(project, assets, page?.backgroundVideo ?? null)
  const animated = hasAnimatedLayers(project, assets)

  const anchor = page ? anchorFor(page, project.target) : null
  const showcase = SHOWCASES[project.target]
  const fallback = projectSlotRect(project)
  const scale = anchor ? anchor.width / anchor.designWidth : 1
  // The canvas shows exactly one showcase. Its origin is the measured position
  // of that showcase on the live page, so the background slice belongs to that
  // showcase and not to the first block of the profile.
  const slot: Rect = anchor?.origin
    ? { x: anchor.origin.x, y: anchor.origin.y, w: showcase.width, h: project.showcaseHeight }
    : fallback
  const width = anchor?.width ?? slot.w * scale
  const height = project.showcaseHeight * scale
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))

  useEffect(() => {
    if (!visible || !anchor || width <= 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderer.update(project, assets)
    renderer.draw(ctx, slot, time, pixelWidth / slot.w)
  }, [anchor, assets, assetsVersion, dpr, height, project, renderer, slot, time, visible, width])

  if (!visible || !anchor || width <= 0) return null

  const toProfile = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: slot.x, y: slot.y }
    return {
      x: slot.x + (clientX - rect.left) / scale,
      y: slot.y + (clientY - rect.top) / scale,
    }
  }

  const hitLayer = (x: number, y: number): Layer | null => {
    for (let i = project.layers.length - 1; i >= 0; i--) {
      const layer = project.layers[i]!
      if (!layer.visible || layer.locked) continue
      const bounds = layerBounds(layer, assets.get(layer.assetId))
      if (!bounds) continue
      if (x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h) return layer
    }
    return null
  }

  const hitCutout = (x: number, y: number): Cutout | null => {
    for (let i = project.cutouts.length - 1; i >= 0; i--) {
      const cutout = project.cutouts[i]!
      if (!cutout.enabled) continue
      if (x >= cutout.x && x <= cutout.x + cutout.w && y >= cutout.y && y <= cutout.y + cutout.h) return cutout
    }
    return null
  }

  const selectedLayer = project.layers.find((layer) => layer.id === selectedLayerId) ?? null
  const selectedRecord = selectedLayer ? assets.get(selectedLayer.assetId) : undefined
  const selectedFrame =
    selectedLayer && selectedRecord
      ? {
          left: (selectedLayer.cx - slot.x) * scale,
          top: (selectedLayer.cy - slot.y) * scale,
          width: Math.max(
            1,
            selectedRecord.meta.width * selectedLayer.crop.w * selectedLayer.scale * scale,
          ),
          height: Math.max(
            1,
            selectedRecord.meta.height * selectedLayer.crop.h * selectedLayer.scale * scale,
          ),
          transform: `translate(-50%, -50%) rotate(${selectedLayer.rotation}deg)`,
        }
      : null

  return (
    <div
      ref={containerRef}
      className={`spd-page-preview ${editable ? 'edit' : ''}`}
      style={{
        left: anchor.left,
        top: anchor.top,
        width,
        height,
        pointerEvents: editable ? 'auto' : 'none',
      }}
      onPointerDown={(event) => {
        if (!editable) return
        const target = event.target as HTMLElement
        const { x, y } = toProfile(event.clientX, event.clientY)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Synthetic events may not have a capturable pointer.
        }

        const layerHandle = target.dataset.layerHandle
        if (target.dataset.frameHandle === 'height') {
          drag.current = { kind: 'frame-height', startY: y, height: project.showcaseHeight }
          return
        }

        if (layerHandle && selectedLayer) {
          const startDistance = Math.max(
            1,
            Math.hypot(
              x - selectedLayer.cx,
              y - selectedLayer.cy,
            ),
          )
          drag.current = {
            kind: 'layer-scale',
            id: selectedLayer.id,
            startX: x,
            startY: y,
            cx: selectedLayer.cx,
            cy: selectedLayer.cy,
            scale: selectedLayer.scale,
            startDistance,
          }
          return
        }

        const cutoutHandle = target.dataset.cutoutHandle
        const cutoutId = target.dataset.cutout
        if (cutoutHandle && cutoutId) {
          const cutout = project.cutouts.find((item) => item.id === cutoutId)
          if (!cutout) return
          onSelectCutout(cutout.id)
          drag.current = {
            kind: 'cutout-resize',
            id: cutout.id,
            handle: cutoutHandle,
            startX: x,
            startY: y,
            rect: { x: cutout.x, y: cutout.y, w: cutout.w, h: cutout.h },
          }
          return
        }

        const layer = hitLayer(x, y)
        if (layer) {
          onSelectLayer(layer.id)
          onSelectCutout(null)
          drag.current = { kind: 'layer', id: layer.id, startX: x, startY: y, cx: layer.cx, cy: layer.cy }
          return
        }

        const cutout = hitCutout(x, y)
        if (cutout) {
          onSelectCutout(cutout.id)
          onSelectLayer(null)
          drag.current = { kind: 'cutout', id: cutout.id, startX: x, startY: y, x: cutout.x, y: cutout.y }
          return
        }

        onSelectLayer(null)
        onSelectCutout(null)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        const { x, y } = toProfile(event.clientX, event.clientY)
        if (current.kind === 'frame-height') {
          onShowcaseHeightChange(clampShowcaseHeight(current.height + (y - current.startY)))
          return
        }
        if (current.kind === 'layer') {
          const layer = project.layers.find((item) => item.id === current.id)
          if (!layer) return
          onLayerChange({ ...layer, cx: current.cx + (x - current.startX), cy: current.cy + (y - current.startY) })
          return
        }
        if (current.kind === 'layer-scale') {
          const layer = project.layers.find((item) => item.id === current.id)
          if (!layer) return
          const distance = Math.hypot(x - current.cx, y - current.cy)
          const next = Math.min(30, Math.max(0.01, (current.scale * distance) / current.startDistance))
          onLayerChange({ ...layer, scale: next })
          return
        }
        const cutout = project.cutouts.find((item) => item.id === current.id)
        if (!cutout) return
        if (current.kind === 'cutout') {
          onCutoutChange({ ...cutout, x: current.x + (x - current.startX), y: current.y + (y - current.startY) })
          return
        }
        const dx = x - current.startX
        const dy = y - current.startY
        const r = current.rect
        let { x: nx, y: ny, w: nw, h: nh } = r
        if (current.handle.includes('w')) {
          nx = Math.min(r.x + dx, r.x + r.w - MIN_CUTOUT)
          nw = r.x + r.w - nx
        }
        if (current.handle.includes('e')) nw = Math.max(MIN_CUTOUT, r.w + dx)
        if (current.handle.includes('n')) {
          ny = Math.min(r.y + dy, r.y + r.h - MIN_CUTOUT)
          nh = r.y + r.h - ny
        }
        if (current.handle.includes('s')) nh = Math.max(MIN_CUTOUT, r.h + dy)
        onCutoutChange({ ...cutout, x: nx, y: ny, w: nw, h: nh })
      }}
      onPointerUp={(event) => {
        drag.current = null
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          // already released
        }
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onWheel={(event) => {
        if (!editable) return
        event.preventDefault()
        const point = toProfile(event.clientX, event.clientY)
        const layer = hitLayer(point.x, point.y) ?? project.layers[project.layers.length - 1]
        if (!layer) return
        onSelectLayer(layer.id)
        const next = Math.min(30, Math.max(0.01, layer.scale * Math.exp(-event.deltaY * 0.0015)))
        onLayerChange({ ...layer, scale: next })
      }}
    >
      <canvas ref={canvasRef} />

      {editable
        ? project.cutouts.map((cutout) => {
            if (!cutout.enabled) return null
            const selected = cutout.id === selectedCutoutId
            return (
              <div
                key={cutout.id}
                data-cutout={cutout.id}
                className={`spd-page-cutout ${selected ? 'selected' : ''}`}
                style={{
                  left: (cutout.x - slot.x) * scale,
                  top: (cutout.y - slot.y) * scale,
                  width: cutout.w * scale,
                  height: cutout.h * scale,
                  pointerEvents: 'none',
                }}
              >
                {selected ? (
                  <>
                    {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
                      <span
                        key={handle}
                        className={`handle ${handle}`}
                        data-cutout={cutout.id}
                        data-cutout-handle={handle}
                      />
                    ))}
                  </>
                ) : null}
              </div>
            )
          })
        : null}

      {editable && selectedFrame ? (
        <div className="sel" style={selectedFrame} title={selectedLayer?.name ?? ''}>
          <span className="tag">{selectedLayer?.name}</span>
          {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
            <span key={handle} className={`handle ${handle}`} data-layer-handle={handle} />
          ))}
        </div>
      ) : null}

      {editable ? (
        <div
          className="spd-page-height"
          data-frame-handle="height"
          title="Потяните вниз или вверх, чтобы изменить высоту витрины"
        >
          <span className="grip" />
          <span className="value">{Math.round(project.showcaseHeight)} px</span>
        </div>
      ) : null}

      <div className="ring" />
      <div className="badge">
        <Icon name="eye" size={11} />
        Предпросмотр{animated ? ' · GIF' : ''}
      </div>
    </div>
  )
}
