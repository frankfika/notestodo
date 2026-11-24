import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  DEFAULT_ASSISTANT_NAME,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  getHuoyeHome,
  workspacePaths,
} from "@huoye/config";
import { ChannelStateStore, ChannelStore, LocalFolderRegistry, loadSecretsFile, saveSecretsFile } from "@huoye/connectors";
import { ConfirmationService, HuoyeDb, MockProvider, OpenAiCompatibleProvider, type ModelProvider, recordAudit } from "@huoye/core";
import { MemoryStore } from "@huoye/memory";
import { settingsSchema, type Settings } from "@huoye/schema";
import { fixturePaths } from "./paths";
import { reapStaleRunningTasks } from "./records";

export interface SecretsFile {
  providers: Record<string, string>;
  channels?: Record<string, Record<string, string>>;
}

export interface Workspace {
  home: string;
  paths: ReturnType<typeof workspacePaths>;
  memory: MemoryStore;
  db: HuoyeDb;
  confirmations: ConfirmationService;
  folders: LocalFolderRegistry;
  /** 聊天通道的凭证（写在 secrets.json 的 channels 里）。 */
  channels: ChannelStore;
  /** 最近一次会话对象（chat_id / openid 等），不是密钥，单独存。 */
  channelState: ChannelStateStore;
  get settings(): Settings;
  readSettings(): Settings;
  writeSettings(patch: Partial<Settings> | Settings): Settings;
  setProviderKey(id: string, key: string): void;
  getProviderKey(id: string): string | undefined;
  removeProvider(id: string): Settings;
  resolveProvider(id?: string): ModelProvider;
  audit(event: Parameters<typeof recordAudit>[1]): void;
}

export function openWorkspace(home = getHuoyeHome(), options: { fetchImpl?: typeof fetch } = {}): Workspace {
  const paths = workspacePaths(home);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.agentDir, { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });

  const fixtures = fixturePaths();
  if (!existsSync(paths.agent) && existsSync(fixtures.agentSeed)) {
    copyFileSync(fixtures.agentSeed, paths.agent);
  } else if (!existsSync(paths.agent)) {
    writeFileSync(paths.agent, "# 叶\n\n你是活页里的个人助手。\n", "utf8");
  }

  const memory = new MemoryStore({
    memoryRoot: paths.memory,
    seedDir: fixtures.memorySeed,
    timezone: DEFAULT_TIMEZONE,
  });
  memory.seed();

  const settings = loadSettings(paths.config);
  const db = new HuoyeDb(paths.sqlite);
  const confirmations = new ConfirmationService(db, settings.timezone);
  confirmations.expireSeededDemos();

  const folders = new LocalFolderRegistry(pathJoin(paths.data, "local-folders.json"));
  const channels = new ChannelStore(paths.secrets);
  const channelState = new ChannelStateStore(pathJoin(paths.data, "channels-state.json"));

  reapStaleRunningTasks(db, settings.timezone, { allRunning: true });

  const workspace: Workspace = {
    home,
    paths,
    memory,
    db,
    confirmations,
    folders,
    channels,
    channelState,
    get settings() {
      return loadSettings(paths.config);
    },
    readSettings() {
      const current = loadSettings(paths.config);
      return withKeyFlags(current, loadSecrets(paths.secrets));
    },
    writeSettings(patch) {
      const current = loadSettings(paths.config);
      const stripped = stripKeys(patch);
      const merged = settingsSchema.parse({
        ...current,
        ...stripped,
        ...onboardingProactivity(current, stripped),
        providers: (stripped.providers ?? current.providers).map((provider) => ({
          ...provider,
          hasApiKey: false,
        })),
      });
      assertDefaultProviderAllowed(merged, loadSecrets(paths.secrets));
      saveSettings(paths.config, merged);
      if (typeof stripped.displayName === "string") {
        const name = stripped.displayName.trim();
        if (name && name !== DEFAULT_DISPLAY_NAME) {
          memory.setProfileDisplayName(name);
        }
      }
      return workspace.readSettings();
    },
    setProviderKey(id, key) {
      const current = loadSettings(paths.config);
      if (!current.providers.some((p) => p.id === id)) {
        throw new Error("找不到这个模型供应商");
      }
      const secrets = loadSecrets(paths.secrets);
      if (key) secrets.providers[id] = key;
      else delete secrets.providers[id];
      saveSecrets(paths.secrets, secrets);
      if (!key) {
        const provider = current.providers.find((p) => p.id === id);
        if (current.defaultProviderId === id && provider?.type !== "mock") {
          saveSettings(paths.config, { ...current, defaultProviderId: "mock" });
        }
      }
    },
    removeProvider(id) {
      const current = loadSettings(paths.config);
      const provider = current.providers.find((p) => p.id === id);
      if (!provider) throw new Error("找不到这个模型供应商");
      if (current.defaultProviderId === id) {
        throw new Error("不能删除当前默认供应商，请先改用别的默认项");
      }
      if (provider.type === "mock") {
        throw new Error("内置 Mock 不能删除");
      }
      const merged = settingsSchema.parse({
        ...current,
        providers: current.providers.filter((p) => p.id !== id).map((p) => ({ ...p, hasApiKey: false })),
      });
      saveSettings(paths.config, merged);
      const secrets = loadSecrets(paths.secrets);
      delete secrets.providers[id];
      saveSecrets(paths.secrets, secrets);
      return workspace.readSettings();
    },
    getProviderKey(id) {
      // 只从本机 secrets.json 读取，不使用环境变量或 CLI 配置。
      return loadSecrets(paths.secrets).providers[id];
    },
    resolveProvider(id) {
      const current = workspace.readSettings();
      const providerId = id ?? current.defaultProviderId ?? current.providers[0]?.id;
      const config = current.providers.find((p) => p.id === providerId);
      if (!config) return new MockProvider("mock");
      if (config.type === "mock") return new MockProvider(config.id, config.modelId);
      const key = workspace.getProviderKey(config.id);
      if (!key || !config.baseUrl) {
        throw new Error("这个供应商还没有配置接口地址或密钥，请先到设置里补全，或改用 Mock。");
      }
      return new OpenAiCompatibleProvider(config.id, config.modelId, config.baseUrl, key, options.fetchImpl);
    },
    audit(event) {
      recordAudit(db, event, { timezone: workspace.readSettings().timezone, jsonlPath: paths.auditLog });
    },
  };

  return workspace;
}

