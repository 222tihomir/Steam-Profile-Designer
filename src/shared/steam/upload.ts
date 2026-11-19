import type { ShowcaseKind } from '../types'
import { SHOWCASES } from '../geometry'

// Field values the upload helper writes on Steam's illustration upload page.
// These match the console snippets that have been used for years: telling Steam
// the image is 1000×1 keeps tall showcase artwork from being re-cropped, and
// detaching the id stops Steam's own script from overwriting the value again.

export type UploadMode = ShowcaseKind | 'guide'

export interface UploadField {
  selector: string
  value: string
  /** Remove the id so the page script cannot find the field again. */
  detach?: boolean
}

const LONG_IMAGE: UploadField[] = [
  { selector: '#image_width', value: '1000', detach: true },
  { selector: '#image_height', value: '1', detach: true },
]

export const UPLOAD_MODES: Record<UploadMode, { fields: UploadField[]; hex: boolean; label: string }> = {
  featured: { fields: LONG_IMAGE, hex: false, label: 'Избранная иллюстрация' },
  artwork: { fields: LONG_IMAGE, hex: false, label: 'Витрина иллюстраций' },
  screenshot: {
    fields: [...LONG_IMAGE, { selector: '[name=file_type]', value: '5' }],
    hex: false,
    label: 'Витрина скриншотов',
  },
  workshop: {
    fields: [
      { selector: '[name=consumer_app_id]', value: '480' },
      { selector: '[name=file_type]', value: '0' },
      { selector: '[name=visibility]', value: '0' },
    ],
    hex: true,
    label: 'Витрина мастерской',
  },
  guide: {
    fields: [...LONG_IMAGE, { selector: '[name=file_type]', value: '9' }],
    hex: true,
    label: 'Гайд',
  },
}

export const UPLOAD_MODE_ORDER: UploadMode[] = ['featured', 'artwork', 'screenshot', 'workshop', 'guide']

/** Which showcase a file from our archive belongs to, by its leading name. */
export function kindFromFileName(name: string): ShowcaseKind | null {
  const match = /^([a-z]+)(?:[-_.]|$)/i.exec(name)
  const kind = match?.[1]?.toLowerCase()
  return kind && kind in SHOWCASES ? (kind as ShowcaseKind) : null
}

const GIF_TRAILER = 0x3b
const PATCHED_TRAILER = 0x21

export function isGifBytes(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
}

/**
 * Steam recompresses GIFs on some upload routes unless the trailer byte is
 * changed from 0x3B to 0x21. The trick is well known in the Steam artwork
 * community and is used by the MIT reference project; we only apply it to files
 * the user is uploading themselves, on Steam's own upload page.
 */
export function patchGifTrailer(bytes: Uint8Array): Uint8Array {
  if (!isGifBytes(bytes)) return bytes
  const out = bytes.slice()
  const last = out.length - 1
  if (out[last] === GIF_TRAILER) out[last] = PATCHED_TRAILER
  return out
}
