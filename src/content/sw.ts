/// <reference types="chrome" />

// Service worker: image relay and toolbar behaviour.

const MAX_BYTES = 32 * 1024 * 1024

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

async function relay(url: string): Promise<{ ok: true; dataUrl: string; mime: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-cache' })
    if (!response.ok) return { ok: false, error: `Steam CDN ответил ${response.status}` }
    const blob = await response.blob()
    if (blob.size > MAX_BYTES) return { ok: false, error: 'Изображение больше 32 МБ' }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const mime = blob.type || 'image/png'
    return { ok: true, dataUrl: `data:${mime};base64,${toBase64(bytes)}`, mime }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Не удалось скачать изображение' }
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; url?: string }, _sender, sendResponse) => {
  if (message?.type === 'spd:fetch' && message.url) {
    void relay(message.url).then(sendResponse)
    return true
  }
  if (message?.type === 'spd:open-studio') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') })
    sendResponse({ ok: true })
    return false
  }
  return false
})

chrome.action.onClicked.addListener((tab) => {
  const url = tab.url ?? ''
  const isProfile = /^https:\/\/steamcommunity\.com\/(profiles|id|my)(\/|\?|$)/.test(url)
  if (isProfile && tab.id !== undefined) {
    chrome.tabs.sendMessage(tab.id, { type: 'spd:toggle' }).catch(() => {
      // Content script is not injected yet (e.g. an old tab): open the studio.
      void chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') })
    })
    return
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') })
})
