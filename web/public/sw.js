/**
 * openNotion service worker — minimal offline-first shell.
 *
 * 缓存策略：
 *   1) navigations（HTML）           → network-first，回退 cached
 *   2) /icons/* + manifest.webmanifest → cache-first
 *   3) 其他（JS / CSS）               → network-first，缓存回退
 *
 * 应用数据（Dexie/IndexedDB）不归 SW 管；DataExport 的 .zip 与录音 blob
 * 由用户主动导出，不预缓存。
 */
const VERSION = 'opennotion-v3'
const CORE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
  // 新版本立刻接管：否则旧 SW 会一直服务旧壳，用户几个月都拿不到更新
  self.skipWaiting()
})

/**
 * 预缓存应用壳。
 * 关键：首访时 SW 还没接管，那次加载的带 hash 的 JS/CSS 不会进缓存 → 断网重载就是白屏。
 * 所以 install 时解析 index.html，把 /assets/* 一并缓存。
 */
async function precache() {
  const cache = await caches.open(VERSION)
  await cache.addAll(CORE).catch(() => undefined)
  try {
    const res = await fetch('/')
    if (!res.ok) return
    const html = await res.clone().text()
    await cache.put('/', res.clone())
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    await Promise.all(assets.map((u) => cache.add(u).catch(() => undefined)))
  } catch {
    // 装的时候没网（离线安装）不致命：运行时 network-first 仍会缓存
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
      ),
      self.clients.claim(),
    ]),
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
      caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => {
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
      }).catch(() =>
        // 断网：导航请求回退到缓存的页面壳（任意路径都能打开应用）
        caches.match(req, { ignoreVary: true }).then((hit) => hit ?? caches.match('/', { ignoreVary: true })).then((hit) =>
          hit ?? new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } }),
        ),
      ),
    )
    return
  }

  // 其他 GET 不主动干预
})