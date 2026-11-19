import {
  UPLOAD_MODES,
  UPLOAD_MODE_ORDER,
  isGifBytes,
  kindFromFileName,
  patchGifTrailer,
  type UploadMode,
} from '../shared/steam/upload'

// ---------------------------------------------------------------------------
// Upload helper for Steam's illustration page.
//
// It only fills the same fields the community has set by hand for years, and
// optionally patches the GIF trailer byte before Steam's own change handler
// sees the file. Nothing is submitted automatically: the user still reviews the
// page and presses Steam's own button.
// ---------------------------------------------------------------------------

const PANEL_KEY = 'spd-helper-hidden'

function injectStyles(shadow: ShadowRoot) {
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .h-card {
      position: fixed; right: 18px; bottom: 18px; width: 308px;
      background: #141b24; color: #dbe4ee; border: 1px solid #2c3a49;
      border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.5);
      font: 13px/1.45 'Motiva Sans','Segoe UI',Roboto,Arial,sans-serif;
      overflow: hidden; z-index: 2147483000;
    }
    .h-head { display:flex; align-items:center; gap:8px; padding:10px 12px;
      background: linear-gradient(180deg,#1a2431,#141b24); border-bottom:1px solid #1f2733; }
    .h-title { font-weight:700; font-size:13px; flex:1; }
    .h-x { border:0; background:transparent; color:#8b9aad; font-size:17px; cursor:pointer; padding:0 2px; }
    .h-x:hover { color:#fff; }
    .h-body { padding:10px 12px 12px; display:flex; flex-direction:column; gap:8px; }
    .h-file { font-size:11.5px; color:#b9c9da; background:#0e141b; border:1px solid #26313d;
      border-radius:7px; padding:7px 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .h-label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:#8b9aad; }
    select { width:100%; background:#0e141b; color:#dbe4ee; border:1px solid #26313d;
      border-radius:7px; padding:6px 8px; font:inherit; font-size:12px; }
    .h-check { display:flex; align-items:center; gap:7px; font-size:11.5px; color:#b9c9da; cursor:pointer; }
    .h-check input { accent-color:#66c0f4; width:14px; height:14px; }
    .h-btn { border:1px solid #4ba3dc; background:linear-gradient(180deg,#3f8fc4,#2f74a8);
      color:#fff; font:inherit; font-weight:600; font-size:12px; padding:8px 10px;
      border-radius:7px; cursor:pointer; flex:1; }
    .h-btn:hover { background:linear-gradient(180deg,#4a9fd7,#3884bc); }
    .h-btn.ghost { background:#1c2530; border-color:#2c3a49; color:#b9c9da; font-weight:500; }
    .h-row { display:flex; align-items:center; gap:8px; }
    .h-state { font-size:11.5px; font-weight:600; color:transparent; min-width:0;
      transition:color .15s ease; }
    .h-state.ok { color:#a4d007; }
    .h-state.bad { color:#e7a33e; }
    .h-hint { font-size:10.8px; color:#8b9aad; line-height:1.5; }
    .h-hint b { color:#c7d5e0; }
    .h-ok { color:#a4d007; }
  `
  shadow.append(style)
}

function makeDom(shadow: ShadowRoot) {
  const card = document.createElement('div')
  card.className = 'h-card'
  card.innerHTML = `
    <div class="h-head">
      <span class="h-title">Помощник загрузки</span>
      <button class="h-x" type="button" title="Скрыть">×</button>
    </div>
    <div class="h-body">
      <div class="h-file">Файл не выбран</div>
      <label class="h-label">Витрина
        <select class="h-mode"></select>
      </label>
      <label class="h-check"><input type="checkbox" class="h-hex" checked> GIF: патч трейлера (0x3B → 0x21)</label>
      <div class="h-row">
        <button class="h-btn h-apply" type="button">Применить поля</button>
        <span class="h-state" aria-live="polite"></span>
      </div>
      <div class="h-hint">Поля ширины и высоты ставятся в <b>1000×1</b>, чтобы Steam не обрезал высокую иллюстрацию.
      Публикацию подтверждаете вы сами.</div>
      <div class="h-hint h-status"></div>
    </div>
  `
  shadow.append(card)

  const mode = card.querySelector<HTMLSelectElement>('.h-mode')!
  for (const value of UPLOAD_MODE_ORDER) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = UPLOAD_MODES[value].label
    mode.append(option)
  }

  return {
    card,
    mode,
    fileLabel: card.querySelector<HTMLElement>('.h-file')!,
    hex: card.querySelector<HTMLInputElement>('.h-hex')!,
    apply: card.querySelector<HTMLButtonElement>('.h-apply')!,
    applied: card.querySelector<HTMLElement>('.h-state')!,
    status: card.querySelector<HTMLElement>('.h-status')!,
    close: card.querySelector<HTMLButtonElement>('.h-x')!,
  }
}

// Width/height lose their ids after the first apply so Steam's own script cannot
// overwrite them again. Keep the references for later mode changes.
const detachedFields = new Map<string, HTMLElement>()

function applyMode(mode: UploadMode): number {
  let applied = 0
  for (const field of UPLOAD_MODES[mode].fields) {
    const cached = detachedFields.get(field.selector)
    const element = cached?.isConnected ? cached : document.querySelector(field.selector)
    if (!(element instanceof HTMLElement)) continue
    if (element instanceof HTMLSelectElement || element instanceof HTMLInputElement) {
      element.value = field.value
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      applied += 1
    }
    if (field.detach) {
      element.removeAttribute('id')
      detachedFields.set(field.selector, element)
    }
  }
  return applied
}

function setup() {
  if (document.querySelector('[data-spd-helper]')) return
  const host = document.createElement('div')
  host.setAttribute('data-spd-helper', '1')
  document.documentElement.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  injectStyles(shadow)
  const ui = makeDom(shadow)

  const input = () => document.querySelector<HTMLInputElement>('input[type=file]')
  let current: UploadMode = 'featured'
  let patching = false
  let appliedTimer = 0

  // The status line sits at the bottom of the card, so a click felt silent unless
  // you scrolled. Show the outcome right next to the button and fade it out.
  const flashApplied = (ok: boolean) => {
    ui.applied.textContent = ok ? 'Применено' : 'Не найдено'
    ui.applied.className = ok ? 'h-state ok' : 'h-state bad'
    window.clearTimeout(appliedTimer)
    appliedTimer = window.setTimeout(() => {
      ui.applied.textContent = ''
      ui.applied.className = 'h-state'
    }, 3000)
  }

  if (sessionStorage.getItem(PANEL_KEY) === '1') ui.card.style.display = 'none'
  ui.close.addEventListener('click', () => {
    ui.card.style.display = 'none'
    sessionStorage.setItem(PANEL_KEY, '1')
  })

  const choose = (mode: UploadMode, remember = true) => {
    current = mode
    ui.mode.value = mode
    if (remember) ui.status.textContent = `Витрина: ${UPLOAD_MODES[mode].label}`
  }

  const runApply = (mode: UploadMode) => {
    const count = applyMode(mode)
    ui.status.textContent = count
      ? `Поля применены: ${count}. Проверьте заголовок и нажмите «Опубликовать».`
      : 'Поля не найдены на странице. Убедитесь, что открыта форма загрузки иллюстрации.'
    ui.status.className = count ? 'h-hint h-status h-ok' : 'h-hint h-status'
    flashApplied(count > 0)
  }

  ui.apply.addEventListener('click', () => runApply(current))
  ui.mode.addEventListener('change', () => choose(ui.mode.value as UploadMode, false))

  const patchSelectedFile = async (inputElement: HTMLInputElement, file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!isGifBytes(bytes)) return false
    if (bytes[bytes.length - 1] !== 0x3b) return false
    const patched = patchGifTrailer(bytes)
    const replacement = new File([patched as unknown as BlobPart], file.name, {
      type: 'image/gif',
      lastModified: file.lastModified,
    })
    const transfer = new DataTransfer()
    transfer.items.add(replacement)
    inputElement.files = transfer.files
    return true
  }

  // Capture on document happens before Steam's own change handler on the input.
  document.addEventListener(
    'change',
    (event) => {
      if (patching) return
      const target = event.target
      if (!(target instanceof HTMLInputElement) || target.type !== 'file') return
      const file = target.files?.[0]
      if (!file) return

      ui.fileLabel.textContent = file.name
      const detected = kindFromFileName(file.name)
      if (detected) choose(detected)
      const mode = current

      const shouldPatch = ui.hex.checked && (file.type === 'image/gif' || /\.gif$/i.test(file.name))
      if (shouldPatch) {
        event.preventDefault()
        event.stopImmediatePropagation()
        patching = true
        // Re-dispatch for Steam's own change handler while the guard is up,
        // otherwise this listener would patch its own synthetic event forever.
        const notifySteam = () => {
          try {
            target.dispatchEvent(new Event('change', { bubbles: true }))
          } finally {
            patching = false
          }
        }
        void patchSelectedFile(target, file)
          .then((patched) => {
            if (patched) ui.status.textContent = 'GIF: трейлер пропатчен перед загрузкой.'
            notifySteam()
          })
          .catch(() => {
            ui.status.textContent = 'Не удалось прочитать GIF — Steam получит исходный файл.'
            notifySteam()
          })
        window.setTimeout(() => runApply(mode), 500)
        return
      }

      if (detected) window.setTimeout(() => runApply(mode), 350)
    },
    true,
  )

  const existing = input()
  if (existing?.files?.[0]) ui.fileLabel.textContent = existing.files[0].name

  if (!sessionStorage.getItem(PANEL_KEY)) ui.card.style.display = 'block'
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.setTimeout(setup, 1200), { once: true })
} else {
  window.setTimeout(setup, 1200)
}
