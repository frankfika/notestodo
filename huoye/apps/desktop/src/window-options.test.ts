import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PICK_FOLDER_CHANNEL } from "./picker";
import { desktopWebPreferences, resolvePreloadScript, sandboxedPreloadProblems } from "./window-options";

const PRELOAD_SRC = path.join(process.cwd(), "apps/desktop/src/preload.ts");

describe("桌面窗口必须挂上沙箱安全的 preload", () => {
  it("创建窗口时指向 dist/preload.js，并保持 sandbox 与 contextIsolation", () => {
    const prefs = desktopWebPreferences("/tmp/huoye-desktop-dist");
    expect(prefs.preload).toBe(resolvePreloadScript("/tmp/huoye-desktop-dist"));
    expect(prefs.preload).toBe(path.join("/tmp/huoye-desktop-dist", "preload.js"));
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webviewTag).toBe(false);
  });

  it("会拦住在沙箱 preload 里引用本地模块（那会让浏览按钮消失）", () => {
    const broken = `import { contextBridge, ipcRenderer } from "electron";
import { PICK_FOLDER_CHANNEL } from "./picker";
contextBridge.exposeInMainWorld("huoyeDesktop", {
  pickLocalFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
});
`;
    expect(sandboxedPreloadProblems(broken)).toEqual([
      "沙箱 preload 不能引用「./picker」，只能引用 electron",
    ]);
  });

  it("当前 preload 只引用 electron，并暴露与主进程相同的通道", () => {
    const source = readFileSync(PRELOAD_SRC, "utf8");
    expect(sandboxedPreloadProblems(source)).toEqual([]);
    expect(source).toContain(`"${PICK_FOLDER_CHANNEL}"`);
    expect(source).toContain('exposeInMainWorld("huoyeDesktop"');
    expect(source).toContain("pickLocalFolder");
  });
});
