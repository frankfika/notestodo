/**
 * 拾贝 service worker — minimal offline-first shell.
 *
 * 缓存策略：
 *   1) navigations（HTML）           → network-first，回退 cached
 *   2) /icons/* + manifest.webmanifest → cache-first
 *   3) 其他（JS / CSS）               → network-first，缓存回退
 *
 * 应用数据（Dexie/IndexedDB）不归 SW 管；DataExport 的 .zip 与录音 blob
 * 由用户主动导出，不预缓存。
 */
const VERSION = 'shibei-v1'
const CORE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(CORE).catch(() => undefined)),
  )
  // 不 skipWaiting：避免新 SW 抢占旧版正在用的 tab
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
    ),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // icons + manifest：cache-first
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(VERSION).then((cache) => cache.put(req, copy))
        return res
      })),
    )
    return
  }

  // navigations + JS/CSS：network-first with cache fallback
  if (req.mode === 'navigate' || req.destination === 'script' || req.destination === 'style') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(VERSION).then((cache) => cache.put(req, copy))
        return res
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('/'))),
    )
    return
  }

  // 其他 GET 不主动干预
})