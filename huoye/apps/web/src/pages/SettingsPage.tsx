import { Button, Card, PageHeader, Pill } from "@huoye/ui";
import type { Proactivity } from "@huoye/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router";
import { FolderBrowseButton } from "../components/FolderBrowseButton";
import { api, type ChannelView } from "../lib/api";
import {
  CHANNEL_SAVE_INCOMPLETE_ERROR,
  ChannelFormError,
  channelSaveErrorKeys,
  channelSaveErrorMessage,
  unresolvedChannelFields,
} from "../lib/channel-form";
import { pendingConfirmationCount } from "../lib/proactive";

const LINKS = [
  { to: "/settings/models", label: "模型" },
  { to: "/settings/connectors", label: "连接器" },
  { to: "/settings/channels", label: "通道" },
  { to: "/settings/skills", label: "Skills / MCP" },
  { to: "/settings/usage", label: "用量" },
  { to: "/settings/permissions", label: "待确认" },
  { to: "/settings/proactivity", label: "主动性" },
  { to: "/settings/workspace", label: "工作区" },
  { to: "/settings/export", label: "导出" },
];

export function SettingsPage() {
  const confirmations = useQuery({ queryKey: ["confirmations"], queryFn: api.confirmations });
  const pendingCount = (confirmations.data?.items ?? []).filter((item) => item.status === "pending").length;

  return (
    <div className="pt-4 grid md:grid-cols-[180px_minmax(0,1fr)] gap-6 items-start">
      <aside className="md:sticky md:top-2" style={{ paddingLeft: 14, borderLeft: "1px solid var(--hy-line)" }}>
        <div className="hy-eyebrow" style={{ paddingLeft: 10, marginBottom: 10 }}>
          设置
        </div>
        <nav className="flex md:flex-col flex-wrap gap-1">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `hy-settings-link block py-1.5 no-underline text-sm ${isActive ? "hy-settings-link-active" : ""}`
              }
            >
              <span className="flex items-center justify-between gap-2">
                {link.label}
                {link.to === "/settings/permissions" && pendingCount > 0 ? (
                  <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--hy-accent)] text-white text-[10px] leading-4 text-center">
                    {pendingCount}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <div>
        <Routes>
          <Route index element={<SettingsHome />} />
          <Route path="models" element={<ModelsSettings />} />
          <Route path="connectors" element={<ConnectorsSettings />} />
          <Route path="channels" element={<ChannelsSettings />} />
          <Route path="skills" element={<SkillsSettings />} />
          <Route path="usage" element={<UsageSettings />} />
          <Route path="permissions" element={<PermissionsSettings />} />
          <Route path="proactivity" element={<ProactivitySettings />} />
          <Route path="workspace" element={<WorkspaceSettings />} />
          <Route path="export" element={<ExportSettings />} />
        </Routes>
      </div>
    </div>
  );
}

const SETTINGS_INDEX = [
  { to: "/settings/models", title: "模型", text: "添加 MiniMax 或其他 OpenAI 兼容接口。密钥只保存在这台电脑上。" },
  { to: "/settings/channels", title: "通道", text: "飞书、钉钉、微信。没配好凭证时就是未连接。" },
  { to: "/settings/permissions", title: "待确认", text: "对外发消息或改核心档案，会先出现在这里。" },
  { to: "/settings/workspace", title: "工作区", text: "查看本机路径，修改称呼和助手名。" },
  { to: "/memories/about-you", title: "关于你", text: "基本档案在记忆里，可以随时打开改。" },
  { to: "/settings/proactivity", title: "主动性", text: "要不要在早上和晚上自动整理简报。" },
  { to: "/settings/usage", title: "用量", text: "只记录你自己的密钥用了多少，活页不出售额度。" },
  { to: "/settings/connectors", title: "连接器", text: "只添加你点选的本地文件夹，不会默默打开整个家目录。" },
  { to: "/settings/skills", title: "Skills / MCP", text: "入口还在，目前还不能接入。" },
  { to: "/settings/export", title: "导出", text: "把记忆打包下载带走。" },
] as const;

