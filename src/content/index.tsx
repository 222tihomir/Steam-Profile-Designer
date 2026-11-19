import { mountOverlay } from './mount'

// Content script: shows a small launcher on Steam profile pages. The editor is
// opened by the extension action, by the launcher, or by a #spd hash (used by
// the local mock profile); it never opens on its own on a real profile.

const controller = mountOverlay(/^#spd/i.test(location.hash))

chrome.runtime.onMessage.addListener((message: { type?: string } | undefined) => {
  if (!message?.type) return
  if (message.type === 'spd:open') controller.open()
  if (message.type === 'spd:toggle') controller.toggle()
  if (message.type === 'spd:hide') controller.hide()
})

// Steam sometimes changes profiles without a full page load (back/forward cache).
window.addEventListener('pageshow', () => {
  if (/^#spd/i.test(location.hash)) controller.open()
})
