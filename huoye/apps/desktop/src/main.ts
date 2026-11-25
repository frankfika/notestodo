import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";
import { desktopNotificationBody, desktopNotificationTitle, shouldNotifyDesktop } from "./notify";
import type { DesktopNotificationItem } from "./notify";
import { PICK_FOLDER_CHANNEL, pickedDirectoryPath } from "./picker";
import { isAllowedAppUrl, probeLocalServer, resolveAppOrigin, serverMissingHtml } from "./shell";
import { desktopWebPreferences } from "./window-options";

const WINDOW_TITLE = "活页";
/** 主动通知轮询间隔：30 秒一次。 */
const NOTIFY_POLL_INTERVAL_MS = 30_000;
/** 轮询请求超时：超过就当这次没拉到，不重试也不刷屏。 */
const NOTIFY_REQUEST_TIMEOUT_MS = 5_000;
/** 读取系统通知授权的超时。 */
const NOTIFY_PERMISSION_TIMEOUT_MS = 2_000;

let notifyTimer: NodeJS.Timeout | null = null;

function guardNavigation(contents: Electron.WebContents, origin: string): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url, origin)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAllowedAppUrl(url, origin)) event.preventDefault();
  });
}

/**
 * 拉取待推通知。任何失败（连不上、返回坏数据、超时）都当这次没有通知，
 * 绝不让主进程崩，也绝不多刷一条。
 */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toNotificationItem(value: unknown): DesktopNotificationItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.body !== "string") return null;
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    at: typeof raw.at === "string" ? raw.at : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
  };
}

async function readPendingNotifications(origin: string): Promise<DesktopNotificationItem[]> {
  const payload = await fetchJson(`${origin}/api/proactive/notifications`);
  const list = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const items: DesktopNotificationItem[] = [];
  for (const raw of list) {
    const item = toNotificationItem(raw);
    if (item) items.push(item);
  }
  return items;
}

/**
 * 系统通知授权看网页里的 Notification.permission（用户在设置页点过「允许桌面通知」才有）。
 * 读不到就当作没授权，宁可少通知也不越权打扰。
 */
async function readNotificationPermission(target: BrowserWindow | undefined): Promise<string> {
  if (!target) return "denied";
  if (!Notification.isSupported()) return "denied";
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = target.webContents
      .executeJavaScript("typeof Notification !== 'undefined' ? Notification.permission : 'denied'", true)
      .then((value: unknown) => (typeof value === "string" ? value : "denied"))
      .catch(() => "denied");
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("denied"), NOTIFY_PERMISSION_TIMEOUT_MS);
    });
    return await Promise.race([query, timeout]);
  } catch {
    return "denied";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function showDesktopNotification(title: string, body: string): void {
  try {
    const notification = new Notification({ title, body });
    notification.on("failed", () => {
      // 系统通知发不出去就静默跳过，不打断主进程。
    });
    notification.show();
  } catch {
    // 系统通知不可用时静默跳过。
  }
}

async function pollProactiveNotifications(origin: string): Promise<void> {
  try {
    const items = await readPendingNotifications(origin);
    if (items.length === 0) return;
    const windows = BrowserWindow.getAllWindows();
    const focused = windows.some((window) => window.isFocused());
    const permission = await readNotificationPermission(windows[0]);
    if (!shouldNotifyDesktop({ focused, permission, items })) return;
    const item = items[0];
    if (!item) return;
    showDesktopNotification(desktopNotificationTitle(item), desktopNotificationBody(item));
    // 通知已经发出，就回执一次，避免下一次轮询重复弹同一条。
    await fetchJson(`${origin}/api/proactive/notifications/ack`, { method: "POST" });
  } catch {
    // 轮询失败一律静默忽略：不能崩，也不能刷屏。
  }
}

function startProactivePolling(origin: string): void {
  stopProactivePolling();
  notifyTimer = setInterval(() => {
    void pollProactiveNotifications(origin);
  }, NOTIFY_POLL_INTERVAL_MS);
  notifyTimer.unref();
}

function stopProactivePolling(): void {
  if (!notifyTimer) return;
  clearInterval(notifyTimer);
  notifyTimer = null;
}

async function createWindow(): Promise<void> {
  const origin = resolveAppOrigin(process.env);
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: WINDOW_TITLE,
    backgroundColor: "#edf1f6",
    autoHideMenuBar: true,
    show: false,
    webPreferences: desktopWebPreferences(__dirname),
  });
  window.setTitle(WINDOW_TITLE);
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(WINDOW_TITLE);
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`活页桌面 preload 没有加载成功：${preloadPath}`, error);
  });
  guardNavigation(window.webContents, origin);

  const ready = await probeLocalServer(origin);
  if (ready) {
    await window.loadURL(`${origin}/`);
  } else {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(serverMissingHtml(origin))}`);
  }
  window.once("ready-to-show", () => window.show());
  if (!window.isVisible()) window.show();
  startProactivePolling(origin);
}

ipcMain.handle(PICK_FOLDER_CHANNEL, async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: "选择要添加到活页的文件夹",
    properties: ["openDirectory", "dontAddToRecent"],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return pickedDirectoryPath(result);
});

app.setName(WINDOW_TITLE);
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
app.on("window-all-closed", () => {
  stopProactivePolling();
  app.quit();
});
app.on("before-quit", () => {
  stopProactivePolling();
});

void app.whenReady().then(() => {
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
