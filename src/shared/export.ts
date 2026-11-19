import JSZip from 'jszip'
import type { Project, ProjectSlot } from './types'
import type { AssetLibrary } from './assets'
import { SHOWCASES, formatBytes, planSlices, projectSlotRect } from './geometry'
import { CompositionRenderer, backgroundAnimation, hasAnimatedLayers, hasVideoBackground } from './render'
import { encodeGif } from './gif-encode'

export interface ExportedFile {
  name: string
  blob: Blob
  width: number
  height: number
  bytes: number
  frames: number
  kind: 'showcase' | 'plate'
}

export interface ExportResult {
  files: ExportedFile[]
  zip: Blob
  warnings: string[]
  format: 'png' | 'gif'
  totalBytes: number
}

export interface ExportProgress {
  label: string
  done: number
  total: number
}

export interface ExportOptions {
  /**
   * Measured origin of the target showcase on the live page. It is passed in
   * per export instead of being stored in the project, so a background change
   * on the page can never drag the composition around.
   */
  slot?: ProjectSlot
}

/**
 * Hard ceiling for the number of exported GIF frames. A 2× 1260×840 frame costs
 * several megabytes of canvas work, and the encoder retries with smaller
 * palettes, so hundreds of frames would freeze the tab instead of exporting.
 */
export const MAX_GIF_FRAMES = 120

/**
 * Frames the timeline may use: the user's explicit choice (`gifFrames`), never
 * more than the animation actually has and never above the safety ceiling.
 */
export function gifFrameLimit(project: Project, sourceFrames = MAX_GIF_FRAMES): number {
  const chosen = project.export.gifFrames
  const wanted = chosen > 0 ? Math.round(chosen) : MAX_GIF_FRAMES
  return Math.max(1, Math.min(MAX_GIF_FRAMES, wanted, Math.max(1, Math.round(sourceFrames))))
}

export interface GifTimeline {
  delays: number[]
  times: number[]
}

function cumulativeTimes(delays: number[]): number[] {
  const times: number[] = []
  let at = 0
  for (const delay of delays) {
    times.push(at)
    at += delay
  }
  return times
}

/**
 * Evenly spaced delays that cover exactly `duration`, stretching only the last
 * frame. `step` is rounded to GIF's 10 ms clock.
 */
function uniformDelays(duration: number, step: number): number[] {
  const safeStep = Math.max(20, Math.round(step / 10) * 10)
  const count = Math.max(1, Math.round(duration / safeStep))
  const delays = new Array<number>(count).fill(safeStep)
  const last = duration - safeStep * (count - 1)
  if (last >= 20) {
    delays[count - 1] = last
  } else if (count > 1) {
    delays.pop()
    delays[delays.length - 1] = duration - safeStep * (delays.length - 1)
  } else {
    delays[0] = Math.max(20, duration)
  }
  return delays
}

/**
 * Timeline for the exported GIF.
 *
 * GIF stores frame delays in centiseconds, so a 124 ms source frame really
 * leaves as 120 ms. Quantizing every delay on its own quietly shortens the loop
 * (20 × 124 → 20 × 120 = 2400 ms instead of 2480 ms) and the animation drifts
 * against the background. Delays are therefore quantized cumulatively: each
 * frame lands on the nearest 10 ms mark, errors cancel out, and the whole loop
 * still lasts one source cycle.
 *
 * `fps > 0` rebuilds the animation at a uniform rate, always covering exactly
 * that same cycle. Frame N is sampled at N × step, so the background restarts
 * together with the GIF instead of drifting.
 *
 * `maxFrames` is the caller's frame budget: every source frame when it is 0/"all",
 * otherwise the timeline is resampled evenly to exactly that many frames so the
 * loop length never changes.
 */
