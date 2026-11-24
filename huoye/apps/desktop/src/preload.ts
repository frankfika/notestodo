/**
 * 沙箱 preload 只能 require("electron")，不能再引用本地模块。
 * 通道名必须与 picker.ts 里的 PICK_FOLDER_CHANNEL 保持一致。
 */
import { contextBridge, ipcRenderer } from "electron";

const PICK_FOLDER_CHANNEL = "huoye:pick-folder";

contextBridge.exposeInMainWorld("huoyeDesktop", {
  pickLocalFolder: (): Promise<string | undefined> => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
});