function pathJoin(a: string, b: string): string {
  return `${a.replace(/\/$/, "")}/${b}`;
}

export function defaultSettings(): Settings {
  return settingsSchema.parse({
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    displayName: DEFAULT_DISPLAY_NAME,
    assistantName: DEFAULT_ASSISTANT_NAME,
    proactivity: "off",
    autoAcceptLowRiskMemoryPatches: false,
    memoryReflectEnabled: false,
    defaultProviderId: "mock",
    providers: [
      {
        id: "mock",
        type: "mock",
        name: "Mock（演示）",
        modelId: "mock-ye",
        hasApiKey: false,
      },
    ],
    onboardingCompleted: false,
  });
}

/**
 * 引导刚完成、而且这次请求里没自己选主动级别时，默认从「只到锚点提醒」开始。
 * 已经完成过引导的工作区不动；请求里带了 proactivity（哪怕是 off）也照用户说的算。
 */
function onboardingProactivity(
  current: Settings,
  patch: Partial<Settings> | Settings,
): { proactivity?: Settings["proactivity"] } {
  if (patch.onboardingCompleted !== true) return {};
  if (current.onboardingCompleted === true) return {};
  if ("proactivity" in patch) return {};
  return { proactivity: "anchors_only" };
}

function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    const settings = defaultSettings();
    saveSettings(file, settings);
    return settings;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return settingsSchema.parse({ ...defaultSettings(), ...(raw as object) });
  } catch {
    return defaultSettings();
  }
}

function saveSettings(file: string, settings: Settings): void {
  const stored = { ...settings, providers: settings.providers.map((p) => ({ ...p, hasApiKey: false })) };
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}

function loadSecrets(file: string): SecretsFile {
  return loadSecretsFile(file);
}

function saveSecrets(file: string, secrets: SecretsFile): void {
  saveSecretsFile(file, { providers: secrets.providers ?? {}, channels: secrets.channels ?? {} });
}


function assertDefaultProviderAllowed(settings: Settings, secrets: SecretsFile): void {
  const defaultId = settings.defaultProviderId;
  if (!defaultId) return;
  const provider = settings.providers.find((p) => p.id === defaultId);
  if (!provider) throw new Error("默认供应商不存在");
  if (provider.type !== "mock" && !secrets.providers[provider.id]) {
    throw new Error("不能把还没有密钥的供应商设为默认，请先保存密钥，或继续使用 Mock");
  }
}

function withKeyFlags(settings: Settings, secrets: SecretsFile): Settings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({
      ...provider,
      hasApiKey: Boolean(secrets.providers[provider.id]),
    })),
  };
}

function stripKeys<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripKeys(item)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(apiKey|api_key|secret|authorization)$/i.test(key)) continue;
    out[key] = stripKeys(child);
  }
  return out as T;
}
