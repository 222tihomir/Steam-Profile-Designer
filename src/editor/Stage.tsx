import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssetLibrary } from '../shared/assets'
import { layerBounds } from '../shared/assets'
import { CompositionRenderer, animationDuration, hasAnimatedLayers } from '../shared/render'
import { defaultSlotRect } from '../shared/geometry'
import type { Cutout, Layer, Project, Rect } from '../shared/types'
import { Icon } from './bits'

const MIN_CUTOUT = 16

type Drag =
  | { kind: 'layer'; id: string; startX: number; startY: number; cx: number; cy: number }
  | { kind: 'cutout'; id: string; startX: number; startY: number; rect: Rect }
  | { kind: 'resize'; id: string; handle: string; startX: number; startY: number; rect: Rect }

export interface StageProps {
  project: Project
  assets: AssetLibrary
  renderer: CompositionRenderer
  mode: 'art' | 'window'
  selectedLayerId: string | null
  selectedCutoutId: string | null
  onSelectLayer: (id: string | null) => void
  onSelectCutout: (id: string | null) => void
  onLayerChange: (layer: Layer) => void
  onCutoutChange: (cutout: Cutout) => void
  big?: boolean
  onRequestBackground?: () => void
  assetsVersion: number
}

function clampView(rect: Rect, canvasHeight: number): Rect {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const right = Math.min(1920, rect.x + rect.w)
  const bottom = Math.min(canvasHeight, rect.y + rect.h)
  return { x, y, w: Math.max(60, right - x), h: Math.max(60, bottom - y) }
}

