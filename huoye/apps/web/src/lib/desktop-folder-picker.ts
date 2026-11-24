/** 只有桌面壳注入了 window.huoyeDesktop 时，才能用系统文件夹对话框。网页浏览器没有真实路径。 */

export function hasDesktopFolderPicker(
  desktop: unknown,
): desktop is { pickLocalFolder: () => Promise<string | undefined> } {
  return (
    typeof desktop === "object" &&
    desktop !== null &&
    typeof (desktop as { pickLocalFolder?: unknown }).pickLocalFolder === "function"
  );
}
