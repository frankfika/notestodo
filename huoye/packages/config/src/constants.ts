export const PRODUCT_NAME_ZH = "活页";
export const PRODUCT_NAME_EN = "Huoye";
export const DEFAULT_ASSISTANT_NAME = "叶";
export const DEFAULT_DISPLAY_NAME = "你";
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_LANGUAGE = "zh-CN" as const;
export const DEFAULT_API_PORT = 8787;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_HOME_DIRNAME = "Huoye";

/** 「给我一个名字」用的原创词表，不得包含 Spark、Iris、Momo、April、Today。 */
export const ASSISTANT_NAME_CANDIDATES = [
  "叶",
  "澄",
  "岸",
  "川",
  "林",
  "岚",
  "舟",
  "禾",
  "涧",
  "栖",
  "予",
  "晓",
  "南",
  "青",
  "衡",
] as const;

export const CORE_ABOUT_YOU_FILES = [
  "about-you/profile.md",
  "about-you/identity.md",
  "about-you/lifestyle.md",
  "about-you/work.md",
  "about-you/devices.md",
] as const;

export const ABOUT_YOU_FILENAMES = [
  "profile.md",
  "identity.md",
  "lifestyle.md",
  "work.md",
  "devices.md",
] as const;

export const ABOUT_MD_PATH = "ABOUT.md";

export const MEMORY_SUBDIRS = [
  "about-you",
  "diaries",
  "briefs",
  "uploads",
  "health",
  "recordings",
  "activities",
] as const;

export const MAX_MEMORY_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export function isCoreAboutYouFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (CORE_ABOUT_YOU_FILES as readonly string[]).includes(normalized);
}

export function pickRandomAssistantName(random = Math.random): string {
  const list = ASSISTANT_NAME_CANDIDATES;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index] ?? DEFAULT_ASSISTANT_NAME;
}
