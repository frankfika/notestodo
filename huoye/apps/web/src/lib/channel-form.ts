import type { ChannelFieldView } from "./api";

export const CHANNEL_SAVE_INCOMPLETE_ERROR = "还缺必填项，没有保存";

export class ChannelFormError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "ChannelFormError";
  }
}

/** 当前草稿和已保存值合并后，仍缺的必填字段 key。已配置的密钥留空表示保持原样。 */
export function unresolvedChannelFields(
  fields: ChannelFieldView[],
  draft: Record<string, string> | undefined,
): string[] {
  return fields
    .filter((field) => {
      if (!field.required) return false;
      if (draft && Object.prototype.hasOwnProperty.call(draft, field.key)) {
        return draft[field.key].trim() === "";
      }
      if (field.type === "secret") return !field.configured;
      return !String(field.value ?? "").trim();
    })
    .map((field) => field.key);
}

export function isIncompleteChannelError(error: unknown): error is ChannelFormError {
  if (error instanceof ChannelFormError) return true;
  return error instanceof Error && /必填/.test(error.message);
}

export function channelSaveErrorMessage(error: unknown): string {
  if (isIncompleteChannelError(error)) return CHANNEL_SAVE_INCOMPLETE_ERROR;
  return error instanceof Error ? error.message : "保存失败";
}

export function channelSaveErrorKeys(
  error: unknown,
  fields: ChannelFieldView[],
  draft: Record<string, string> | undefined,
): string[] {
  if (error instanceof ChannelFormError && error.missing.length) return error.missing;
  return unresolvedChannelFields(fields, draft);
}
