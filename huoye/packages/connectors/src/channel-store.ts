/**
 * 通道凭证读写：写进现有的 secrets.json 的 channels 字段，和 providers 并存，互不覆盖。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  channelDefById,
  channelStatus,
  normalizeChannelId,
  publicChannelView,
  type ChannelId,
  type ChannelStatus,
  type PublicChannel,
} from "./channels";

export interface SecretsFileShape {
  providers: Record<string, string>;
  channels?: Record<string, Record<string, string>>;
}

export function loadSecretsFile(file: string): SecretsFileShape {
  if (!existsSync(file)) return { providers: {}, channels: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SecretsFileShape>;
    return {
      providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
      channels: raw.channels && typeof raw.channels === "object" ? raw.channels : {},
    };
  } catch {
    return { providers: {}, channels: {} };
  }
}

export function saveSecretsFile(file: string, secrets: SecretsFileShape): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    providers: secrets.providers ?? {},
    channels: secrets.channels ?? {},
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // 某些文件系统可能不支持 chmod
  }
}

export class ChannelStore {
  constructor(private readonly file: string) {}

  /** 只返回该通道认识的字段，避免把别的东西写进 secrets。 */
  values(id: string): Record<string, string> {
    const def = channelDefById(id);
    if (!def) return {};
    const stored = loadSecretsFile(this.file).channels?.[def.id] ?? {};
    const out: Record<string, string> = {};
    for (const field of def.fields) {
      const value = stored[field.key];
      out[field.key] = typeof value === "string" ? value.trim() : "";
    }
    return out;
  }

  save(id: string, values: Record<string, string>): void {
    const def = channelDefById(id);
    if (!def) throw new Error("没有这个通道。");
    const secrets = loadSecretsFile(this.file);
    const channels = { ...secrets.channels };
    const next: Record<string, string> = {};
    for (const field of def.fields) {
      const value = values[field.key];
      next[field.key] = typeof value === "string" ? value.trim() : "";
    }
    channels[def.id] = next;
    saveSecretsFile(this.file, { ...secrets, channels });
  }

  remove(id: string): void {
    const normalized = normalizeChannelId(id);
    if (!normalized) return;
    const secrets = loadSecretsFile(this.file);
    const channels = { ...secrets.channels };
    delete channels[normalized];
    saveSecretsFile(this.file, { ...secrets, channels });
  }

  status(id: string): ChannelStatus {
    const def = channelDefById(id);
    if (!def) return "not_connected";
    return channelStatus(def, this.values(def.id));
  }

  view(id: string): PublicChannel | undefined {
    const def = channelDefById(id);
    if (!def) return undefined;
    return publicChannelView(def, this.values(def.id));
  }

  list(): PublicChannel[] {
    const secrets = loadSecretsFile(this.file);
    const channels = secrets.channels ?? {};
    return ["feishu", "lark", "dingtalk", "weixin"].map((id) => {
      const def = channelDefById(id)!;
      return publicChannelView(def, channels[def.id] ?? {});
    });
  }
}

export interface ChannelSessionState {
  replyTo?: string;
  senderLabel?: string;
  updatedAt?: string;
}

export interface ChannelStateFile {
  channels?: Record<string, ChannelSessionState>;
}

/**
 * 最近一次会话对象（chat_id / openid / conversationId）。
 * 这是会话状态，不是密钥，所以不放进 secrets.json。
 */
export class ChannelStateStore {
  constructor(private readonly file: string) {}

  private read(): ChannelStateFile {
    if (!existsSync(this.file)) return { channels: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as ChannelStateFile;
      return { channels: raw.channels ?? {} };
    } catch {
      return { channels: {} };
    }
  }

  remember(channelId: ChannelId, state: ChannelSessionState): void {
    const current = this.read();
    const channels = { ...current.channels };
    channels[channelId] = { ...channels[channelId], ...state };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ channels }, null, 2)}\n`, "utf8");
  }

  last(channelId: ChannelId): ChannelSessionState | undefined {
    return this.read().channels?.[channelId];
  }
}
