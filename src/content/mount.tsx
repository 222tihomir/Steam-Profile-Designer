import { createRoot, type Root } from 'react-dom/client'
import App from '../editor/App'
import { Boundary } from '../editor/Boundary'
import styles from '../editor/styles.css?inline'

// ---------------------------------------------------------------------------
// Shadow DOM host for the in-page editor.
//
// The host sits outside Steam's CSS: Steam's global selectors cannot reach the
// panel, and our styles cannot leak into the profile. The composition and the
// panel are fixed-position children, so the host itself never intercepts page
// clicks. The launcher is the only always-clickable element.
// ---------------------------------------------------------------------------

interface OverlayController {
  open: () => void
  toggle: () => void
  hide: () => void
  destroy: () => void
  isOpen: () => boolean
}

declare global {
  interface Window {
    __spdOverlay?: OverlayController
  }
}

export function mountOverlay(autoOpen = false): OverlayController {
  if (window.__spdOverlay) {
    if (autoOpen) window.__spdOverlay.open()
    return window.__spdOverlay
  }

  const host = document.createElement('div')
  host.setAttribute('data-spd-host', '1')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;'
  document.documentElement.append(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = styles
  const mount = document.createElement('div')
  mount.className = 'spd-host-mount'
  mount.style.display = 'none'

  const launcher = document.createElement('button')
  launcher.type = 'button'
  launcher.className = 'spd-launcher'
  launcher.textContent = 'Оформить профиль'
  launcher.title = 'Steam Profile Designer — открыть редактор'
  launcher.style.pointerEvents = 'auto'

  shadow.append(style, mount, launcher)

  let root: Root | null = null
  let open = false

  const showLauncher = () => {
    launcher.style.display = 'flex'
  }
  const hideLauncher = () => {
    launcher.style.display = 'none'
  }

  const mountApp = () => {
    if (!root) {
      root = createRoot(mount)
      root.render(
        <Boundary>
          <App
            surface="overlay"
            onHideUi={() => {
              open = false
              showLauncher()
            }}
          />
        </Boundary>,
      )
    }
    mount.style.display = 'block'
  }

  const controller: OverlayController = {
    open() {
      mountApp()
      open = true
      hideLauncher()
      window.dispatchEvent(new CustomEvent('spd:show-panel'))
    },
    hide() {
      if (!root) return
      open = false
      showLauncher()
      window.dispatchEvent(new CustomEvent('spd:hide-panel'))
    },
    toggle() {
      if (open) controller.hide()
      else controller.open()
    },
    isOpen() {
      return open
    },
    destroy() {
      root?.unmount()
      root = null
      host.remove()
      delete window.__spdOverlay
    },
  }

  launcher.addEventListener('click', () => controller.open())
  window.__spdOverlay = controller

  if (autoOpen) controller.open()
  else showLauncher()

  return controller
}
