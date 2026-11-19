import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssetLibrary } from '../shared/assets'
import type { BackgroundOption, BlendMode, Layer, LayerKeying, Project, ShowcaseKind } from '../shared/types'
import { SHOWCASES, SHOWCASE_ORDER, defaultSlotRect, formatBytes, planSlices } from '../shared/geometry'
import { MAX_GIF_FRAMES, buildGifTimeline, gifFrameLimit, gifMaster } from '../shared/export'
import { hasAnimatedLayers, hasVideoBackground } from '../shared/render'
import { cornerColor, normalizeKeying } from '../shared/keying'
import { catalogThumbUrl, searchCatalog } from '../shared/steam/catalog'
import { UPLOAD_PAGE } from '../shared/steam/page'
import type { EditorApi } from './api'
import { Divider, Icon, NumField, Segmented, Toggle } from './bits'

function useBlobUrl(blob: Blob | null | undefined): string | null {
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

function AssetImage({ api, assetId, className, style }: { api: EditorApi; assetId: string; className?: string; style?: React.CSSProperties }) {
  const record = api.assets.get(assetId)
  const url = useBlobUrl(record?.blob)
  if (!url) return <div className={className} style={style} />
  return <img className={className} style={style} src={url} alt="" draggable={false} />
}

function BackgroundImage({ api, children }: { api: EditorApi; children?: React.ReactNode }) {
  const background = api.project.background
  const record = background?.assetId ? api.assets.get(background.assetId) : null
  const blobUrl = useBlobUrl(record?.blob)
  const src = blobUrl ?? background?.url
  const tile = background?.tile
  const style: React.CSSProperties = { backgroundImage: src ? `url("${src}")` : undefined }
  if (tile) {
    // Tiled Steam backgrounds repeat at their real size over a black page.
    style.backgroundColor = '#000'
    style.backgroundRepeat = tile.repeatX
      ? tile.repeatY
        ? 'repeat'
        : 'repeat-x'
      : tile.repeatY
        ? 'repeat-y'
        : 'no-repeat'
    style.backgroundSize = `${tile.width}px ${tile.height}px`
    style.backgroundPosition = `${tile.offsetX}px ${tile.offsetY}px`
  }
  return (
    <div className="spd-bg-hero">
      <div className="preview" style={style} />
      {children}
    </div>
  )
}

const BLEND_LABELS: { value: BlendMode; label: string }[] = [
  { value: 'source-over', label: 'Обычный' },
  { value: 'multiply', label: 'Умножение' },
  { value: 'screen', label: 'Экран' },
  { value: 'overlay', label: 'Перекрытие' },
  { value: 'lighten', label: 'Осветление' },
  { value: 'darken', label: 'Затемнение' },
  { value: 'soft-light', label: 'Мягкий свет' },
  { value: 'hard-light', label: 'Жёсткий свет' },
  { value: 'difference', label: 'Разница' },
  { value: 'luminosity', label: 'Яркость' },
]

export function BackgroundPanel({ api }: { api: EditorApi }) {
  const [source, setSource] = useState<'profile' | 'inventory' | 'catalog' | 'custom'>('profile')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(120)
  const [url, setUrl] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const project = api.project
  const background = project.background

  const catalog = useMemo(() => searchCatalog(query, limit), [query, limit])
  const isBusy = !!api.busy

  return (
    <>
      <div className="spd-card">
        <div className="spd-card-head">
          <span className="spd-title">Фон профиля</span>
          {background ? (
            <span className="spd-badge accent">
              {background.source === 'profile'
                ? 'с профиля'
                : background.source === 'inventory'
                  ? 'инвентарь'
                  : background.source === 'catalog'
                    ? 'каталог'
                    : background.source === 'file'
                      ? 'файл'
                      : 'ссылка'}
            </span>
          ) : (
            <span className="spd-badge">не выбран</span>
          )}
        </div>

        <BackgroundImage api={api}>
          <div className="meta">
            <span className="name">{background?.name ?? 'Выберите фон, чтобы начать'}</span>
            {background ? (
              <span className="spd-badge">{background.width}×{background.height}</span>
            ) : null}
          </div>
        </BackgroundImage>

        {background?.source === 'profile' && background.videoUrl ? (
          <div className="spd-hint">
            {api.videoCapture === 'reading'
              ? 'Читаю кадры видео-фона SPM…'
              : api.videoCapture === 'failed'
                ? 'Видео-фон SPM не удалось прочитать (чужой домен без CORS) — в файл попадёт постер, GIF будет без движения.'
                : 'Видео-фон SPM: его кадры попадут в предпросмотр и в GIF.'}
          </div>
        ) : null}

        {api.page?.backgroundUrl ? (
          <button
            className="primary"
            disabled={isBusy}
            onClick={() => void api.useProfileBackground()}
            title="Прочитать фон, который сейчас стоит на открытом профиле"
          >
            <Icon name="wand" /> Взять фон с этого профиля
          </button>
        ) : api.page?.backgroundIsVideo ? (
          <div className="spd-hint">
            SPM использует видео-фон без картинки-постера. Кадры читаются из самого видео и попадут в GIF.
          </div>
        ) : (
          <div className="spd-hint">
            Откройте свой профиль Steam — расширение само определит установленный фон. Или выберите фон из
            инвентаря и каталога ниже.
          </div>
        )}

        <div className="spd-grid-2">
          <button onClick={() => fileRef.current?.click()} disabled={isBusy}>
            <Icon name="upload" /> Свой файл
          </button>
          <button onClick={() => setSource('custom')} disabled={isBusy}>
            <Icon name="link" /> По ссылке
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void api.uploadBackground(file)
          }}
        />

        <NumField
          label="Высота фона"
          min={600}
          max={3000}
          step={10}
          value={project.canvasHeight}
          onChange={(value) => api.patchProject({ canvasHeight: value })}
        />
        <div className="spd-hint">Высота холста в пикселях профиля. Ширина всегда 1920.</div>
      </div>

      <div className="spd-card">
        <div className="spd-seg" style={{ marginBottom: 2 }}>
          {(
            [
              ['inventory', 'Инвентарь'],
              ['catalog', 'Каталог'],
              ['custom', 'Своё'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} className={source === value ? 'active' : ''} onClick={() => setSource(value)} type="button">
              {label}
            </button>
          ))}
        </div>

        {source === 'inventory' ? (
          <>
            <div className="spd-hint">
              Фоны из публичного инвентаря этого профиля. Steam API Key не нужен, файлы не покидают браузер.
              {api.surface === 'studio' ? ' Откройте студию из панели на странице профиля, чтобы подставить SteamID.' : ''}
            </div>
            <div className="spd-row">
              <button onClick={() => void api.loadInventory()} disabled={api.inventory.loading || !api.page?.steamId}>
                <Icon name="refresh" /> {api.inventory.loaded ? 'Обновить инвентарь' : 'Загрузить фоны'}
              </button>
              {api.inventory.loaded ? <span className="spd-badge green">{api.inventory.items.length} фонов</span> : null}
            </div>
            {!api.page?.steamId ? <div className="spd-hint spd-warn-text">SteamID не найден: откройте страницу профиля.</div> : null}
            {api.inventory.error ? <div className="spd-hint spd-warn-text">{api.inventory.error}</div> : null}
            {api.inventory.loading ? <div className="spd-hint">Загружаю инвентарь…</div> : null}
            {api.inventory.items.length ? (
              <div className="spd-grid-3" style={{ maxHeight: 300, overflowY: 'auto', paddingRight: 2 }}>
                {api.inventory.items.map((item) => (
                  <button
                    key={item.id}
                    className="spd-thumb-btn"
                    disabled={isBusy}
                    title={`${item.name}${item.appName ? ` · ${item.appName}` : ''}`}
                    onClick={() => void api.pickBackground(item.url, item.name, 'inventory')}
                  >
                    <img className="spd-thumb" src={item.url.replace('1920x1080', '320x200')} alt="" loading="lazy" />
                    <span className="cap">{item.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {source === 'catalog' ? (
          <>
            <div className="spd-row">
              <input
                type="search"
                placeholder="Поиск: Portal, cyberpunk, minimal…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setLimit(120)
                }}
              />
            </div>
            <div className="spd-row between">
              <span className="spd-hint">Найдено: {catalog.total}</span>
              <span className="spd-hint">каталог Steam Points Shop</span>
            </div>
            <div className="spd-grid-3" style={{ maxHeight: 320, overflowY: 'auto', paddingRight: 2 }}>
              {catalog.items.map((item) => (
                <button
                  key={`${item.a}/${item.i}`}
                  className="spd-thumb-btn"
                  disabled={isBusy}
                  title={item.w ? `${item.n} · анимированный, будет использован первый кадр` : item.n}
                  onClick={() => void api.pickBackground(`https://shared.fastly.steamstatic.com/community_assets/images/items/${item.a}/${item.i}`, item.n, 'catalog')}
                >
                  <img className="spd-thumb" src={catalogThumbUrl(item)} alt="" loading="lazy" />
                  <span className="cap">{item.n}</span>
                </button>
              ))}
            </div>
            {catalog.items.length < catalog.total ? (
              <button onClick={() => setLimit((value) => value + 120)}>Показать ещё</button>
            ) : null}
          </>
        ) : null}

        {source === 'custom' ? (
          <>
            <div className="spd-row">
              <input
                type="url"
                placeholder="https://…/background.jpg"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <button
                disabled={!url.trim() || isBusy}
                onClick={() => {
                  const value = url.trim()
                  if (!value) return
                  void api.pickBackground(value, value.split('/').pop() ?? 'Фон', 'url')
                  setUrl('')
                }}
              >
                Взять
              </button>
            </div>
            <div className="spd-hint">Ссылка должна открываться без авторизации. Файл скачается локально для экспорта.</div>
          </>
        ) : null}
      </div>
    </>
  )
}

export function WindowPanel({ api }: { api: EditorApi }) {
  const project = api.project
  const selected = project.cutouts.find((c) => c.id === api.selection.cutoutId) ?? project.cutouts[0] ?? null
  const slot = defaultSlotRect(project.target, project.showcaseHeight)

  if (!project.cutouts.length) {
    return (
      <div className="spd-card">
        <div className="spd-title">Прозрачный центр</div>
        <div className="spd-hint">
          Окно в фоне: в нём будет виден настоящий фон страницы Steam, а ваша картинка или GIF ляжет сверху.
          Так композиция не «приклеивается» прямоугольником и совпадает с профилем.
        </div>
        <button className="primary" onClick={() => api.makeCenterTransparent()}>
          <Icon name="scissors" /> Сделать прозрачным центр
        </button>
        <div className="spd-hint">
          Размер окна по умолчанию — 76% ширины витрины. Дальше его можно двигать и растягивать прямо на холсте.
        </div>
      </div>
    )
  }

  if (!selected) return null

  const outside =
    selected.x < slot.x ||
    selected.y < slot.y ||
    selected.x + selected.w > slot.x + slot.w ||
    selected.y + selected.h > slot.y + slot.h

  return (
    <>
      <div className="spd-card">
        <div className="spd-card-head">
          <span className="spd-title">Окна прозрачности</span>
          <button className="icon" title="Добавить окно" onClick={() => api.addCutout()}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="spd-row wrap">
          {project.cutouts.map((cutout, index) => (
            <button
              key={cutout.id}
              className={cutout.id === selected.id ? 'primary' : ''}
              style={{ padding: '4px 9px' }}
              onClick={() => api.selectCutout(cutout.id)}
            >
              Окно {index + 1}
              {!cutout.enabled ? ' · выкл' : ''}
            </button>
          ))}
        </div>
        <Toggle
          label="Окно включено"
          checked={selected.enabled}
          onChange={(enabled) => api.updateCutout({ ...selected, enabled })}
        />
        <div className="spd-row between">
          <span className="spd-hint">Вырезает фон и показывает страницу Steam</span>
          <button className="danger" onClick={() => api.removeCutout(selected.id)}>
            <Icon name="trash" /> Удалить
          </button>
        </div>
      </div>

      <div className="spd-card">
        <div className="spd-title">Размер и положение</div>
        <NumField label="X" min={0} max={1920} value={selected.x} onChange={(x) => api.updateCutout({ ...selected, x })} />
        <NumField label="Y" min={0} max={project.canvasHeight} value={selected.y} onChange={(y) => api.updateCutout({ ...selected, y })} />
        <NumField label="Ширина" min={16} max={1920} value={selected.w} onChange={(w) => api.updateCutout({ ...selected, w })} />
        <NumField label="Высота" min={16} max={project.canvasHeight} value={selected.h} onChange={(h) => api.updateCutout({ ...selected, h })} />
        <NumField
          label="Скругление"
          min={0}
          max={400}
          value={selected.radius}
          onChange={(radius) => api.updateCutout({ ...selected, radius })}
        />
        <NumField
          label="Мягкий край"
          min={0}
          max={160}
          value={selected.feather}
          onChange={(feather) => api.updateCutout({ ...selected, feather })}
        />
        <div className="spd-grid-3">
          <button onClick={() => api.centerCutout(selected.id)}>По центру</button>
          <button onClick={() => api.fitCutoutToSlot(selected.id)}>На витрину</button>
          <button
            onClick={() => {
              const layer = project.layers.find((l) => l.id === api.selection.layerId) ?? project.layers[project.layers.length - 1]
              if (!layer) return api.toast('Сначала добавьте картинку', 'error')
              const record = api.assets.get(layer.assetId)
              if (!record) return
              const w = record.meta.width * layer.crop.w * layer.scale
              const h = record.meta.height * layer.crop.h * layer.scale
              api.updateCutout({ ...selected, x: layer.cx - w / 2, y: layer.cy - h / 2, w, h })
            }}
          >
            По картинке
          </button>
        </div>
        {outside ? (
          <div className="spd-hint spd-warn-text">
            Окно выходит за границы витрины {slot.w}×{slot.h}. За её пределами прозрачность не сохранится.
          </div>
        ) : null}
        <div className="spd-hint">
          Тяните окно мышью на холсте, углы — для изменения размера. Несколько окон можно добавить кнопкой «+».
        </div>
      </div>
    </>
  )
}

/**
 * Solid-background removal controls, shared by the simple and full art panels.
 * The key colour is sampled from a corner by default; any colour can be set by
 * hand, and the flood-fill mode keeps same-coloured details inside the subject.
 */
function KeyingSection({ api, layer }: { api: EditorApi; layer: Layer }) {
  const keying = normalizeKeying(layer.keying)
  const patch = (value: Partial<LayerKeying>) =>
    api.updateLayer({ ...layer, keying: normalizeKeying({ ...keying, ...value }) })

  const firstFrame = () => api.assets.bitmapAt(layer.assetId, 0)

  const takeCorner = () => {
    const bitmap = firstFrame()
    if (!bitmap) {
      api.toast('Файл ещё не загрузился', 'error')
      return
    }
    patch({ color: cornerColor(bitmap) })
  }

  const enable = (enabled: boolean) => {
    if (!enabled || layer.keying) {
      patch({ enabled })
      return
    }
    const bitmap = firstFrame()
    patch({ enabled: true, color: bitmap ? cornerColor(bitmap) : keying.color })
  }

  return (
    <>
      <Divider />
      <div className="spd-card-head">
        <span className="spd-title">Убрать фон</span>
        {keying.enabled ? <span className="spd-badge accent">вкл</span> : null}
      </div>
      <Toggle
        label="Сплошной фон — прозрачный"
        hint="Пиксели выбранного цвета станут прозрачными во всех кадрах. Работает для картинок, GIF и видео."
        checked={keying.enabled}
        onChange={enable}
      />
      {keying.enabled ? (
        <>
          <div className="spd-field">
            <span>Цвет</span>
            <span className="spd-color-field">
              <input
                type="color"
                value={keying.color}
                onChange={(event) => patch({ color: event.target.value })}
                title="Цвет фона"
              />
              <code>{keying.color}</code>
            </span>
            <button className="ghost" onClick={takeCorner} title="Взять цвет из угла первого кадра">
              Из угла
            </button>
          </div>
          <NumField
            label="Допуск"
            min={0}
            max={180}
            step={1}
            value={keying.tolerance}
            onChange={(tolerance) => patch({ tolerance })}
          />
          <NumField
            label="Мягкий край"
            min={0}
            max={64}
            step={1}
            value={keying.feather}
            onChange={(feather) => patch({ feather })}
          />
          <div className="spd-field">
            <span>Область</span>
            <Segmented
              value={keying.mode}
              onChange={(mode) => patch({ mode })}
              options={[
                { value: 'edges', label: 'По краям' },
                { value: 'global', label: 'Везде' },
              ]}
            />
            <span />
          </div>
          <div className="spd-hint">
            «По краям» убирает только фон, связанный с краем кадра, поэтому тот же цвет внутри картинки
            останется. «Везде» убирает каждый пиксель этого цвета. Допуск расширяет захват цвета, мягкий
            край сглаживает границу.
          </div>
        </>
      ) : null}
    </>
  )
}

export function ArtPanel({ api }: { api: EditorApi }) {
  const project = api.project
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [over, setOver] = useState(false)
  const selected = project.layers.find((layer) => layer.id === api.selection.layerId) ?? null

  const update = (patch: Partial<Layer>) => {
    if (!selected) return
    api.updateLayer({ ...selected, ...patch })
  }

  return (
    <>
      <div
        className={`spd-dropzone ${over ? 'over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          if (event.dataTransfer.files.length) void api.addArtFiles(event.dataTransfer.files)
        }}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
          <Icon name="image" size={22} />
        </div>
        Перетащите PNG, JPG, WebP, GIF или видео (MP4, WebM)
        <div className="spd-hint" style={{ marginTop: 4 }}>
          или нажмите, чтобы выбрать файлы. Видео превращается в GIF-слой.
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void api.addArtFiles(event.target.files)
          event.target.value = ''
        }}
      />

      {project.layers.length ? (
        <div className="spd-card tight">
          <div className="spd-card-head">
            <span className="spd-title">Слои</span>
            <span className="spd-badge">{project.layers.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...project.layers].reverse().map((layer) => {
              const record = api.assets.get(layer.assetId)
              return (
                <div
                  key={layer.id}
                  className={`spd-layer ${layer.id === api.selection.layerId ? 'selected' : ''}`}
                  onClick={() => api.selectLayer(layer.id)}
                >
                  <AssetImage api={api} assetId={layer.assetId} />
                  <span className="name">
                    {layer.name}
                    {record?.meta.kind === 'video' ? <span className="spd-badge accent">ВИДЕО</span> : null}
                    {record?.meta.kind !== 'video' && record?.gif ? (
                      <span className="spd-badge accent">GIF</span>
                    ) : null}
                    {layer.keying?.enabled ? <span className="spd-badge">БЕЗ ФОНА</span> : null}
                  </span>
                  <span className="acts" onClick={(event) => event.stopPropagation()}>
                    <button title="Показать/скрыть" onClick={() => api.updateLayer({ ...layer, visible: !layer.visible })}>
                      <Icon name={layer.visible ? 'eye' : 'eyeOff'} size={14} />
                    </button>
                    <button title="Заблокировать" onClick={() => api.updateLayer({ ...layer, locked: !layer.locked })}>
                      <Icon name={layer.locked ? 'lock' : 'unlock'} size={14} />
                    </button>
                    <button title="Выше" onClick={() => api.moveLayer(layer.id, 1)}>
                      <Icon name="up" size={14} />
                    </button>
                    <button title="Ниже" onClick={() => api.moveLayer(layer.id, -1)}>
                      <Icon name="down" size={14} />
                    </button>
                    <button title="Дублировать" onClick={() => api.duplicateLayer(layer.id)}>
                      <Icon name="layers" size={14} />
                    </button>
                    <button title="Удалить" onClick={() => api.removeLayer(layer.id)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="spd-hint">Верхний слой в списке лежит поверх остальных.</div>
        </div>
      ) : (
        <div className="spd-card">
          <div className="spd-title">Своя картинка или GIF</div>
          <div className="spd-hint">
            Добавьте файл — он появится в прозрачном окне. Поддерживаются PNG с прозрачностью, JPG, WebP и
            анимированные GIF с сохранением кадров.
          </div>
        </div>
      )}

      {selected ? (
        <div className="spd-card">
          <div className="spd-card-head">
            <span className="spd-title">{selected.name}</span>
            <span className="spd-badge">
              {api.assets.get(selected.assetId)?.meta.width}×{api.assets.get(selected.assetId)?.meta.height}
            </span>
          </div>

          <div className="spd-grid-3">
            <button onClick={() => api.addLayerToWindow(selected.id)} title="Вписать в прозрачное окно">
              <Icon name="target" /> В окно
            </button>
            <button onClick={() => update({ rotation: 0, flipX: false })}>
              <Icon name="refresh" /> Ровно
            </button>
            <button onClick={() => update({ flipX: !selected.flipX })} className={selected.flipX ? 'primary' : ''}>
              <Icon name="flip" /> Отразить
            </button>
          </div>

          <NumField
            label="Масштаб"
            min={0.02}
            max={8}
            step={0.01}
            value={selected.scale}
            onChange={(scale) => update({ scale })}
          />
          <div className="spd-row">
            <button className="ghost" style={{ flex: 1 }} onClick={() => update({ scale: Math.max(0.02, selected.scale / 1.1) })}>
              −10%
            </button>
            <button className="ghost" style={{ flex: 1 }} onClick={() => update({ scale: Math.min(8, selected.scale * 1.1) })}>
              +10%
            </button>
            <span className="spd-hint" style={{ width: 90, textAlign: 'right' }}>
              {Math.round(selected.scale * 1000) / 10}%
            </span>
          </div>

          <NumField
            label="Поворот"
            min={-180}
            max={180}
            step={1}
            value={selected.rotation}
            onChange={(rotation) => update({ rotation })}
          />
          <NumField
            label="Прозрачность"
            min={0}
            max={1}
            step={0.01}
            value={selected.opacity}
            onChange={(opacity) => update({ opacity })}
          />
          <div className="spd-field">
            <span>Наложение</span>
            <select value={selected.blend} onChange={(event) => update({ blend: event.target.value as BlendMode })}>
              {BLEND_LABELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <span />
          </div>

          <KeyingSection api={api} layer={selected} />

          <Divider />
          <div className="spd-title">Положение</div>
          <div className="spd-grid-2">
            <label className="spd-hint">
              X
              <input
                type="number"
                value={Math.round(selected.cx)}
                onChange={(event) => update({ cx: Number(event.target.value) })}
              />
            </label>
            <label className="spd-hint">
              Y
              <input
                type="number"
                value={Math.round(selected.cy)}
                onChange={(event) => update({ cy: Number(event.target.value) })}
              />
            </label>
          </div>

          <Divider />
          <div className="spd-card-head">
            <span className="spd-title">Кадрирование</span>
            <button
              className="ghost"
              onClick={() => update({ crop: { x: 0, y: 0, w: 1, h: 1 } })}
              title="Сбросить обрезку"
            >
              Сброс
            </button>
          </div>
          <NumField
            label="Слева"
            min={0}
            max={0.9}
            step={0.01}
            value={selected.crop.x}
            onChange={(x) => update({ crop: { ...selected.crop, x, w: Math.min(selected.crop.w, 1 - x) } })}
          />
          <NumField
            label="Сверху"
            min={0}
            max={0.9}
            step={0.01}
            value={selected.crop.y}
            onChange={(y) => update({ crop: { ...selected.crop, y, h: Math.min(selected.crop.h, 1 - y) } })}
          />
          <NumField
            label="Ширина"
            min={0.05}
            max={1}
            step={0.01}
            value={selected.crop.w}
            onChange={(w) => update({ crop: { ...selected.crop, w: Math.min(w, 1 - selected.crop.x) } })}
          />
          <NumField
            label="Высота"
            min={0.05}
            max={1}
            step={0.01}
            value={selected.crop.h}
            onChange={(h) => update({ crop: { ...selected.crop, h: Math.min(h, 1 - selected.crop.y) } })}
          />
          <div className="spd-hint">Обрезка задаётся в долях исходного изображения.</div>
        </div>
      ) : null}
    </>
  )
}

const GIF_FPS_PRESETS = [5, 10, 12.5, 20, 25, 50]

function pluralFrames(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'кадр'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'кадра'
  return 'кадров'
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2).replace('.', ',')
}

function gifBackgroundHint(project: Project): string {
  const hasVideo = !!project.background?.videoUrl
  const base = hasVideo
    ? ''
    : 'Видео-фона SPM нет: настройка влияет только на видео-фон, обычные GIF-слои не меняются. '
  const mode = project.export.gifBackground
  if (mode === 'slot') {
    return `${base}Кадры снимаются только вокруг витрины, пиксель в пиксель: фон в GIF не растягивается. За пределами витрины остаётся статичный постер.`
  }
  const side = Math.round(mode)
  return side >= 1920
    ? `${base}Полный кадр сохраняется в родном разрешении до 1920 px: фон резче, кадры занимают больше памяти.`
    : `${base}Видео-фон сжимается до ${side} px по длинной стороне: файл легче, фон в витрине мягче.`
}

/**
 * Actual frame size of the sampled SPM video. The picks are upper bounds, so a
 * small source stays at its own size; showing it makes a "nothing changed"
 * dropdown result explainable instead of mysterious.
 */
function gifSampleHint(
  project: Project,
  assets: AssetLibrary,
  state: EditorApi['videoCapture'],
): string | null {
  if (!project.background?.videoUrl) return null
  if (state === 'reading') return 'Пересчитываю кадры видео-фона под выбранное разрешение…'
  if (state === 'failed') {
    return 'Кадры видео-фона не удалось пересчитать — в GIF попадёт постер или прошлый размер.'
  }
  const captured = project.background.videoAssetId
    ? assets.get(project.background.videoAssetId)?.gif
    : null
  if (!captured || captured.frames.length < 2) return null
  const size = `${captured.width}×${captured.height}`
  if (typeof project.export.gifBackground === 'number') {
    const side = Math.round(project.export.gifBackground)
    return Math.max(captured.width, captured.height) < side
      ? `Сейчас кадры фона: ${size}. Видео не растягивается — исходник меньше ${side} px.`
      : `Сейчас кадры фона: ${size} — столько пикселей фона попадёт в GIF.`
  }
  return `Сейчас кадры фона: ${size} — область витрины снята 1:1.`
}

function gifFpsHint(project: Project, assets: AssetLibrary): string {
  const master = gifMaster(project, assets)
  if (!master.animation) return 'Анимации нет — GIF получится из одного кадра.'
  const warnings: string[] = []
  const timeline = buildGifTimeline(
    master.animation,
    project.export.gifFps,
    warnings,
    gifFrameLimit(project, master.animation.delays.length),
  )
  const count = timeline.delays.length
  const total = timeline.delays.reduce((sum, delay) => sum + delay, 0)
  const loop = `${count} ${pluralFrames(count)}, цикл ${formatSeconds(total)} с`
  const source = master.fromBackground ? 'фоном' : 'самым длинным GIF-слоем'
  const warning = warnings.length ? ` ${warnings[0]}` : ''
  if (project.export.gifFps > 0) {
    const step = timeline.delays[0] ?? 0
    return `${loop}, шаг ~${step} мс — синхронно с ${source}.${warning}`
  }
  const min = Math.min(...timeline.delays)
  const max = Math.max(...timeline.delays)
  const delays = min === max ? `${min} мс` : `${min}–${max} мс`
  return `${loop}, задержки ${delays} — как у ${master.fromBackground ? 'фона' : 'GIF-слоя'}.${warning}`
}

/** Frame-rate picker for GIF export, shared by the simple and full panels. */
function GifFpsField({ api }: { api: EditorApi }) {
  const project = api.project
  const master = gifMaster(project, api.assets)
  const sourceFrames = master.animation?.delays.length ?? 0
  const maxFrames = Math.max(1, Math.min(MAX_GIF_FRAMES, sourceFrames || 1))
  const frames =
    project.export.gifFrames > 0 ? Math.min(project.export.gifFrames, maxFrames) : maxFrames
  const setFrames = (value: number) => {
    const next = Math.max(1, Math.min(maxFrames, Math.round(value)))
    api.patchProject({
      export: {
        ...project.export,
        // The slider's maximum means "every source frame", so the project keeps
        // following a longer animation instead of freezing today's count.
        gifFrames: next >= maxFrames ? 0 : next,
      },
    })
  }
  const sampleHint = gifSampleHint(project, api.assets, api.videoCapture)

  return (
    <>
      <div className="spd-field">
        <span>Частота кадров</span>
        <select
          value={project.export.gifFps}
          onChange={(event) =>
            api.patchProject({ export: { ...project.export, gifFps: Number(event.target.value) } })
          }
        >
          <option value={0}>Как в фоне</option>
          {GIF_FPS_PRESETS.map((fps) => (
            <option key={fps} value={fps}>
              {String(fps).replace('.', ',')} кадр/с
            </option>
          ))}
        </select>
        <span />
      </div>
      {sourceFrames > 1 ? (
        <>
          <NumField
            label="Кадров в GIF"
            value={frames}
            min={1}
            max={maxFrames}
            onChange={setFrames}
          />
          <div className="spd-seg">
            <button
              type="button"
              className={project.export.gifFrames === 0 || frames >= maxFrames ? 'active' : ''}
              onClick={() =>
                api.patchProject({ export: { ...project.export, gifFrames: 0 } })
              }
            >
              Все ({maxFrames})
            </button>
            {maxFrames > 24 ? (
              <button
                type="button"
                className={project.export.gifFrames === 24 ? 'active' : ''}
                onClick={() =>
                  api.patchProject({ export: { ...project.export, gifFrames: 24 } })
                }
              >
                24 (качество)
              </button>
            ) : null}
          </div>
          <div className="spd-hint">
            В анимации {sourceFrames} {pluralFrames(sourceFrames)}. 1 — один статичный кадр,{' '}
            {maxFrames} — все; остальное пересчитывается равномерно по циклу.
            {sourceFrames > MAX_GIF_FRAMES
              ? ` Больше ${MAX_GIF_FRAMES} кадров за раз не кодируем, чтобы не подвесить браузер.`
              : ''}
          </div>
        </>
      ) : null}
      <div className="spd-field">
        <span>Фон в GIF</span>
        <select
          value={String(project.export.gifBackground)}
          onChange={(event) => {
            const raw = event.target.value
            api.patchProject({
              export: {
                ...project.export,
                gifBackground: raw === 'slot' ? 'slot' : Number(raw),
              },
            })
          }}
        >
          <option value="slot">Только витрина (1:1)</option>
          {[360, 480, 720, 960, 1080, 1440, 1920].map((side) => (
            <option key={side} value={side}>
              {side} px{side >= 1920 ? ' (как в видео)' : ''}
            </option>
          ))}
        </select>
        <span />
      </div>
      <div className="spd-hint">{gifBackgroundHint(project)}</div>
      {sampleHint ? <div className="spd-hint">{sampleHint}</div> : null}
      <div className="spd-hint">{gifFpsHint(project, api.assets)}</div>
      <Toggle
        checked={project.export.gifDelta}
        onChange={(value) =>
          api.patchProject({ export: { ...project.export, gifDelta: value } })
        }
        label="Использовать дельта-кадры"
      />
      <Toggle
        checked={project.export.gifReducePalette}
        onChange={(value) =>
          api.patchProject({ export: { ...project.export, gifReducePalette: value } })
        }
        label="Снижать палитру, чтобы влезть в 5 МБ"
      />
    </>
  )
}

export function SimplePanel({ api }: { api: EditorApi }) {
  const project = api.project
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [over, setOver] = useState(false)
  const layers = project.layers
  const selected = layers.find((layer) => layer.id === api.selection.layerId) ?? null
  const record = selected ? api.assets.get(selected.assetId) : undefined
  const animated = hasAnimatedLayers(project, api.assets) || hasVideoBackground(project)
  const gifOutput = animated || project.export.format === 'gif'
  const percent = api.progress
    ? Math.min(100, Math.round((api.progress.done / Math.max(1, api.progress.total)) * 100))
    : 0

  const baseW = selected && record ? record.meta.width * selected.crop.w : 0
  const baseH = selected && record ? record.meta.height * selected.crop.h : 0
  const outW = baseW > 0 && selected ? Math.round(baseW * selected.scale) : 0
  const outH = baseH > 0 && selected ? Math.round(baseH * selected.scale) : 0

  const setSize = (axis: 'w' | 'h', value: number) => {
    if (!selected) return
    const base = axis === 'w' ? baseW : baseH
    if (!base) return
    const scale = Math.min(30, Math.max(0.01, value / base))
    api.updateLayer({ ...selected, scale })
  }

  return (
    <div className="spd-simple">
      <div
        className={`spd-dropzone spd-simple-drop ${over ? 'over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          if (event.dataTransfer.files.length) void api.addArtFiles(event.dataTransfer.files)
        }}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <Icon name="image" size={24} />
        <div className="t">Перетащите картинку, GIF или видео</div>
        <div className="s">или нажмите, чтобы выбрать файл. Видео станет GIF-слоем.</div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void api.addArtFiles(event.target.files)
          event.target.value = ''
        }}
      />

      {layers.length ? (
        <div className="spd-card tight">
          <div className="spd-card-head">
            <span className="spd-title">На профиле</span>
            <span className="spd-badge">{layers.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...layers].reverse().map((layer) => {
              const item = api.assets.get(layer.assetId)
              return (
                <div
                  key={layer.id}
                  className={`spd-layer ${layer.id === api.selection.layerId ? 'selected' : ''}`}
                  onClick={() => api.selectLayer(layer.id)}
                >
                  <AssetImage api={api} assetId={layer.assetId} />
                  <span className="name">
                    {layer.name}
                    {item?.meta.kind === 'video' ? <span className="spd-badge accent">ВИДЕО</span> : null}
                    {item?.meta.kind !== 'video' && item?.gif && item.gif.frames.length > 1 ? (
                      <span className="spd-badge accent">GIF</span>
                    ) : null}
                    {layer.keying?.enabled ? <span className="spd-badge">БЕЗ ФОНА</span> : null}
                  </span>
                  <span className="acts" onClick={(event) => event.stopPropagation()}>
                    <button
                      title={layer.visible ? 'Скрыть' : 'Показать'}
                      onClick={() => api.updateLayer({ ...layer, visible: !layer.visible })}
                    >
                      <Icon name={layer.visible ? 'eye' : 'eyeOff'} size={14} />
                    </button>
                    <button title="Убрать с профиля" onClick={() => api.removeLayer(layer.id)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {selected ? (
        <div className="spd-card">
          <div className="spd-card-head">
            <span className="spd-title">Размер</span>
            <span className="spd-badge">
              {outW}×{outH} px
            </span>
          </div>
          <div className="spd-size-row">
            <label>
              <span>Ширина</span>
              <span className="unit">
                <input
                  type="number"
                  min={16}
                  max={6000}
                  value={outW}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && value > 0) setSize('w', value)
                  }}
                />
                px
              </span>
            </label>
            <label>
              <span>Высота</span>
              <span className="unit">
                <input
                  type="number"
                  min={16}
                  max={6000}
                  value={outH}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && value > 0) setSize('h', value)
                  }}
                />
                px
              </span>
            </label>
          </div>
          <div className="spd-row">
            <button style={{ flex: 1 }} onClick={() => api.addLayerToWindow(selected.id)}>
              <Icon name="target" /> Вписать в витрину
            </button>
            <button className="danger" onClick={() => api.removeLayer(selected.id)}>
              <Icon name="trash" /> Убрать
            </button>
          </div>

          <KeyingSection api={api} layer={selected} />
        </div>
      ) : layers.length ? (
        <div className="spd-hint">Выберите картинку в списке или на странице, чтобы задать её размер.</div>
      ) : null}

      <div className="spd-card">
        <div className="spd-title">Куда в профиле</div>
        <div className="spd-field">
          <span>Витрина</span>
          <select
            value={project.target}
            onChange={(event) => api.patchProject({ target: event.target.value as ShowcaseKind })}
          >
            {SHOWCASE_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {SHOWCASES[kind].title}
              </option>
            ))}
          </select>
          <span />
        </div>
        <NumField
          label="Высота витрины"
          min={80}
          max={2000}
          step={10}
          value={project.showcaseHeight}
          onChange={(showcaseHeight) => api.patchProject({ showcaseHeight })}
        />
        {api.page && api.page.anchors.length && !api.page.anchors.some((anchor) => anchor.kind === project.target) ? (
          <div className="spd-hint" style={{ color: '#e7a33e' }}>
            Эта витрина не найдена на странице. Добавьте её в профиль или выберите другую — экспорт использует
            положение по умолчанию.
          </div>
        ) : null}
        <div className="spd-hint">
          {api.page?.backgroundIsVideo
            ? api.videoCapture === 'reading'
              ? 'Читаю кадры видео-фона SPM…'
              : api.videoCapture === 'failed'
                ? 'Видео-фон SPM не удалось прочитать (чужой домен без CORS) — в файл попадёт постер, GIF будет без движения.'
                : 'SPM использует видео-фон: его кадры попадут в предпросмотр и в GIF.'
            : api.page?.backgroundUrl
              ? 'Фон профиля определён — он попадёт в готовый файл.'
              : 'Фон профиля не найден. Откройте свой профиль Steam, чтобы фон попал в файл.'}
        </div>
      </div>

      <div className="spd-card">
        <div className="spd-card-head">
          <span className="spd-title">Скачать</span>
          <span className="spd-badge accent">{gifOutput ? 'GIF' : 'PNG'}</span>
        </div>
        {animated ? (
          <div className="spd-hint">
            В сцене есть анимация (GIF или видео-фон SPM), поэтому файлы сохранятся как GIF.
          </div>
        ) : (
          <Segmented
            value={project.export.format}
            onChange={(format) => api.patchProject({ export: { ...project.export, format } })}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'gif', label: 'GIF' },
            ]}
          />
        )}
        {gifOutput ? <GifFpsField api={api} /> : null}
        <button
          className="primary spd-download"
          disabled={!!api.busy}
          onClick={() => void api.exportNow(true)}
        >
          <Icon name={api.busy ? 'refresh' : 'download'} />
          {api.busy ?? 'Скачать для Steam'}
        </button>
        {api.progress ? (
          <div>
            <div className="spd-row between">
              <span className="spd-hint">{api.progress.label}</span>
              <span className="spd-hint">{percent}%</span>
            </div>
            <div className="spd-progress">
              <div style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function PreviewPanel({ api }: { api: EditorApi }) {
  const project = api.project
  const showcase = SHOWCASES[project.target]
  const live = api.surface === 'overlay'
  const anchor = live && api.page ? api.page.anchors.find((a) => a.kind === project.target) : null
  const hasTarget = !!anchor

  return (
    <>
      <div className="spd-card">
        <div className="spd-title">Витрина</div>
        <div className="spd-field">
          <span>Тип</span>
          <select
            value={project.target}
            onChange={(event) => api.patchProject({ target: event.target.value as ShowcaseKind })}
          >
            {SHOWCASE_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {SHOWCASES[kind].title} · {SHOWCASES[kind].width} px
              </option>
            ))}
          </select>
          <span />
        </div>
        <NumField
          label="Высота"
          min={80}
          max={1600}
          step={10}
          value={project.showcaseHeight}
          onChange={(showcaseHeight) => api.patchProject({ showcaseHeight })}
        />
        <div className="spd-hint">
          Итоговый файл: {showcase.slices.map((s) => `${Math.round(s.width * project.export.scale)}×${Math.round(project.showcaseHeight * project.export.scale)}`).join(' + ')} px.
          Steam покажет его шириной {showcase.width} px.
        </div>
      </div>

      <div className="spd-card">
        <div className="spd-card-head">
          <span className="spd-title">Предпросмотр на странице</span>
          <Toggle label="" checked={api.previewOn} onChange={api.setPreviewOn} disabled={!live} />
        </div>
        <div className="spd-hint">
          {!live
            ? 'Живой предпросмотр работает в панели расширения поверх страницы Steam. Откройте свой профиль и нажмите кнопку расширения — проект подхватится автоматически. Студия нужна для точной настройки холста.'
            : api.page
              ? hasTarget
                ? `Найдена витрина «${SHOWCASES[project.target].title}» на странице. Композиция наложена на её место.`
                : 'Такой витрины на странице нет — показываю на месте первой витрины левой колонки.'
              : 'Предпросмотр на странице доступен, когда расширение открыто на профиле Steam.'}
        </div>
        <div className="spd-grid-2">
          <button
            disabled={!live || !api.previewOn}
            onPointerDown={() => api.setCompare(true)}
            onPointerUp={() => api.setCompare(false)}
            onPointerLeave={() => api.setCompare(false)}
            title="Удерживайте, чтобы увидеть профиль без композиции"
          >
            <Icon name="eyeOff" /> Сравнить
          </button>
          <button onClick={() => api.hideUi()} disabled={!live} title="Скрыть панель, оставив композицию на странице">
            <Icon name="expand" /> Скрыть интерфейс
          </button>
        </div>
        <Toggle
          label="Перетаскивать картинку прямо на странице"
          hint="Колесо мыши меняет масштаб слоя под курсором"
          checked={api.editableOnPage}
          onChange={api.setEditableOnPage}
          disabled={!live}
        />
        <Toggle
          label="Подменить фон страницы выбранным"
          hint="Нужно, если выбранный фон ещё не стоит в профиле. Настоящий профиль не меняется."
          checked={project.previewBackground}
          onChange={(previewBackground) => api.patchProject({ previewBackground })}
        />
        <button onClick={api.refreshPage} disabled={!live}>
          <Icon name="refresh" /> Обновить разметку
        </button>
      </div>

      {live ? (
        <div className="spd-card">
          <div className="spd-title">Что найдено на странице</div>
          <div className="spd-row between">
            <span className="spd-hint">Фон</span>
            <span className="spd-badge">
              {api.page?.backgroundIsVideo ? 'видео SPM' : api.page?.backgroundUrl ? 'определён' : 'нет'}
            </span>
          </div>
          <div className="spd-row between">
            <span className="spd-hint">Витрин в левой колонке</span>
            <span className="spd-badge">{api.page?.anchors.length ?? 0}</span>
          </div>
          <div className="spd-row between">
            <span className="spd-hint">Масштаб страницы</span>
            <span className="spd-badge">{api.page ? api.page.scale.toFixed(2) : '—'}×</span>
          </div>
          <div className="spd-row between">
            <span className="spd-hint">Steam Profile Modifier</span>
            <span className={`spd-badge ${api.page?.spmDetected ? 'green' : ''}`}>
              {api.page?.spmDetected ? 'обнаружен, совместимо' : 'не обнаружен'}
            </span>
          </div>
          {api.page?.spmDetected ? (
            <div className="spd-hint">
              Мы читаем только итоговый фон страницы, поэтому оформление из Steam Profile Modifier остаётся
              основой предпросмотра. Чужой интерфейс не изменяется.
            </div>
          ) : null}
          {(api.page?.backgroundUrl || api.page?.backgroundVideo?.currentSrc) ? (
            <div className="spd-hint" style={{ wordBreak: 'break-all' }}>
              {(api.page.backgroundUrl || api.page.backgroundVideo?.currentSrc || '').replace(/^https?:\/\//, '').slice(0, 90)}…
            </div>
          ) : null}
        </div>
      ) : (
        <div className="spd-card">
          <div className="spd-title">Студия и профиль</div>
          <div className="spd-hint">
            Здесь вы настраиваете холст, окно и картинку. Чтобы увидеть результат на настоящей странице, откройте
            свой профиль steamcommunity.com и нажмите кнопку расширения на панели Chrome.
          </div>
          {api.page?.steamId ? (
            <div className="spd-row between">
              <span className="spd-hint">SteamID</span>
              <span className="spd-badge">{api.page.steamId}</span>
            </div>
          ) : null}
        </div>
      )}
    </>
  )
}

export function ExportPanel({ api }: { api: EditorApi }) {
  const project = api.project
  const parts = planSlices(project)
  const animated = hasAnimatedLayers(project, api.assets) || hasVideoBackground(project)
  const gif = animated || project.export.format === 'gif'
  const files = api.exportFiles
  const [showAll, setShowAll] = useState(false)
  const percent = api.progress
    ? Math.min(100, Math.round((api.progress.done / Math.max(1, api.progress.total)) * 100))
    : 0

  return (
    <>
      <div className="spd-card">
        <div className="spd-title">Формат</div>
        {animated ? (
          <div className="spd-hint">
            В сцене есть анимация (GIF или видео-фон SPM) — экспорт всегда будет GIF, чтобы сохранить движение.
          </div>
        ) : (
          <Segmented
            value={project.export.format}
            onChange={(format) => api.patchProject({ export: { ...project.export, format } })}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'gif', label: 'GIF', title: 'Один кадр, если анимации нет' },
            ]}
          />
        )}

        <div className="spd-field">
          <span>Масштаб</span>
          <div className="spd-seg">
            {[1, 2].map((scale) => (
              <button
                key={scale}
                type="button"
                className={project.export.scale === scale ? 'active' : ''}
                onClick={() => api.patchProject({ export: { ...project.export, scale } })}
              >
                {scale}×
              </button>
            ))}
          </div>
          <span />
        </div>
        <div className="spd-hint">
          2× даёт более резкие края картинки и анимации на HiDPI-экранах. Фон Steam имеет ширину 1920 px,
          поэтому детализация самого фона выше не станет.
        </div>

        {gif ? (
          <>
            <div className="spd-field">
              <span>Цветов</span>
              <select
                value={project.export.gifColors}
                onChange={(event) => api.patchProject({ export: { ...project.export, gifColors: Number(event.target.value) } })}
              >
                {[256, 192, 128, 96, 64].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span />
            </div>
            <Toggle
              label="Дизеринг"
              hint="Мелкая сетка вместо полос на плавных переходах, файл чуть больше"
              checked={project.export.gifDither}
              onChange={(gifDither) => api.patchProject({ export: { ...project.export, gifDither } })}
            />
            <GifFpsField api={api} />
            <div className="spd-hint">
              «Дельта-кадры» и «Снижать палитру» включаются отдельно и по умолчанию выключены.
              Если файл больше 5 МБ, включите снижение палитры или уменьшите высоту витрины и масштаб.
            </div>
          </>
        ) : null}

        <Toggle
          label="Сохранить фон с прозрачным окном отдельно"
          hint="PNG 1920 px с дырой, без картинки — для ручной сборки"
          checked={project.export.savePlate}
          onChange={(savePlate) => api.patchProject({ export: { ...project.export, savePlate } })}
        />
      </div>

      <div className="spd-card">
        <div className="spd-card-head">
          <span className="spd-title">Что получится</span>
          <span className="spd-badge">{formatBytes(project.export.maxBytes)} лимит</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {parts.map((part) => (
            <div className="spd-file-row" key={part.id}>
              <Icon name="image" size={13} />
              <span className="nm">
                {part.fileName}.{gif ? 'gif' : 'png'}
              </span>
              <span className="spd-badge">
                {part.outWidth}×{part.outHeight}
              </span>
            </div>
          ))}
          {project.export.savePlate ? (
            <div className="spd-file-row">
              <Icon name="layers" size={13} />
              <span className="nm">background_cutout.png</span>
              <span className="spd-badge">1920×{project.canvasHeight}</span>
            </div>
          ) : null}
        </div>
        <button className="primary" disabled={!!api.busy} onClick={() => void api.exportNow(true)}>
          <Icon name="download" /> Скачать ZIP
        </button>
        <div className="spd-grid-2">
          <button disabled={!!api.busy} onClick={() => void api.exportNow(false)}>
            <Icon name="play" /> Сформировать
          </button>
          <button onClick={api.openUploadPage}>
            <Icon name="external" /> Страница Steam
          </button>
        </div>
        {api.progress ? (
          <div>
            <div className="spd-row between">
              <span className="spd-hint">{api.progress.label}</span>
              <span className="spd-hint">{percent}%</span>
            </div>
            <div className="spd-progress">
              <div style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}
        <div className="spd-hint">
          Всё считается в браузере. Публикация в Steam не выполняется — файлы только скачиваются.
        </div>
      </div>

      {files?.length ? (
        <div className="spd-card">
          <div className="spd-card-head">
            <span className="spd-title">Готовые файлы</span>
            <span className="spd-badge green">{files.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {(showAll ? files : files.slice(0, 6)).map((file) => (
              <div className="spd-file-row" key={file.name}>
                <Icon name={file.frames > 1 ? 'play' : 'image'} size={13} />
                <span className="nm">{file.name}</span>
                <span className="spd-badge">{formatBytes(file.bytes)}</span>
                <button className="icon ghost" title="Скачать файл" onClick={() => api.downloadFile(file)}>
                  <Icon name="download" size={14} />
                </button>
              </div>
            ))}
            {files.length > 6 && !showAll ? (
              <button className="ghost" onClick={() => setShowAll(true)}>
                Показать все ({files.length})
              </button>
            ) : null}
          </div>
          {api.exportWarnings.length ? (
            <div className="spd-hint spd-warn-text">{api.exportWarnings.map((w) => `• ${w}`).join('\n')}</div>
          ) : null}
        </div>
      ) : null}

      <div className="spd-card">
        <div className="spd-card-head">
          <span className="spd-title">Проверка</span>
          <button onClick={() => void api.selfTest()} disabled={!!api.busy}>
            <Icon name="sparkle" /> Проверить пайплайн
          </button>
        </div>
        {api.selfTestResult ? (
          <div className="spd-hint" style={{ whiteSpace: 'pre-line' }}>
            {api.selfTestResult.lines.join('\n')}
          </div>
        ) : (
          <div className="spd-hint">
            Прогоняет отрисовку, прозрачность и GIF-кодирование на маленьком тестовом кадре и показывает время.
          </div>
        )}
      </div>

      <div className="spd-card">
        <div className="spd-title">Установка</div>
        <ol className="spd-list">
          <li>Нажмите «Скачать ZIP» — внутри части витрины и README.</li>
          <li>Откройте страницу загрузки иллюстрации Steam.</li>
          <li>Выберите файл: помощник сам подставит витрину и поля по имени файла.</li>
          <li>Добавьте витрину в профиль и выберите работу.</li>
        </ol>
        <div className="spd-hint">
          Лимит Steam — 5 МБ на файл. Настоящий фон профиля не изменяется: вы ставите только витрину.
        </div>
        <a className="spd-link" href={UPLOAD_PAGE} target="_blank" rel="noreferrer">
          steamcommunity.com/sharedfiles/edititem/767/3/
        </a>
      </div>
    </>
  )
}
