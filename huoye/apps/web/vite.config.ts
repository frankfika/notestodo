import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.HUOYE_HOST || "127.0.0.1";
const port = Number(process.env.HUOYE_WEB_PORT || 5173);
const apiPort = Number(process.env.HUOYE_PORT || 8787);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://${host}:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host,
    port,
  },
});
