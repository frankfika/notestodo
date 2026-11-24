import path from "node:path";

/** 桌面窗口的 webPreferences。抽出来方便断言一定挂上了 preload。 */
export function resolvePreloadScript(dir: string): string {
  return path.join(dir, "preload.js");
}

export function desktopWebPreferences(dir: string) {
  return {
    preload: resolvePreloadScript(dir),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  };
}

/**
 * 沙箱 preload 只允许引用 electron。本地模块（例如 ./picker）会在启动时抛错，
 * contextBridge 根本不会挂上，设置页也就没有「浏览…」。
 */
export function sandboxedPreloadProblems(source: string): string[] {
  const problems: string[] = [];
  const specifiers = [...source.matchAll(/(?:from|import|require\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (specifier !== "electron") {
      problems.push(`沙箱 preload 不能引用「${specifier}」，只能引用 electron`);
    }
  }
  if (!source.includes('exposeInMainWorld("huoyeDesktop"') && !source.includes("exposeInMainWorld('huoyeDesktop'")) {
    problems.push("preload 必须把 huoyeDesktop 挂到页面");
  }
  if (!source.includes("pickLocalFolder")) {
    problems.push("preload 必须暴露 pickLocalFolder");
  }
  return problems;
}
