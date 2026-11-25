export * from "./channels";
export * from "./channel-store";
export * from "./folders";
export * from "./parse-events";
export * from "./send";
export * from "./signatures";

import { LocalFolderRegistry, type LocalFolderView } from "./folders";

export type ConnectorKind = "cloud" | "local" | "channel";
export type ConnectorStatus = "not_connected" | "connected" | "error";
export type ConnectorCapability = "read" | "write" | "send";

export interface ConnectorRecord {
  id: string;
  name: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  capabilities: ConnectorCapability[];
  description: string;
  roots?: string[];
  folders?: LocalFolderView[];
}

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  capabilities: ConnectorCapability[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}


export function catalog(): ConnectorRecord[] {
  return [
    {
      id: "local-folders",
      name: "本地文件夹",
      kind: "local",
      status: "not_connected",
      capabilities: ["read"],
      description: "由你添加具体的文件夹，不会自动扫描家目录或整块磁盘。添加后可以查看顶层内容；聊天和简报还不会自动引用这些文件夹。",
      roots: [],
    },
    {
      id: "feishu",
      name: "飞书",
      kind: "channel",
      status: "not_connected",
      capabilities: ["read", "send"],
      description: "在飞书里和活页对话。需要先在开放平台填好凭证，没配好就是未连接。",
    },
    {
      id: "lark",
      name: "Lark",
      kind: "channel",
      status: "not_connected",
      capabilities: ["read", "send"],
      description: "飞书的国际版，用同一套事件签名规则。没配好凭证就是未连接。",
    },
    {
      id: "dingtalk",
      name: "钉钉",
      kind: "channel",
      status: "not_connected",
      capabilities: ["read", "send"],
      description: "在钉钉里和活页对话，机器人 HTTP 模式接收消息。没配好就是未连接。",
    },
    {
      id: "weixin",
      name: "微信",
      kind: "channel",
      status: "not_connected",
      capabilities: ["read", "send"],
      description: "用公众号或服务号的官方回调接入，不使用个人微信协议。没配好就是未连接。",
    },
  ];
}

/**
 * 连接器页只管本地文件夹和云应用。
 * 聊天通道在设置 → 通道里单独呈现，状态由通道凭证决定。
 */
export function publicCatalog(registry: LocalFolderRegistry): ConnectorRecord[] {
  const items = catalog();
  const folders = registry.inspect();
  const roots = folders.map((folder) => folder.path);
  return items
    .filter((item) => item.kind !== "channel")
    .map((item) => {
      if (item.id !== "local-folders") return item;
      const hasError = folders.some((folder) => folder.status === "error");
      const status = roots.length === 0 ? "not_connected" : hasError ? "error" : "connected";
      return {
        ...item,
        roots,
        folders,
        status,
      };
    });
}
