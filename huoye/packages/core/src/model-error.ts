/** 把模型接口失败收成给用户看的一句中文，不带 JSON、堆栈或密钥。 */

const KEY_LIKE = /sk-[A-Za-z0-9_-]+/g;

export function extractModelFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return extractReasonFromText(raw);
}

function extractReasonFromText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";

  const already = text.match(/^模型这次没有写出来（(.+?)）/);
  if (already?.[1]) return sanitizeReason(already[1]);

  let reason = "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string }; message?: string };
      const msg = parsed.error?.message ?? parsed.message;
      if (typeof msg === "string" && msg.trim()) reason = msg.trim();
    } catch {
      // 无法解析的载荷直接丢掉，不用原文。
    }
  }
  if (!reason) {
    const status = text.match(/模型接口请求失败（(\d+)）/);
    if (status) reason = `接口返回 ${status[1]}`;
  }
  return sanitizeReason(reason);
}

export function sanitizeReason(reason: string): string {
  let out = reason.replace(KEY_LIKE, "").replace(/\{[\s\S]*\}/g, "").replace(/\s+/g, " ").trim();
  const firstLine = (out.split("\n")[0] ?? "").trim();
  out = firstLine.replace(/\s+at\s+\S+.*$/, "").trim();
  if (out.length > 80) out = `${out.slice(0, 80)}…`;
  return out;
}

export function modelErrorMessage(error: unknown): string {
  const reason = extractModelFailureReason(error);
  return reason ? `模型这次没有写出来（${reason}）。` : "模型这次没有写出来。";
}

export function modelFallbackMessage(error: unknown): string {
  const reason = extractModelFailureReason(error);
  return reason
    ? `模型这次没有写出来（${reason}），已改用本地档案整理一版。`
    : "模型这次没有写出来，已改用本地档案整理一版。";
}

export function modelHttpError(status: number, bodyText = ""): Error {
  const reason = extractReasonFromText(bodyText) || (status ? `接口返回 ${status}` : "");
  return new Error(reason ? `模型这次没有写出来（${reason}）。` : "模型这次没有写出来。");
}