export function buildGifTimeline(
  master: { delays: number[]; duration: number } | null,
  fps: number,
  warnings: string[] = [],
  maxFrames = MAX_GIF_FRAMES,
): GifTimeline {
  if (!master || master.duration <= 0 || !master.delays.length) {
    return { delays: [100], times: [0] }
  }
  // The GIF clock is centiseconds; align the target loop to it up front.
  const duration = Math.max(20, Math.round(master.duration / 10) * 10)
  const limit = Math.max(1, Math.round(maxFrames))

  if (!(fps > 0)) {
    const source = cumulativeTimes(master.delays)
    const delays: number[] = []
    let at = 0
    for (let index = 0; index < master.delays.length; index += 1) {
      const target = index === master.delays.length - 1 ? duration : Math.round(source[index + 1]! / 10) * 10
      const step = target - at
      // 20 ms is GIF's minimum delay. Frames faster than that (e.g. a 60 fps
      // video) are merged into the following frame instead of being slowed
      // down, which would make the loop longer than the background.
      if (step >= 20) {
        delays.push(step)
        at = target
      }
    }
    if (at < duration) {
      if (delays.length) delays[delays.length - 1] += duration - at
      else delays.push(Math.max(20, duration))
    }
    const sum = delays.reduce((value, delay) => value + delay, 0)
    if (sum !== duration) {
      warnings.push('Цикл короче 20 мс — GIF не умеет такие задержки, поэтому анимация замедлена.')
    }
    if (delays.length > limit) {
      // The quality mode deliberately spends the frame budget on colours
      // instead of motion. The safety cap (no quality mode) does the same, but
      // says so, because the user did not ask for that trade-off.
      const resampled = uniformDelays(duration, Math.ceil(duration / limit / 10) * 10)
      if (limit === MAX_GIF_FRAMES) {
        warnings.push(
          `В анимации было ${delays.length} кадров — оставили ${resampled.length}, чтобы не подвесить браузер.`,
        )
      }
      return { delays: resampled, times: cumulativeTimes(resampled) }
    }
    return { delays, times: cumulativeTimes(delays) }
  }

  let step = Math.max(20, Math.round(100 / fps) * 10)
  if (Math.max(1, Math.round(duration / step)) > limit) {
    step = Math.max(step, Math.ceil(duration / limit / 10) * 10)
    if (limit === MAX_GIF_FRAMES) {
      warnings.push(
        `Частота снижена до ${(1000 / step).toFixed(1)} кадр/с: при ${fps} кадр/с анимация ` +
          `${(duration / 1000).toFixed(1)} с дала бы больше ${limit} кадров.`,
      )
    }
  }
  const delays = uniformDelays(duration, step)
  return { delays, times: cumulativeTimes(delays) }
}

export interface GifMaster {
  /** Animation that drives the loop: the background, else the longest GIF layer. */
  animation: { delays: number[]; duration: number } | null
  /** True when the animated background itself drives the loop. */
  fromBackground: boolean
  /** Longest visible GIF layer, kept for the drift warning. */
  longestLayer: { delays: number[]; duration: number } | null
}

/**
 * Pick the animation that defines the export loop.
 *
 * The animated background always wins: a GIF that runs longer or shorter than
 * the background visibly drifts out of sync. Only when the background is still
 * does the longest visible GIF layer set the pace.
 */
export function gifMaster(project: Project, assets: AssetLibrary): GifMaster {
  const background = backgroundAnimation(project, assets)
  let longestLayer: { delays: number[]; duration: number } | null = null
  for (const layer of project.layers) {
    if (!layer.visible) continue
    const record = assets.get(layer.assetId)
    if (!record?.gif || record.gif.frames.length < 2) continue
    const candidate = { delays: record.gif.frames.map((f) => f.delay), duration: record.gif.duration }
    if (!longestLayer || candidate.duration > longestLayer.duration) longestLayer = candidate
  }
  if (background) {
    return {
      animation: { delays: background.frames.map((f) => f.delay), duration: background.duration },
      fromBackground: true,
      longestLayer,
    }
  }
  return { animation: longestLayer, fromBackground: false, longestLayer }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(
                new Error(
                  'Не удалось закодировать изображение. Возможно, в сцене есть картинка с чужого сайта без CORS — загрузите её файлом.',
                ),
              ),
        type,
        quality,
      )
    } catch {
      reject(
        new Error(
          'Браузер запретил сохранить холст: в сцене есть изображение с чужого сайта без CORS. Загрузите его файлом.',
        ),
      )
    }
  })
}

