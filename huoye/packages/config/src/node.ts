import os from "node:os";
import path from "node:path";
import { DEFAULT_API_PORT, DEFAULT_HOME_DIRNAME, DEFAULT_HOST, DEFAULT_WEB_PORT } from "./constants";

export function getHuoyeHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HUOYE_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), DEFAULT_HOME_DIRNAME);
}

export function getApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HUOYE_PORT;
  if (!raw) return DEFAULT_API_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`HUOYE_PORT 无效：${raw}`);
  }
  return n;
}

export function getWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HUOYE_WEB_PORT;
  if (!raw) return DEFAULT_WEB_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`HUOYE_WEB_PORT 无效：${raw}`);
  }
  return n;
}

export function getHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HUOYE_HOST?.trim() || DEFAULT_HOST;
}

export function workspacePaths(home: string) {
  return {
    home,
    config: path.join(home, "config.json"),
    secrets: path.join(home, "secrets.json"),
    agentDir: path.join(home, "agent"),
    agent: path.join(home, "agent", "AGENT.md"),
    memory: path.join(home, "memory"),
    data: path.join(home, "data"),
    sqlite: path.join(home, "data", "index.sqlite"),
    logs: path.join(home, "logs"),
    auditLog: path.join(home, "logs", "audit.jsonl"),
    tmp: path.join(home, "tmp"),
  };
}
