/** 桌面文件夹选择的纯逻辑。不依赖 Electron，方便单测。 */

export const PICK_FOLDER_CHANNEL = "huoye:pick-folder";

export function pickedDirectoryPath(result: { canceled: boolean; filePaths: string[] }): string | undefined {
  if (result.canceled) return undefined;
  const value = result.filePaths[0]?.trim();
  if (!value) return undefined;
  return value;
}