function readme(
  project: Project,
  files: ExportedFile[],
  warnings: string[],
  format: 'png' | 'gif',
  gifInfo: {
    fps: number
    frames: number
    duration: number
    fromBackground: boolean
    sourceFrames: number
    framesRequested: number
    delta: boolean
    reducePalette: boolean
    background: 'slot' | number
  } | null,
): string {
  const showcase = SHOWCASES[project.target]
  const lines: string[] = []
  lines.push('Steam Profile Designer — готовый комплект')
  lines.push('=======================================')
  lines.push('')
  lines.push(`Проект: ${project.name}`)
  lines.push(`Витрина: ${showcase.title} (${showcase.uploadName})`)
  lines.push(`Размер витрины в профиле: ${showcase.width}×${project.showcaseHeight} px`)
  lines.push(`Формат: ${format.toUpperCase()}, масштаб ${project.export.scale}×`)
  if (format === 'gif' && gifInfo) {
    if (gifInfo.frames <= 1) {
      lines.push('Анимация: нет — GIF состоит из одного кадра.')
    } else {
      const rate =
        gifInfo.fps > 0
          ? `${String(gifInfo.fps).replace('.', ',')} кадр/с`
          : gifInfo.fromBackground
            ? 'как в фоне'
            : 'как в GIF-слое'
      lines.push(
        `Анимация: ${rate}, ${gifInfo.frames} кадров, цикл ${(gifInfo.duration / 1000).toFixed(2).replace('.', ',')} с.`,
      )
      lines.push(
        gifInfo.fromBackground
          ? 'Цикл совпадает с анимированным фоном — на странице GIF не разъезжается с ним.'
          : 'Цикл совпадает с самым длинным GIF-слоем.',
      )
      lines.push(
        gifInfo.framesRequested > 0 && gifInfo.framesRequested < gifInfo.sourceFrames
          ? `Кадры: выбрано ${gifInfo.framesRequested} из ${gifInfo.sourceFrames} — остальные пересчитаны равномерно по циклу.`
          : gifInfo.frames < gifInfo.sourceFrames
            ? `Кадры: ${gifInfo.frames} из ${gifInfo.sourceFrames} исходных — лишние убраны для скорости.`
            : `Кадры: все ${gifInfo.frames} исходных.`,
      )
      lines.push(
        gifInfo.delta
          ? 'Дельта-кадры: включены — неизменившиеся пиксели не перерисовываются, палитра общая для всех кадров, файл меньше.'
          : 'Дельта-кадры: выключены — каждый кадр записан полностью.',
      )
      lines.push(
        gifInfo.reducePalette
          ? 'Снижение палитры: включено — при превышении 5 МБ число цветов уменьшается автоматически.'
          : 'Снижение палитры: выключено — палитра не уменьшается, файл может превысить 5 МБ.',
      )
      lines.push(
        typeof gifInfo.background === 'number'
          ? gifInfo.background >= 1920
            ? 'Видео-фон: полный кадр до 1920 px — детализация фона как в источнике.'
            : `Видео-фон: сжат до ${gifInfo.background} px по длинной стороне — файл легче, фон мягче.`
          : 'Видео-фон: снят только вокруг витрины, 1:1 — фон в GIF без растяжения.',
      )
    }
  }
  lines.push('')
  lines.push('Что загружать:')
  for (const file of files) {
    if (file.kind !== 'showcase') continue
    lines.push(`  ${file.name} — ${file.width}×${file.height} px (${formatBytes(file.bytes)})`)
  }
  if (files.some((f) => f.kind === 'plate')) {
    lines.push('')
    lines.push('background_cutout.png — фон с прозрачным окном без вашей картинки. Нужен только если вы')
    lines.push('хотите собрать слои вручную или использовать фон отдельно.')
  }
  lines.push('')
  lines.push('Как установить:')
  lines.push('1. Откройте https://steamcommunity.com/sharedfiles/edititem/767/3/')
  lines.push('2. Выберите файл. Помощник загрузки (расширение) сам подставит нужную витрину по имени файла.')
  lines.push(`3. В профиле добавьте витрину «${showcase.uploadName}» и выберите загруженную работу.`)
  lines.push('4. Фон профиля оставьте тем, который вы выбрали в редакторе — он не изменяется.')
  lines.push('')
  lines.push('Подсказки для окна загрузки (консоль браузера):')
  lines.push('  Используйте сочетание клавиш Ctrl+Shift+I или F12, чтобы открыть консоль.')
  lines.push('')
  lines.push('  Иллюстрации (artwork) — https://vsthemes.org/steam/artwork/75860-detailing-master.html')
  lines.push('  Введите код при загрузке КАЖДОЙ (!) картинки (загружать штучно, по отдельности):')
  lines.push("  $J('#image_width').val(1000).attr('id',''),$J('#image_height').val(1).attr('id','');")
  lines.push('  Затем нажмите Enter.')
  lines.push('  Если видите ошибку — выполните требования, которые там указаны. Зачастую необходимо')
  lines.push('  вручную напечатать «разрешить вставку», а затем повторно использовать код.')
  lines.push('')
  lines.push('  Мастерская (workshop) — https://vsthemes.org/steam/workshop/76116-resize-dark-background.html')
  lines.push('  Аналогично, для каждой картинки по отдельности:')
  lines.push("  $J('[name=consumer_app_id]').val(480);$J('[name=file_type]').val(0);$J('[name=visibility]').val(0);")
  lines.push('  Затем нажмите Enter. То же правило про ошибку и «разрешить вставку».')
  lines.push('')
  lines.push('  К каждой витрине — свой код: используйте фрагмент, который относится к её окну загрузки.')
  lines.push('')
  lines.push('Ограничения Steam:')
  lines.push(`  • файл иллюстрации не больше 5 МБ (наш лимит ${formatBytes(project.export.maxBytes)})`)
  lines.push('  • GIF с прозрачностью Steam иногда пережимает; помощник загрузки применяет hex-патч трейлера')
  lines.push('  • порядок витрин в профиле задаётся в «Редактировать профиль → Витрины»')
  lines.push('')
  if (warnings.length) {
    lines.push('Предупреждения:')
    warnings.forEach((w) => lines.push(`  • ${w}`))
    lines.push('')
  }
  lines.push('Всё посчитано локально в браузере. Ни один файл не отправлялся на сервер.')
  return lines.join('\n')
}

