import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { bootstrap } from './bootstrap'
import './styles/main.css'

// bootstrap 失败（Dexie 迁移错误 / IndexedDB 被禁 / 磁盘满）时渲染致命错误页，
// 而不是继续在坏掉的数据库上跑 —— 那种情况下所有页面只会冒一堆莫名错误。
void bootstrap()
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    document.getElementById('root')!.innerHTML = `
      <div style="max-width:32rem;margin:18vh auto;padding:0 1.5rem;font-family:system-ui,sans-serif;color:#c62f2f">
        <h1 style="font-size:1.25rem">openNotion 启动失败</h1>
        <p>本地数据库打不开，本次改动不会被保存。刷新重试；持续报错请检查浏览器是否禁用了 IndexedDB / 存储空间是否已满。</p>
        <pre style="white-space:pre-wrap;font-size:12px;background:#0000000d;padding:0.75rem;border-radius:8px;color:#666"></pre>
      </div>`
    document.querySelector('#root pre')!.textContent = msg
  })
  .finally(() => {
    // bootstrap 失败时 root 已被致命错误页占用；再渲染 React 会盖掉它
    if (!document.getElementById('root')!.innerHTML.trim()) {
      createRoot(document.getElementById('root')!).render(
        <StrictMode>
          {/* 包裹整个 App：捕获 App 顶层 render 抛错（之前只在 App 内容里 catch，
              App 本身的 hook/状态错误会冒到 root 致白屏） */}
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </StrictMode>,
      )
      // 注册 service worker（PWA 离线启动 + 添加到主屏幕）
      // 注意：bootstrap 是异步的，走到这行时 load 事件可能已经触发过，
      // 再 addEventListener('load') 就永远等不到 —— 必须先判断 readyState。
      if ('serviceWorker' in navigator && import.meta.env.PROD) {
        const register = (): void => {
          void navigator.serviceWorker.register('/sw.js').catch((e) => {
            console.warn('SW 注册失败', e)
          })
        }
        if (document.readyState === 'complete') register()
        else window.addEventListener('load', register, { once: true })
      }
    }
  })
