import type { GifAsset, GifProgress } from './gif-decode'
import { captureVideoUrl } from './steam/video-frames'
import { sniffVideoMime } from './net'

// ---------------------------------------------------------------------------
// Video as a layer.
//
// Steam itself only accepts images and GIFs as showcase artwork, so an imported
// video is sampled into GIF frames right away: the preview, the timeline and the
// exported GIF all use one representation, which keeps the loop in sync with a
// video background. The clip itself stays in IndexedDB so the frames can be
// re-sampled (with the same budget) when the project is opened again.
// ---------------------------------------------------------------------------

/** Imported clips are layers, not backgrounds: 960 px is plenty after scaling. */
export const VIDEO_MAX_SIDE = 960
/** ~3 s at 30 fps; a longer clip is sampled evenly instead of dropping the tail. */
export const VIDEO_MAX_FRAMES = 90
/** Keep one project from filling the storage quota with a single movie. */
export const VIDEO_MAX_BYTES = 120 * 1024 * 1024

export interface InspectedVideo {
  mime: string
  gif: GifAsset
  width: number
  height: number
}

function videoMime(file: Blob): string {
  if (file.type && file.type.startsWith('video/')) return file.type
  return 'video/mp4'
}

/** Sniff the container so a `.webm` from Windows is not stored as `video/mp4`. */
async function resolveMime(file: Blob): Promise<string> {
  if (file.type && file.type.startsWith('video/')) return file.type
  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
    return sniffVideoMime(head) || videoMime(file)
  } catch {
    return videoMime(file)
  }
}

/**
 * Sample a video file into frames.
 *
 * `captureVideoUrl` loads the blob through an offscreen <video> and either plays
 * it once or seeks across the clip, so this works for MP4 (H.264) and WebM that
 * the browser can decode. Anything else throws a readable error instead of
 * producing a broken asset.
 */
export async function inspectVideo(file: Blob, onProgress?: GifProgress): Promise<InspectedVideo> {
  if (file.size > VIDEO_MAX_BYTES) {
    throw new Error(
      `Видео больше ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} МБ. ` +
        'Сожмите ролик или обрежьте его: для витрины хватает нескольких секунд.',
    )
  }
  const mime = await resolveMime(file)
  const url = URL.createObjectURL(file)
  try {
    const gif = await captureVideoUrl(url, {
      maxFrames: VIDEO_MAX_FRAMES,
      maxSide: VIDEO_MAX_SIDE,
      onProgress: onProgress ? (done, total) => onProgress(done, total) : undefined,
    })
    if (!gif || !gif.frames.length) {
      throw new Error(
        'Не удалось прочитать кадры видео. Поддерживаются MP4 (H.264) и WebM, которые умеет играть браузер — ' +
          'перекодируйте ролик или добавьте его как GIF.',
      )
    }
    return { mime, gif, width: gif.width, height: gif.height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Container check for the file pickers and drag&drop. */
export function isVideoName(name: string): boolean {
  return /\.(mp4|m4v|webm|mov|ogv)$/i.test(name)
}

export { sniffVideoMime }