/**
 * Render every showcase part, encode PNG/GIF, and pack a ready-to-upload zip.
 * All pixel work happens on the user's machine.
 */
export async function exportProject(
  project: Project,
  assets: AssetLibrary,
  onProgress?: (progress: ExportProgress) => void,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const renderer = new CompositionRenderer(project, assets)
  const parts = planSlices(project, options.slot)
  const warnings: string[] = []
  const files: ExportedFile[] = []
  const scale = project.export.scale
  const animated = hasAnimatedLayers(project, assets)
  const videoBackground = hasVideoBackground(project)
  const wantsAnimation = animated || videoBackground
  // An animated scene always leaves as GIF. Falling back to PNG made the user
  // receive a silent still frame even though the page was moving.
  let format: 'png' | 'gif' = wantsAnimation ? 'gif' : project.export.format

  if (wantsAnimation && project.export.format === 'png') {
    warnings.push('В сцене есть анимация (GIF или видео-фон SPM), поэтому сохранён GIF, а не PNG.')
  }
  if (
    project.background?.source === 'profile' &&
    project.background.videoUrl &&
    !(project.background.videoAssetId && assets.get(project.background.videoAssetId)?.gif)
  ) {
    warnings.push(
      'Кадры видео-фона не удалось прочитать (CORS), поэтому в GIF попал постер без движения.',
    )
  }
  if (!renderer.ready) {
    warnings.push('Фон ещё не загрузился: части могут быть прозрачными. Подождите пару секунд и повторите экспорт.')
  }
  // Exporting with no art is allowed on purpose: it produces the background
  // slice (and the cutout plate) so a background can be prepared separately.
  // Say it out loud so nobody wonders where the picture went.
  if (!project.background) {
    warnings.push('Фон страницы не выбран: файлы получатся прозрачными.')
  }
  if (!project.layers.some((layer) => layer.visible)) {
    warnings.push(
      'В сцене нет видимых картинок: файлы содержат только фон витрины' +
        (project.export.savePlate ? ' и фон с прозрачным окном.' : '.'),
    )
  }

  const slotRect = projectSlotRect(project, options.slot)
  const slot = { x: slotRect.x, y: slotRect.y, w: SHOWCASES[project.target].width, h: project.showcaseHeight }

  // The `slot` background mode samples only the area around the showcase. If the
  // measured page moved the slot outside that area, the export would silently
  // mix poster pixels into the animation, so say it out loud.
  if (format === 'gif' && project.export.gifBackground === 'slot') {
    const region = project.background?.videoAssetId
      ? assets.get(project.background.videoAssetId)?.gif?.region
      : undefined
    const outside =
      !!region &&
      parts.some(
        (part) =>
          part.rect.x < region.x ||
          part.rect.y < region.y ||
          part.rect.x + part.rect.w > region.x + region.w ||
          part.rect.y + part.rect.h > region.y + region.h,
      )
    if (outside) {
      warnings.push(
        'Витрина сместилась за область захвата видео-фона: часть фона в GIF останется статичной. Обновите страницу или выберите «Полный кадр».',
      )
    }
  }
  for (const cutout of project.cutouts) {
    if (!cutout.enabled) continue
    if (
      cutout.x < slot.x ||
      cutout.y < slot.y ||
      cutout.x + cutout.w > slot.x + slot.w ||
      cutout.y + cutout.h > slot.y + slot.h
    ) {
      warnings.push('Прозрачная область выходит за границы витрины — за пределами витрины она не сохранится.')
      break
    }
  }

  // Animation timeline: the animated background defines the loop, because a GIF
  // that runs longer or shorter than the background visibly drifts out of sync.
  // A still background falls back to the longest visible GIF layer. A GIF
  // request on a still scene still produces a one-frame GIF instead of quietly
  // switching to PNG.
  let delays: number[] = []
  let times: number[] = []
  let gifInfo: {
    fps: number
    frames: number
    duration: number
    fromBackground: boolean
    sourceFrames: number
    framesRequested: number
    delta: boolean
    reducePalette: boolean
    background: 'slot' | number
  } | null = null
  if (format === 'gif') {
    const master = gifMaster(project, assets)
    const sourceFrames = master.animation?.delays.length ?? 1
    if (
      master.fromBackground &&
      master.longestLayer &&
      master.animation &&
      master.longestLayer.duration > master.animation.duration + 10
    ) {
      warnings.push('GIF-слой длиннее анимированного фона — цикл подстроен под фон, чтобы кадры не разъезжались.')
    }
    const timeline = buildGifTimeline(
      master.animation,
      project.export.gifFps,
      warnings,
      gifFrameLimit(project, sourceFrames),
    )
    delays = timeline.delays
    times = timeline.times
    gifInfo = {
      fps: project.export.gifFps,
      frames: delays.length,
      duration: delays.reduce((sum, delay) => sum + delay, 0),
      fromBackground: master.fromBackground,
      sourceFrames,
      framesRequested: project.export.gifFrames,
      delta: project.export.gifDelta,
      reducePalette: project.export.gifReducePalette,
      background: project.export.gifBackground,
    }
  }

  const totalSteps = format === 'gif' ? parts.length * delays.length : parts.length
  let done = 0
  let deltaDisabled = false

  for (const [index, part] of parts.entries()) {
    const fileBase = part.fileName
    if (format === 'png') {
      const canvas = renderer.renderView(part.rect, scale, 0)
      const blob = await canvasToBlob(canvas, 'image/png')
      files.push({
        name: `${fileBase}.png`,
        blob,
        width: canvas.width,
        height: canvas.height,
        bytes: blob.size,
        frames: 1,
        kind: 'showcase',
      })
      done += 1
      onProgress?.({ label: `Часть ${index + 1} из ${parts.length}`, done, total: totalSteps })
      continue
    }

    const encoded = await encodeGif({
      width: part.outWidth,
      height: part.outHeight,
      delays,
      colors: project.export.gifColors,
      dither: project.export.gifDither,
      useDelta: project.export.gifDelta,
      reducePalette: project.export.gifReducePalette,
      maxBytes: project.export.maxBytes / Math.max(1, parts.length),
      onProgress: (partDone, partTotal) => {
        const fraction = partTotal > 0 ? Math.min(1, partDone / partTotal) : 0
        onProgress?.({
          label: `GIF, часть ${index + 1} из ${parts.length}`,
          done: done + fraction * delays.length,
          total: totalSteps,
        })
      },
      renderFrame: (frame) => renderer.renderView(part.rect, scale, times[frame] ?? 0),
    })
    done += delays.length
    onProgress?.({ label: `Часть ${index + 1} из ${parts.length}`, done, total: totalSteps })

    if (project.export.gifDelta && !encoded.delta && !deltaDisabled) {
      deltaDisabled = true
      warnings.push(
        'Дельта-кадры отключены: прозрачные области меняются между кадрами, поэтому каждый кадр записан полностью.',
      )
    }
    if (gifInfo && !encoded.delta) gifInfo.delta = false

    if (encoded.tooBig) {
      warnings.push(
        `Файл ${fileBase}.gif получился ${formatBytes(encoded.bytes.length)} — больше лимита Steam. ` +
          (project.export.gifReducePalette
            ? 'Уменьшите высоту витрины, масштаб или число цветов.'
            : 'Включите «Снижать палитру» или уменьшите высоту витрины и масштаб.'),
      )
    }
    const blob = new Blob([encoded.bytes as unknown as BlobPart], { type: 'image/gif' })
    files.push({
      name: `${fileBase}.gif`,
      blob,
      width: part.outWidth,
      height: part.outHeight,
      bytes: blob.size,
      frames: delays.length,
      kind: 'showcase',
    })
  }

  if (project.export.savePlate) {
    onProgress?.({ label: 'Фон с прозрачным окном', done: totalSteps, total: totalSteps + 1 })
    const canvas = renderer.renderFull(1, 0, false)
    const blob = await canvasToBlob(canvas, 'image/png')
    files.push({
      name: 'background_cutout.png',
      blob,
      width: canvas.width,
      height: canvas.height,
      bytes: blob.size,
      frames: 1,
      kind: 'plate',
    })
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const manifest = {
    generator: 'Steam Profile Designer',
    project: project.name,
    showcase: project.target,
    showcaseTitle: SHOWCASES[project.target].title,
    slot: { width: SHOWCASES[project.target].width, height: project.showcaseHeight },
    format,
    scale,
    gif: gifInfo,
    files: files.map((file) => ({
      name: file.name,
      kind: file.kind,
      width: file.width,
      height: file.height,
      frames: file.frames,
      bytes: file.bytes,
      uploadMode: file.kind === 'showcase' ? project.target : null,
    })),
    warnings,
  }

  const zip = new JSZip()
  for (const file of files) zip.file(file.name, file.blob)
  zip.file('README.txt', readme(project, files, warnings, format, gifInfo))
  zip.file('files.json', JSON.stringify(manifest, null, 2))
  const zipBlob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    // JSZip reports its own percentage, so the bar keeps moving while the
    // archive is compressed instead of sitting at 100 %.
    (metadata) => onProgress?.({ label: 'Упаковываю ZIP', done: metadata.percent, total: 100 }),
  )

  return { files, zip: zipBlob, warnings, format, totalBytes: zipBlob.size }
}

/** Save a blob through an anchor; works in both content scripts and extension pages. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'steam-profile'
  )
}
