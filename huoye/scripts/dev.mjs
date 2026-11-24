#!/usr/bin/env node
import { spawn } from "node:child_process";

const host = process.env.HUOYE_HOST || "127.0.0.1";
if (host === "0.0.0.0") {
  console.warn("警告：HUOYE_HOST=0.0.0.0 会把写接口暴露到所有网卡。默认应使用 127.0.0.1。");
}
const apiPort = process.env.HUOYE_PORT || "8787";
const webPort = process.env.HUOYE_WEB_PORT || "5173";
const home = process.env.HUOYE_HOME || "~/Huoye";

console.log("");
console.log("  活页（Huoye）");
console.log(`  API  http://${host}:${apiPort}`);
console.log(`  Web  http://${host}:${webPort}`);
console.log(`  工作区  ${home}  （可用 HUOYE_HOME 覆盖）`);
console.log("");

const child = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "-n",
    "api,web",
    "-c",
    "blue,green",
    "pnpm --filter @huoye/server dev",
    "pnpm --filter @huoye/web dev",
  ],
  { stdio: "inherit", shell: false },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
