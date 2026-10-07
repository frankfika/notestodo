import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrap } from './bootstrap'
import './styles/main.css'

void bootstrap().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
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