export function Stage(props: StageProps) {
  const {
    project,
    assets,
    renderer,
    mode,
    selectedLayerId,
    selectedCutoutId,
    onSelectLayer,
    onSelectCutout,
    onLayerChange,
    onCutoutChange,
    big,
    onRequestBackground,
    assetsVersion,
  } = props

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [width, setWidth] = useState(360)
  const dragRef = useRef<Drag | null>(null)
  const projectRef = useRef(project)
  projectRef.current = project

  const slot = defaultSlotRect(project.target, project.showcaseHeight)
  const margin = big ? 200 : 110
  const view = useMemo(
    () => clampView({ x: slot.x - margin, y: slot.y - margin, w: slot.w + margin * 2, h: slot.h + margin * 2 }, project.canvasHeight),
    [slot.x, slot.y, slot.w, slot.h, margin, project.canvasHeight],
  )

  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const animated = hasAnimatedLayers(project, assets)
  const duration = animationDuration(project, assets)
  const selectedLayer = project.layers.find((l) => l.id === selectedLayerId) ?? null

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const draw = useCallback(
    (timeMs: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const targetWidth = Math.max(120, Math.round(width * dpr))
      const targetHeight = Math.max(60, Math.round((targetWidth * view.h) / view.w))
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth
        canvas.height = targetHeight
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      renderer.update(project, assets)
      renderer.draw(ctx, view, timeMs, targetWidth / view.w)
    },
    [assets, dpr, project, renderer, view, width],
  )

  useEffect(() => {
    draw(0)
  }, [draw, assetsVersion])

  useEffect(() => {
    if (!animated) {
      draw(0)
      return
    }
    let frame = 0
    const start = performance.now()
    const loop = () => {
      draw(performance.now() - start)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [animated, draw, duration])

  const toProfile = (clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: view.x + ((clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((clientY - rect.top) / rect.height) * view.h,
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

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const { x, y } = toProfile(event.clientX, event.clientY)
    const target = event.target as HTMLElement
    const handle = target.dataset.handle
    const cutoutId = target.dataset.cutout
    event.currentTarget.setPointerCapture(event.pointerId)

    if (mode === 'window') {
      if (handle && cutoutId) {
        const cutout = project.cutouts.find((c) => c.id === cutoutId)
        if (!cutout) return
        onSelectCutout(cutout.id)
        dragRef.current = { kind: 'resize', id: cutout.id, handle, startX: x, startY: y, rect: { x: cutout.x, y: cutout.y, w: cutout.w, h: cutout.h } }
        return
      }
      const cutout = hitCutout(x, y)
      if (cutout) {
        onSelectCutout(cutout.id)
        dragRef.current = { kind: 'cutout', id: cutout.id, startX: x, startY: y, rect: { x: cutout.x, y: cutout.y, w: cutout.w, h: cutout.h } }
      } else {
        onSelectCutout(null)
      }
      return
    }

    const layer = hitLayer(x, y)
    if (layer) {
      onSelectLayer(layer.id)
      if (!layer.locked) {
        dragRef.current = { kind: 'layer', id: layer.id, startX: x, startY: y, cx: layer.cx, cy: layer.cy }
      }
    } else {
      onSelectLayer(null)
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = toProfile(event.clientX, event.clientY)
    const dx = x - drag.startX
    const dy = y - drag.startY
    if (drag.kind === 'layer') {
      const layer = projectRef.current.layers.find((l) => l.id === drag.id)
      if (layer) onLayerChange({ ...layer, cx: drag.cx + dx, cy: drag.cy + dy })
      return
    }
    const cutout = projectRef.current.cutouts.find((c) => c.id === drag.id)
    if (!cutout) return
    if (drag.kind === 'cutout') {
      onCutoutChange({ ...cutout, x: drag.rect.x + dx, y: drag.rect.y + dy })
      return
    }
    const r = drag.rect
    let { x: nx, y: ny, w: nw, h: nh } = r
    if (drag.handle.includes('w')) {
      nx = Math.min(r.x + dx, r.x + r.w - MIN_CUTOUT)
      nw = r.x + r.w - nx
    }
    if (drag.handle.includes('e')) nw = Math.max(MIN_CUTOUT, r.w + dx)
    if (drag.handle.includes('n')) {
      ny = Math.min(r.y + dy, r.y + r.h - MIN_CUTOUT)
      nh = r.y + r.h - ny
    }
    if (drag.handle.includes('s')) nh = Math.max(MIN_CUTOUT, r.h + dy)
    onCutoutChange({ ...cutout, x: nx, y: ny, w: nw, h: nh })
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // pointer already released
      }
    }
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (mode !== 'art' || !selectedLayer) return
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0015)
    const next = Math.min(30, Math.max(0.01, selectedLayer.scale * factor))
    onLayerChange({ ...selectedLayer, scale: next })
  }

  const percent = (value: number, start: number, size: number) => `${((value - start) / size) * 100}%`

  const exportFrame = {
    left: percent(slot.x, view.x, view.w),
    top: percent(slot.y, view.y, view.h),
    width: `${(slot.w / view.w) * 100}%`,
    height: `${(slot.h / view.h) * 100}%`,
  }

  const bounds = selectedLayer ? layerBounds(selectedLayer, assets.get(selectedLayer.assetId)) : null

  return (
    <div className="spd-stage-wrap" ref={wrapRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onWheel={onWheel}>
      <canvas ref={canvasRef} style={{ aspectRatio: `${view.w} / ${view.h}` }} />
      <div className="spd-stage-hud">
        <div className="spd-export-frame" style={exportFrame}>
          <span className="tag">
            {mode === 'window' ? 'границы витрины' : `экспорт · ${slot.w}×${slot.h}`}
          </span>
        </div>

        {project.cutouts.map((cutout) => {
          if (!cutout.enabled) return null
          const selected = cutout.id === selectedCutoutId
          return (
            <div
              key={cutout.id}
              data-cutout={cutout.id}
              className={`spd-cutout ${selected ? 'selected' : ''}`}
              style={{
                left: percent(cutout.x, view.x, view.w),
                top: percent(cutout.y, view.y, view.h),
                width: `${(cutout.w / view.w) * 100}%`,
                height: `${(cutout.h / view.h) * 100}%`,
                pointerEvents: mode === 'window' ? 'auto' : 'none',
              }}
            >
              {selected && mode === 'window'
                ? ['nw', 'ne', 'sw', 'se'].map((handle) => (
                    <span key={handle} className={`handle ${handle}`} data-handle={handle} data-cutout={cutout.id} />
                  ))
                : null}
            </div>
          )
        })}

        {bounds && mode === 'art' ? (
          <div
            className="spd-layer-frame"
            style={{
              left: percent(bounds.x, view.x, view.w),
              top: percent(bounds.y, view.y, view.h),
              width: `${(bounds.w / view.w) * 100}%`,
              height: `${(bounds.h / view.h) * 100}%`,
            }}
          >
            <span className="tag">{selectedLayer?.name}</span>
          </div>
        ) : null}

        {!project.background ? (
          <div className="spd-stage-empty">
            <Icon name="image" size={22} />
            <div>Сначала выберите фон Steam</div>
            {onRequestBackground ? (
              <button className="primary" type="button" onClick={onRequestBackground}>
                Выбрать фон
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Player used on the live page preview and in the studio.
 *
 * On the real page Steam Profile Modifier plays the animated background with a
 * <video>. Our overlay keeps its own copy of those frames, so it has to follow
 * the video's clock: otherwise both loops start at different moments and the
 * preview background drifts away from the page. Passing the live video in keeps
 * them in phase (and freezes the overlay when the page video is paused).
 *
 * Without a video the clock starts once and never restarts on project edits or
 * asset loads, which used to make the animation jump back to frame 0 whenever
 * anything changed.
 */
export function useStageTime(
  project: Project,
  assets: AssetLibrary,
  video: HTMLVideoElement | null = null,
): number {
  const animated = hasAnimatedLayers(project, assets)
  const [time, setTime] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (!animated) {
      startRef.current = null
      setTime(0)
      return
    }
    let frame = 0
    const loop = () => {
      if (video) {
        const position = video.currentTime
        if (Number.isFinite(position) && position >= 0) {
          setTime(position * 1000)
          frame = requestAnimationFrame(loop)
          return
        }
      }
      if (startRef.current === null) startRef.current = performance.now()
      setTime(performance.now() - startRef.current)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [animated, video])

  return time
}
