import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    // Vite 默认只接受 localhost 的 Host 头, 通过 Tailscale Serve
    // 用 MagicDNS 域名访问时会被 403 拦掉, 必须显式放行。
    allowedHosts: [
      '111macbook-pro.tailef4435.ts.net',
      '.ts.net',
      '.tailscale.com',
    ],
  },
})
