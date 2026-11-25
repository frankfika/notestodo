interface HuoyeDesktop {
  /** 桌面壳提供的本机文件夹选择；网页版没有这个方法。 */
  pickLocalFolder(): Promise<string | undefined>;
}

interface Window {
  huoyeDesktop?: HuoyeDesktop;
}
