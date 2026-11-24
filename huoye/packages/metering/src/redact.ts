const SECRET_KEYS = [
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "secret",
  "password",
  "token",
  "access_token",
  "private_key",
];

export function redactSecrets<T>(value: T): T {
  return redact(value, new Set()) as T;
}

function redact(value: unknown, seen: Set<unknown>): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.includes(key.toLowerCase())) {
      out[key] = child ? "***" : child;
    } else {
      out[key] = redact(child, seen);
    }
  }
  return out;
}

export function assertNoSecret(serialized: string, secrets: string[]): void {
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      throw new Error("序列化日志含有密钥，已拒绝写出");
    }
  }
}
