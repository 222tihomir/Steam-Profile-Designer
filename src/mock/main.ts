import { mountOverlay } from '../content/mount'

// Local stand-in for a Steam profile. The real extension content script is not
// present on localhost, so the mock mounts the same overlay module directly.
const controller = mountOverlay(true)

const params = new URLSearchParams(location.search)
if (params.has('closed')) controller.hide()

declare global {
  interface Window {
    __spdMock?: typeof controller
  }
}
window.__spdMock = controller
