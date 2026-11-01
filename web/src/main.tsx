import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { bootstrap } from './bootstrap'
import './styles/main.css'

void bootstrap().finally(() => {
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
})