function SettingsHome() {
  return (
    <>
      <PageHeader title="设置" description="密钥和记录都留在这台电脑上，没有付费墙。" />
      <div className="hy-list">
        {SETTINGS_INDEX.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="hy-list-row block no-underline"
            style={{ color: "var(--hy-ink)", paddingLeft: 12, paddingRight: 12 }}
          >
            <div className="flex items-baseline gap-4">
              <span style={{ fontSize: "var(--hy-fs-md)", minWidth: "7rem" }}>{item.title}</span>
              <span className="hy-muted" style={{ fontSize: "var(--hy-fs-base)", lineHeight: 1.7 }}>
                {item.text}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

const PROVIDER_PRESETS = [
  {
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn/v1",
    modelId: "MiniMax-M3.1-Flash",
    label: "MiniMax（国内）",
  },
  {
    name: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    modelId: "MiniMax-M3.1-Flash",
    label: "MiniMax（国际）",
  },
  {
    name: "OpenAI 兼容",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4.1-mini",
    label: "其他 OpenAI 兼容接口",
  },
] as const;

function ModelsSettings() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [name, setName] = useState("OpenAI 兼容");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelId, setModelId] = useState("gpt-4.1-mini");
  const [key, setKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const current = settings.data;
      if (!current) return;
      setFormError("");
      if (editingId) {
        if (!key.trim()) throw new Error("请填写新的 API Key。");
        await api.saveKey(editingId, key.trim());
        return;
      }
      if (!key.trim()) {
        throw new Error("请先填写 API Key，再添加供应商。没有密钥时请继续使用 Mock。");
      }
      const id = `prv_${Math.random().toString(36).slice(2, 10)}`;
      const providers = [
        ...current.providers,
        {
          id,
          type: "openai_compatible" as const,
          name,
          baseUrl,
          modelId,
          hasApiKey: false,
        },
      ];
      await api.saveSettings({ providers });
      await api.saveKey(id, key.trim());
      await api.saveSettings({ defaultProviderId: id });
    },
    onSuccess: async () => {
      setKey("");
      setEditingId(null);
      setFormError("");
      await client.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "保存失败");
    },
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.saveSettings({ defaultProviderId: id }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["settings"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["settings"] }),
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "无法删除");
    },
  });

  return (
    <>
      <PageHeader title="模型与密钥" description="内置 Mock 用于无密钥演示。也可以添加 MiniMax 或其他 OpenAI 兼容接口。密钥由你自己提供，只保存在本机 secrets.json（权限 0600），不会出现在设置的读回结果里，也不会从环境变量里读取。" />
      <div className="space-y-3 mb-6">
        {(settings.data?.providers ?? []).map((provider) => (
          <Card key={provider.id} className="p-4 flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">{provider.name}</div>
              <div className="hy-faint text-xs">
                {provider.type} · {provider.modelId}
                {provider.hasApiKey ? " · 已配置密钥" : " · 未配置密钥"}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              {settings.data?.defaultProviderId === provider.id ? <Pill>默认</Pill> : (
                provider.type === "mock" || provider.hasApiKey ? (
                  <Button tone="ghost" className="!py-1" onClick={() => setDefault.mutate(provider.id)}>
                    设为默认
                  </Button>
                ) : null
              )}
              {provider.type !== "mock" ? (
                <Button tone="ghost" className="!py-1" onClick={() => setEditingId(provider.id)}>
                  更新密钥
                </Button>
              ) : null}
              {provider.type !== "mock" && settings.data?.defaultProviderId !== provider.id ? (
                <Button tone="ghost" className="!py-1" onClick={() => remove.mutate(provider.id)} disabled={remove.isPending}>
                  删除
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
      <Card className="p-5 space-y-3">
        <h3 className="hy-title text-xl m-0">{editingId ? "更新密钥" : "添加模型供应商"}</h3>
        {editingId ? null : (
          <>
            <p className="hy-muted text-sm">先选一个常用接口，再填写你自己的密钥。没有密钥时请继续使用 Mock，空密钥不能设为默认。</p>
            <div className="flex flex-wrap gap-2">
              {PROVIDER_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  tone="ghost"
                  className="!py-1"
                  type="button"
                  onClick={() => {
                    setName(preset.name);
                    setBaseUrl(preset.baseUrl);
                    setModelId(preset.modelId);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <input className="hy-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
            <input className="hy-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL" />
            <input className="hy-input" value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="模型 ID，例如 MiniMax-M3.1-Flash" />
          </>
        )}
        <input
          className="hy-input"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={editingId ? "新的密钥" : "API Key（只在保存时提交到专用接口）"}
        />
        {formError ? <p className="text-sm text-[var(--hy-danger)]">{formError}</p> : null}
        <div className="flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            保存
          </Button>
          {editingId ? (
            <Button tone="ghost" onClick={() => setEditingId(null)}>
              取消
            </Button>
          ) : null}
        </div>
      </Card>
    </>
  );
}

function connectorStatusLabel(status: string): string {
  if (status === "connected") return "已连接";
  if (status === "error") return "有问题";
  return "未连接";
}

function LocalFolderCard() {
  const client = useQueryClient();
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  const item = connectors.data?.items.find((entry) => entry.kind === "local");
  const folders = item?.folders ?? (item?.roots ?? []).map((path) => ({ path, status: "connected" as const }));
  const [folder, setFolder] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const listing = useQuery({
    queryKey: ["folder-listing", openPath],
    queryFn: () => api.folderListing(openPath!),
    enabled: Boolean(openPath),
  });

  const add = useMutation({
    mutationFn: (path: string) => api.addFolder(path),
    onSuccess: async () => {
      setFolder("");
      await client.invalidateQueries({ queryKey: ["connectors"] });
    },
  });
  const remove = useMutation({
    mutationFn: (path: string) => api.removeFolder(path),
    onSuccess: async (_data, path) => {
      if (openPath === path) setOpenPath(null);
      await client.invalidateQueries({ queryKey: ["connectors"] });
    },
  });

  return (
    <Card className="p-5 mb-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="hy-title text-xl m-0">{item?.name ?? "本地文件夹"}</h3>
        <Pill>{connectorStatusLabel(item?.status ?? "not_connected")}</Pill>
      </div>
      <p className="hy-muted text-sm">
        {item?.description ?? "由你添加具体的文件夹，不会自动扫描家目录或整块磁盘。"}
      </p>
      <p className="hy-muted text-sm">
        这里只会列出已添加文件夹的顶层内容，不会在添加时偷偷扫完整棵目录树，也不会把文件上传到云端。聊天和每日简报目前还不会自动引用这些文件夹。
      </p>
      {folders.length === 0 ? (
        <p className="text-sm">还没有添加文件夹。状态是未连接。</p>
      ) : (
        <ul className="text-sm p-0 m-0 list-none flex flex-col gap-3">
          {folders.map((entry) => (
            <li key={entry.path} className="border border-[var(--hy-line)] rounded-xl p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium break-all">{entry.path}</div>
                  <div className={entry.status === "error" ? "text-[var(--hy-danger)]" : "hy-muted"}>
                    {entry.status === "connected" ? "已连接，可读取" : entry.error ?? "未连接"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    tone="ghost"
                    type="button"
                    onClick={() => setOpenPath((current) => (current === entry.path ? null : entry.path))}
                    disabled={entry.status !== "connected"}
                  >
                    {openPath === entry.path ? "收起内容" : "查看内容"}
                  </Button>
                  <Button tone="danger" type="button" onClick={() => remove.mutate(entry.path)} disabled={remove.isPending}>
                    移除
                  </Button>
                </div>
              </div>
              {openPath === entry.path ? (
                <div className="mt-3">
                  {listing.isPending ? <p className="hy-muted">正在读取顶层内容…</p> : null}
                  {listing.error ? <p className="text-[var(--hy-danger)]">{listing.error.message}</p> : null}
                  {listing.data?.status === "error" ? (
                    <p className="text-[var(--hy-danger)]">{listing.data.error}</p>
                  ) : null}
                  {listing.data?.entries ? (
                    listing.data.entries.length === 0 ? (
                      <p className="hy-muted">这个文件夹是空的。</p>
                    ) : (
                      <ul className="m-0 pl-5">
                        {listing.data.entries.map((child) => (
                          <li key={child.name}>
                            {folderEntryLabel(child.kind)}
                            {child.name}
                            {child.outside ? "（指向所选文件夹以外的位置，已忽略）" : ""}
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                  {listing.data?.truncated ? (
                    <p className="hy-muted mt-2">只显示前 200 项，不会继续往下翻整棵目录树。</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          className="hy-input flex-1"
          placeholder="粘贴一个已存在的文件夹路径，例如 /home/you/Documents/notes"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <FolderBrowseButton
          desktop={typeof window !== "undefined" ? window.huoyeDesktop : undefined}
          onPicked={(path) => {
            setFolder(path);
            add.mutate(path);
          }}
          disabled={add.isPending}
        />
      </div>
      <Button className="mt-3" type="button" onClick={() => add.mutate(folder)} disabled={!folder.trim() || add.isPending}>
        添加文件夹
      </Button>
      {add.error ? <p className="text-sm text-[var(--hy-danger)]">{add.error.message}</p> : null}
      {remove.error ? <p className="text-sm text-[var(--hy-danger)]">{remove.error.message}</p> : null}
    </Card>
  );
}

function folderEntryLabel(kind: string): string {
  if (kind === "directory") return "文件夹 · ";
  if (kind === "file") return "文件 · ";
  if (kind === "symlink") return "链接 · ";
  return "其他 · ";
}

function ConnectorsSettings() {
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  const others = connectors.data?.items.filter((i) => i.kind === "cloud") ?? [];

  return (
    <>
      <PageHeader title="连接器" description="本地文件夹由你明确添加。活页不会默默打开整个家目录，目录不存在也不会假装已连接。" />
      <LocalFolderCard />
      {others.length === 0 ? <p className="hy-muted">云应用连接还没有接通。不连接也不影响聊天和记忆。</p> : null}
    </>
  );
}

function ChannelsSettings() {
  const client = useQueryClient();
  const channels = useQuery({ queryKey: ["channels"], queryFn: api.channels });
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [panelErrors, setPanelErrors] = useState<Record<string, string>>({});
  const [invalidFields, setInvalidFields] = useState<Record<string, string[]>>({});

  function clearPanelFeedback(id: string) {
    setPanelErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setInvalidFields((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  const save = useMutation({
    mutationFn: async (channel: ChannelView) => {
      const draft = drafts[channel.id] ?? {};
      const missing = unresolvedChannelFields(channel.fields, draft);
      if (missing.length) {
        throw new ChannelFormError(CHANNEL_SAVE_INCOMPLETE_ERROR, missing);
      }
      // 只提交有内容的字段：密钥不回显，留空表示保持原样。
      const payload: Record<string, string> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (value.trim()) payload[key] = value.trim();
      }
      return api.saveChannel(channel.id, payload);
    },
    onSuccess: async (_data, channel) => {
      setDrafts((prev) => ({ ...prev, [channel.id]: {} }));
      clearPanelFeedback(channel.id);
      await client.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (error, channel) => {
      setInvalidFields((prev) => ({
        ...prev,
        [channel.id]: channelSaveErrorKeys(error, channel.fields, drafts[channel.id]),
      }));
      setPanelErrors((prev) => ({
        ...prev,
        [channel.id]: channelSaveErrorMessage(error),
      }));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeChannel(id),
    onSuccess: async (_data, id) => {
      setDrafts((prev) => ({ ...prev, [id]: {} }));
      clearPanelFeedback(id);
      await client.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (error, id) => {
      setPanelErrors((prev) => ({
        ...prev,
        [id]: error instanceof Error ? error.message : "无法移除凭证",
      }));
    },
  });

  return (
    <>
      <PageHeader
        title="通道"
        description="在这些聊天工具里也可以和活页说话。没有配好凭证时是未连接，不会假装已经接通。"
      />
      <div className="space-y-3">
        {(channels.data?.items ?? []).map((channel) => (
          <Card key={channel.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="hy-title text-xl m-0">{channel.name}</h3>
                <div className="hy-muted text-sm mt-1">回调路径：{channel.eventPath}</div>
              </div>
              <Pill>{channel.status === "connected" ? "已连接" : "未连接"}</Pill>
            </div>
            <p className="hy-muted text-sm mt-2">{channel.description}</p>
            <p className="hy-muted text-sm mt-1">{channel.setupHint}</p>
            <div className="grid gap-2 mt-3">
              {channel.fields.map((field) => {
                const invalid = (invalidFields[channel.id] ?? []).includes(field.key);
                return (
                <label key={field.key} className="text-sm block">
                  <span className={invalid ? "text-[var(--hy-danger)]" : "hy-muted"}>
                    {field.label}
                    {field.required ? "（必填）" : "（可选）"}
                  </span>
                  <input
                    className={`hy-input${invalid ? " hy-input-invalid" : ""}`}
                    type={field.type === "secret" ? "password" : "text"}
                    placeholder={field.placeholder}
                    value={drafts[channel.id]?.[field.key] ?? field.value ?? ""}
                    aria-invalid={invalid}
                    aria-describedby={panelErrors[channel.id] ? `${channel.id}-save-error` : undefined}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDrafts((prev) => ({
                        ...prev,
                        [channel.id]: { ...prev[channel.id], [field.key]: value },
                      }));
                      setInvalidFields((prev) => {
                        const keys = (prev[channel.id] ?? []).filter((key) => key !== field.key);
                        return { ...prev, [channel.id]: keys };
                      });
                    }}
                  />
                </label>
                );
              })}
            </div>
            <div className="flex gap-2 mt-3">
              <Button onClick={() => save.mutate(channel)} disabled={save.isPending}>
                保存
              </Button>
              <Button tone="ghost" onClick={() => remove.mutate(channel.id)} disabled={remove.isPending}>
                移除凭证
              </Button>
            </div>
            {panelErrors[channel.id] ? (
              <p id={`${channel.id}-save-error`} className="text-sm text-[var(--hy-danger)] mt-2" role="alert">
                {panelErrors[channel.id]}
              </p>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}

function SkillsSettings() {
  return (
    <>
      <PageHeader title="Skills / MCP" description="可以添加自己的技能目录和 MCP。这一页先留着，还不能接入。" />
      <Card className="p-5">
        <Pill>即将到来</Pill>
        <p className="hy-muted">接入方式会兼容常见的 agent skill 文件夹约定，以及 stdio / HTTP MCP。</p>
      </Card>
    </>
  );
}

function UsageSettings() {
  const summary = useQuery({ queryKey: ["usage"], queryFn: api.usageSummary });
  const events = useQuery({ queryKey: ["usage-events"], queryFn: api.usageEvents });
  const today = summary.data?.today;
  const month = summary.data?.month;
  return (
    <>
      <PageHeader
        title="用量"
        description="费用按你填写的单价估算，方便对照自己的账单。活页不出售额度。"
      />
      <div className="grid gap-3 md:grid-cols-2 mb-5">
        <Card className="p-5">
          <div className="hy-faint text-xs">今日</div>
          <div className="hy-title text-3xl">{today?.totalTokens ?? 0}</div>
          <div className="hy-muted text-sm">token{today?.estimatedCostUsd != null ? ` · 约 $${today.estimatedCostUsd.toFixed(4)}` : ""}</div>
        </Card>
        <Card className="p-5">
          <div className="hy-faint text-xs">本月</div>
          <div className="hy-title text-3xl">{month?.totalTokens ?? 0}</div>
          <div className="hy-muted text-sm">token{month?.estimatedCostUsd != null ? ` · 约 $${month.estimatedCostUsd.toFixed(4)}` : ""}</div>
        </Card>
      </div>
      <h3 className="hy-title text-xl">最近调用</h3>
      {(events.data?.items ?? []).length === 0 ? (
        <p className="hy-muted">还没有用量记录。</p>
      ) : (
        <div className="space-y-2">
          {events.data?.items.slice(0, 20).map((event) => (
            <Card key={event.id} className="p-3 text-sm flex justify-between">
              <span>
                {event.provider} / {event.model} · {event.purpose}
              </span>
              <span className="hy-muted">{event.totalTokens} tokens</span>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function PermissionsSettings() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["confirmations"], queryFn: api.confirmations });
  const [editId, setEditId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const act = useMutation({
    mutationFn: async (input: { id: string; op: "approve" | "reject" | "edit"; preview?: string }) => {
      if (input.op === "approve") return api.approve(input.id);
      if (input.op === "reject") return api.reject(input.id);
      return api.editAndApprove(input.id, input.preview ?? "");
    },
    onSuccess: async () => {
      setEditId(null);
      await client.invalidateQueries({ queryKey: ["confirmations"] });
    },
  });

  return (
    <>
      <PageHeader title="待确认" description="对外写操作必须先经过这里。过期未处理视为拒绝，不会补执行。" />
      <div className="space-y-3">
        {(list.data?.items ?? []).map((item) => (
          <Card key={item.id} className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{item.summary}</div>
                <div className="hy-faint text-xs">
                  {item.target} · {item.action}
                </div>
              </div>
              <Pill>{item.status}</Pill>
            </div>
            <pre className="whitespace-pre-wrap text-sm bg-white/70 rounded-2xl p-3 mt-3 font-[var(--hy-font-mono)]">{item.preview}</pre>
            {item.status === "pending" ? (
              <div className="flex flex-wrap gap-2 mt-3">
                <Button onClick={() => act.mutate({ id: item.id, op: "approve" })}>批准</Button>
                <Button tone="ghost" onClick={() => act.mutate({ id: item.id, op: "reject" })}>
                  拒绝
                </Button>
                {item.editable ? (
                  <Button
                    tone="ghost"
                    onClick={() => {
                      setEditId(item.id);
                      setPreview(item.preview);
                    }}
                  >
                    编辑后批准
                  </Button>
                ) : null}
              </div>
            ) : null}
            {editId === item.id ? (
              <div className="mt-3">
                <textarea className="hy-textarea min-h-[6rem]" value={preview} onChange={(e) => setPreview(e.target.value)} />
                <Button className="mt-2" onClick={() => act.mutate({ id: item.id, op: "edit", preview })}>
                  保存并批准
                </Button>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}

function ProactivitySettings() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const proactive = useQuery({ queryKey: ["proactive-state"], queryFn: api.proactiveState });
  const [permission, setPermission] = useState<string>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [notice, setNotice] = useState("");
  const options: Array<{ id: Proactivity; label: string; hint: string }> = [
    { id: "off", label: "关闭", hint: "不自动生成简报，保持安静。" },
    { id: "anchors_only", label: "只在锚点", hint: "只在你设定的早上 / 晚上锚点主动出现。" },
    { id: "calendar_changes", label: "日历变化", hint: "日历有变化时再提醒。现在只保存这个选项，还不会按这个提醒。" },
    { id: "allowed_news", label: "允许的资讯", hint: "只推你允许的资讯来源。现在只保存这个选项，还不会按这个提醒。" },
  ];
  const save = useMutation({
    mutationFn: (proactivity: Proactivity) => api.saveSettings({ proactivity }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  const resume = useMutation({
    mutationFn: () => api.resumeProactive(),
    onSuccess: async () => {
      setNotice("已恢复主动更新。");
      await client.invalidateQueries({ queryKey: ["proactive-state"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "暂时恢复不了主动更新。"),
  });

  async function askNotificationPermission() {
    if (typeof Notification === "undefined") return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      setNotice(result === "granted" ? "已允许桌面通知。" : "这次没有拿到通知权限，之后不会再主动来问。");
    } catch {
      setPermission("denied");
      setNotice("这个浏览器没有答应通知权限，之后不会再主动来问。");
    }
  }

  const state = proactive.data;
  const pending = pendingConfirmationCount(state?.pendingConfirmations);
  const currentLabel = options.find((item) => item.id === state?.proactivity)?.label ?? state?.proactivity ?? "—";

  return (
    <>
      <PageHeader title="主动性" description="选择 off 时，活页不会自动生成简报。" />
      <div className="space-y-3">
        {options.map((option) => (
          <Card key={option.id} className="p-4 flex items-center justify-between gap-3">
            <div>
              <div>{option.label}</div>
              <div className="hy-muted text-sm">{option.hint}</div>
            </div>
            <Button
              tone={settings.data?.proactivity === option.id ? "primary" : "ghost"}
              onClick={() => save.mutate(option.id)}
            >
              {settings.data?.proactivity === option.id ? "当前" : "选择"}
            </Button>
          </Card>
        ))}
      </div>
      <Card className="p-4 mt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="font-medium">当前状态</div>
          {state ? <Pill>{state.paused ? "已暂停" : "没有暂停"}</Pill> : null}
        </div>
        {proactive.isError ? (
          <p className="hy-muted text-sm mt-2">主动状态暂时读不到，等服务端接上再来看。</p>
        ) : null}
        {state ? (
          <ul className="hy-muted text-sm mt-2" style={{ lineHeight: 1.9, paddingLeft: "1.1rem", margin: "8px 0 0" }}>
            <li>档位：{currentLabel}</li>
            <li>
              {state.paused
                ? `主动更新已经暂停${state.pausedAt ? `（${state.pausedAt}）` : ""}，恢复前不会再来找你。`
                : "主动更新没有被暂停。"}
            </li>
            <li>上次已读：{state.lastReadAt ?? "还没有已读记录"}</li>
            <li>
              待确认：{pending} 条{pending > 0 ? "（在「待确认」里由你决定）" : ""}
            </li>
          </ul>
        ) : null}
        {state?.paused ? (
          <Button className="mt-3" onClick={() => resume.mutate()} disabled={resume.isPending}>
            {resume.isPending ? "正在恢复…" : "恢复主动更新"}
          </Button>
        ) : null}
        {notice ? <p className="hy-muted text-xs mt-2">{notice}</p> : null}
      </Card>
      {permission === "unsupported" ? null : (
        <Card className="p-4 mt-4">
          <div className="font-medium">桌面通知</div>
          {permission === "granted" ? (
            <p className="hy-muted text-sm mt-2">
              已经允许。活页不在前台时会用一条短通知提醒你，详情留在聊天和今天页。
            </p>
          ) : permission === "denied" ? (
            <p className="hy-muted text-sm mt-2">
              已拒绝，不再询问。主动消息仍然会出现在聊天和今天页。
            </p>
          ) : (
            <>
              <p className="hy-muted text-sm mt-2">
                允许之后，活页不在前台时会用一条短通知提醒你一次。要不要问，由你点这个按钮决定。
              </p>
              <Button className="mt-2" onClick={() => void askNotificationPermission()}>
                允许桌面通知
              </Button>
            </>
          )}
        </Card>
      )}
      <Card className="p-4 mt-4">
        <div className="font-medium">整理时刻</div>
        <p className="hy-muted text-sm">夜间整理还没有启用。打开后，会把日记里的稳定事实整理成建议，再由你确认。</p>
        <Pill>未启用</Pill>
      </Card>
    </>
  );
}

function WorkspaceSettings() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const workspaceInfo = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const [displayName, setDisplayName] = useState("");
  const [assistantName, setAssistantName] = useState("");
  const loaded = settings.data;
  const name = displayName || loaded?.displayName || "";
  const assistant = assistantName || loaded?.assistantName || "";
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.saveSettings({ displayName: name, assistantName: assistant }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  return (
    <>
      <PageHeader title="工作区" description="记录都放在这台电脑的工作区里。路径如下。" />
      <Card className="p-5 mb-4">
        <div className="hy-faint text-xs">工作区路径（HUOYE_HOME）</div>
        <code className="text-sm break-all">{workspaceInfo.data?.home ?? "正在读取…"}</code>
        <p className="hy-muted text-sm">记忆目录：{workspaceInfo.data?.memory}</p>
        <p className="hy-muted text-sm">配置在 config.json，密钥在 secrets.json（权限 0600）。记忆可以用普通编辑器打开。</p>
        <p className="hy-faint text-xs">API 状态：{health.data?.ok ? "huoye 正常" : "尚未连上"}</p>
      </Card>
      <label className="block mb-3">
        <div className="text-sm hy-muted mb-1">称呼</div>
        <input className="hy-input" defaultValue={loaded?.displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="block mb-3">
        <div className="text-sm hy-muted mb-1">助手名</div>
        <input className="hy-input" defaultValue={loaded?.assistantName} onChange={(e) => setAssistantName(e.target.value)} />
      </label>
      <Button onClick={() => save.mutate()}>保存</Button>
    </>
  );
}

function ExportSettings() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="导出与删除" description="可以随时把记忆打包带走。" />
      <Card className="p-5">
        <p>下载一份包含全部记忆文件的压缩包。</p>
        <a className="hy-btn inline-flex mt-2" href="/api/export/memory.zip">
          下载记忆 zip
        </a>
        <p className="hy-muted text-sm mt-4">要删除全部数据，在磁盘上移除工作区目录即可。</p>
        <Button tone="ghost" className="mt-2" onClick={() => navigate("/memories")}>
          回到记忆
        </Button>
      </Card>
    </>
  );
}
