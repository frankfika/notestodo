/**
 * 桌面壳的纯逻辑：只允许打开本机活页，并在本地服务未启动时给出中文说明。
 * 不依赖 Electron，方便单测。
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function resolveAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const portRaw = (env.HUOYE_WEB_PORT ?? "").trim() || "5173";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`HUOYE_WEB_PORT 无效：${portRaw}`);
  }
  // 窗口始终连回环地址。即使服务绑定了 0.0.0.0，也不把窗口指到其他网卡或远程主机。
  return `http://127.0.0.1:${port}`;
}

export function isAllowedAppUrl(candidate: string, origin: string): boolean {
  let url: URL;
  let allowed: URL;
  try {
    url = new URL(candidate);
    allowed = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (!LOOPBACK_HOSTS.has(allowed.hostname) && allowed.hostname !== "") return false;
  const urlPort = url.port || "80";
  const allowedPort = allowed.port || "80";
  return urlPort === allowedPort;
}

export function serverMissingHtml(origin: string): string {
  const safeOrigin = escapeHtml(origin);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>活页</title>
    <style>
      :root { color-scheme: light; }
      html, body { margin: 0; min-height: 100%; }
      body {
        font-family: "Figtree Variable", "Figtree", "Noto Sans SC Variable", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif;
        color: #2b2825;
        background:
          radial-gradient(1200px 600px at 50% -10%, #eef4fb 0%, rgba(238, 244, 251, 0) 70%),
          linear-gradient(180deg, #dce7f4 0%, #edf1f6 38%, #f6e8da 72%, #f3d5c4 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 20px;
      }
      main {
        max-width: 28rem;
        background: rgba(255, 255, 255, 0.88);
        border-radius: 28px;
        padding: 28px 26px;
        box-shadow: 0 18px 40px rgba(80, 96, 120, 0.12);
      }
      h1 {
        font-family: "Source Serif 4", "Songti SC", "Noto Serif CJK SC", Georgia, serif;
        font-size: 2rem;
        font-weight: 600;
        margin: 0 0 0.6em;
      }
      p { margin: 0 0 0.8em; line-height: 1.6; }
      p:last-child { margin-bottom: 0; }
      code {
        font-family: "Geist Mono", ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.92em;
        background: rgba(255, 255, 255, 0.8);
        padding: 0.1em 0.35em;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>活页</h1>
      <p>还没有连上本机的活页服务，所以窗口里暂时打不开应用。</p>
      <p>请先在项目目录里运行 <code>pnpm dev</code>，等网页启动后再打开这个窗口。</p>
      <p>默认地址是 <code>${safeOrigin}</code>。桌面壳只连接这台电脑上的本机端口，不会去打开远程网站。</p>
    </main>
  </body>
</html>
`;
}

export async function probeLocalServer(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(origin, { method: "GET", signal: controller.signal, redirect: "manual" });
    return response.ok || response.status === 304 || (response.status >= 300 && response.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
