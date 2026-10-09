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
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.warn('SW 注册失败', e)
      })
    })
  }
})