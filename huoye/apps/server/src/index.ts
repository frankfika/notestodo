import { serve } from "@hono/node-server";
import { getApiPort, getHost, getHuoyeHome } from "@huoye/config";
import { createApp } from "./app";

const host = getHost();
const port = getApiPort();
const home = getHuoyeHome();

if (host !== "127.0.0.1" && host !== "localhost") {
  console.warn(`警告：API 正绑定 ${host}。写接口默认应只监听 127.0.0.1。`);
}

const { app, workspace, startScheduler } = createApp({ home });
startScheduler();

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`活页 API  http://${info.address}:${info.port}`);
  console.log(`工作区    ${workspace.home}`);
});
