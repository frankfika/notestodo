import { z } from "zod";

export const memoryKindSchema = z.enum([
  "about_you",
  "diary",
  "upload",
  "system_summary",
  "other",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const provenanceSchema = z.enum(["owner", "agent", "untrusted", "system"]);
export type Provenance = z.infer<typeof provenanceSchema>;

export const memoryFileSchema = z.object({
  id: z.string().min(1),
  relativePath: z.string().min(1),
  title: z.string(),
  kind: memoryKindSchema,
  pinned: z.boolean(),
  readonly: z.boolean(),
  content: z.string(),
  frontmatter: z.record(z.unknown()),
  revision: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MemoryFile = z.infer<typeof memoryFileSchema>;

export const memoryTreeNodeSchema: z.ZodType<MemoryTreeNode> = z.lazy(() =>
  z.object({
    type: z.enum(["dir", "file"]),
    name: z.string(),
    relativePath: z.string(),
    kind: memoryKindSchema.optional(),
    pinned: z.boolean().optional(),
    readonly: z.boolean().optional(),
    children: z.array(memoryTreeNodeSchema).optional(),
  }),
);
export type MemoryTreeNode = {
  type: "dir" | "file";
  name: string;
  relativePath: string;
  kind?: MemoryKind;
  pinned?: boolean;
  readonly?: boolean;
  children?: MemoryTreeNode[];
};

export const memoryPatchSchema = z.object({
  id: z.string().min(1),
  targetPath: z.string().min(1),
  baseRevision: z.string().min(1),
  diff: z.string(),
  summary: z.string(),
  provenance: provenanceSchema,
  sourceRef: z.string().optional(),
  status: z.enum(["proposed", "accepted", "rejected", "expired"]),
  createdAt: z.string().min(1),
});
export type MemoryPatch = z.infer<typeof memoryPatchSchema>;

export const memoryActivitySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  actor: provenanceSchema,
  op: z.enum([
    "create",
    "update",
    "delete",
    "rename",
    "pin",
    "upload",
    "patch_accepted",
    "reflect",
  ]),
  path: z.string(),
  revision: z.string().optional(),
  message: z.string(),
  cursor: z.string().min(1),
});
export type MemoryActivity = z.infer<typeof memoryActivitySchema>;

export const memorySearchHitSchema = z.object({
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;

export const taskKindSchema = z.enum(["on_demand", "scheduled"]);
export type TaskKind = z.infer<typeof taskKindSchema>;

// 任务状态机是活页自己的实现合同，标为「推断后自定，待日后对照」。
export const taskStatusSchema = z.enum([
  "draft",
  "pending_confirmation",
  "running",
  "completed",
  "failed",
  "cancelled",
  "scheduled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskScheduleSchema = z.object({
  kind: z.enum(["once", "cron"]),
  runAt: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().min(1),
  enabled: z.boolean(),
  nextRunAt: z.string().optional(),
});
export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

export const taskSchema = z.object({
  id: z.string().min(1),
  kind: taskKindSchema,
  title: z.string().min(1),
  instruction: z.string(),
  status: taskStatusSchema,
  schedule: taskScheduleSchema.optional(),
  confirmationIds: z.array(z.string()),
  chatId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskRunEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  at: z.string().min(1),
  type: z.enum(["log", "tool_call", "confirmation", "status", "model"]),
  message: z.string(),
  payload: z.record(z.unknown()).optional(),
});
export type TaskRunEvent = z.infer<typeof taskRunEventSchema>;

export const confirmationRiskSchema = z.enum(["low", "medium", "high"]);
export type ConfirmationRisk = z.infer<typeof confirmationRiskSchema>;

export const confirmationStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "edited_approved",
  "expired",
]);
export type ConfirmationStatus = z.infer<typeof confirmationStatusSchema>;

export const confirmationRequestSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().optional(),
  status: confirmationStatusSchema,
  risk: confirmationRiskSchema,
  action: z.string().min(1),
  target: z.string(),
  summary: z.string(),
  preview: z.string(),
  editable: z.boolean(),
  toolPayload: z.record(z.unknown()),
  taskId: z.string().optional(),
  chatId: z.string().optional(),
  connectorId: z.string().optional(),
});
export type ConfirmationRequest = z.infer<typeof confirmationRequestSchema>;

export const usagePurposeSchema = z.enum([
  "conversation",
  "task",
  "scheduled_task",
  "brief",
  "memory_update",
  "reflect",
  "other",
]);
export type UsagePurpose = z.infer<typeof usagePurposeSchema>;

export const usageEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  purpose: usagePurposeSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  unitCostInUsd: z.number().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  source: z.enum(["byok", "relay"]),
  chatId: z.string().optional(),
  taskId: z.string().optional(),
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  actor: z.enum(["user", "agent", "system"]),
  type: z.string().min(1),
  summary: z.string(),
  refs: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const modelProviderTypeSchema = z.enum(["openai_compatible", "mock"]);
export type ModelProviderType = z.infer<typeof modelProviderTypeSchema>;

export const modelProviderConfigSchema = z.object({
  id: z.string().min(1),
  type: modelProviderTypeSchema,
  name: z.string().min(1),
  baseUrl: z.string().optional(),
  modelId: z.string().min(1),
  hasApiKey: z.boolean(),
  inputUsdPer1M: z.number().nonnegative().optional(),
  outputUsdPer1M: z.number().nonnegative().optional(),
});
export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

export const proactivitySchema = z.enum([
  "off",
  "anchors_only",
  "calendar_changes",
  "allowed_news",
]);
export type Proactivity = z.infer<typeof proactivitySchema>;

export const settingsSchema = z.object({
  language: z.enum(["zh-CN", "en"]),
  timezone: z.string().min(1),
  displayName: z.string(),
  assistantName: z.string().min(1),
  proactivity: proactivitySchema,
  autoAcceptLowRiskMemoryPatches: z.boolean(),
  memoryReflectEnabled: z.boolean(),
  /** MVP 只存值，整理作业不跑。推断，待日后对照。 */
  memoryReflectHour: z.string().optional(),
  defaultProviderId: z.string().optional(),
  providers: z.array(modelProviderConfigSchema),
  onboardingCompleted: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

export const chatSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Chat = z.infer<typeof chatSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().min(1),
  usageEventId: z.string().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const reflectJobStatusSchema = z.enum(["idle", "running", "completed", "failed"]);

/** 夜间整理钩子。MVP 只定义类型与「未启用」设置项，作业本身不跑。 */
export const reflectJobSchema = z.object({
  id: z.string().min(1),
  scheduledFor: z.string().min(1),
  status: reflectJobStatusSchema,
  reportPath: z.string().optional(),
  proposedPatches: z.array(memoryPatchSchema),
});
export type ReflectJob = z.infer<typeof reflectJobSchema>;

export const usageBucketSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  count: z.number().int().nonnegative(),
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;

export const usageSummarySchema = z.object({
  today: usageBucketSchema,
  month: usageBucketSchema,
  byPurpose: z.array(usageBucketSchema.extend({ purpose: usagePurposeSchema })),
  byModel: z.array(usageBucketSchema.extend({ provider: z.string(), model: z.string() })),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
