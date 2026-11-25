import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FOLDER_ERROR } from "@huoye/connectors";
import { createApp } from "./app";

function tempApp() {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-folder-http-"));
  const created = createApp({ home });
  return { app: created.app, home };
}

describe("本地文件夹连接器 HTTP", () => {
  it("可以添加、列出顶层内容并移除，记录写在工作区而不是仓库里", async () => {
    const { app, home } = tempApp();
    const root = path.join(home, "attached");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "note.md"), "hi\n");
    mkdirSync(path.join(root, "docs"));

    const added = await app.request("/api/connectors/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    expect(added.status).toBe(200);
    const addedBody = (await added.json()) as { roots: string[]; folders: Array<{ path: string; status: string }> };
    expect(addedBody.roots).toEqual([root]);
    expect(addedBody.folders).toEqual([{ path: root, status: "connected" }]);

    const listed = await app.request("/api/connectors");
    const catalog = (await listed.json()) as {
      items: Array<{ id: string; status: string; roots?: string[]; folders?: Array<{ status: string }> }>;
    };
    const local = catalog.items.find((item) => item.id === "local-folders");
    expect(local?.status).toBe("connected");
    expect(local?.roots).toEqual([root]);

    const listing = await app.request(`/api/connectors/local-folders/listing?path=${encodeURIComponent(root)}`);
    expect(listing.status).toBe(200);
    const listingBody = (await listing.json()) as { entries: Array<{ name: string; kind: string }> };
    expect(listingBody.entries).toEqual([
      { name: "docs", kind: "directory" },
      { name: "note.md", kind: "file" },
    ]);

    const removed = await app.request("/api/connectors/local-folders", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as { roots: string[] };
    expect(removedBody.roots).toEqual([]);
    const after = (await (await app.request("/api/connectors")).json()) as {
      items: Array<{ id: string; status: string; roots?: string[] }>;
    };
    expect(after.items.find((item) => item.id === "local-folders")?.status).toBe("not_connected");
  });

  it("拒绝空路径和家目录范围的添加", async () => {
    const { app } = tempApp();
    for (const value of ["", "   ", "~", os.homedir(), "/", "/home"]) {
      const res = await app.request("/api/connectors/local-folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: value, confirmHome: true }),
      });
      expect(res.status, value).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error === FOLDER_ERROR.empty || body.error === FOLDER_ERROR.home).toBe(true);
    }
    const catalog = (await (await app.request("/api/connectors")).json()) as {
      items: Array<{ id: string; status: string; roots?: string[] }>;
    };
    expect(catalog.items.find((item) => item.id === "local-folders")?.roots ?? []).toEqual([]);
  });

  it("缺失目录是明确错误，不会标成已连接", async () => {
    const { app, home } = tempApp();
    const missing = path.join(home, "does-not-exist");
    const res = await app.request("/api/connectors/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: missing }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(FOLDER_ERROR.missing);

    const later = path.join(home, "will-go");
    mkdirSync(later);
    await app.request("/api/connectors/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: later }),
    });
    rmdirSync(later);
    const catalog = (await (await app.request("/api/connectors")).json()) as {
      items: Array<{ id: string; status: string; folders?: Array<{ error?: string; status: string }> }>;
    };
    const local = catalog.items.find((item) => item.id === "local-folders");
    expect(local?.status).toBe("error");
    expect(local?.folders?.[0]?.status).toBe("error");
    expect(local?.folders?.[0]?.error).toBe(FOLDER_ERROR.missing);
  });

  it("列出内容时不跟随指向外部的符号链接", async () => {
    const { app, home } = tempApp();
    const root = path.join(home, "allowed");
    const outside = path.join(home, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "nope\n");
    symlinkSync(outside, path.join(root, "escape"));
    await app.request("/api/connectors/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    const listing = await app.request(`/api/connectors/local-folders/listing?path=${encodeURIComponent(root)}`);
    const body = (await listing.json()) as { entries: Array<{ name: string; kind: string; outside?: boolean }> };
    expect(body.entries).toEqual([{ name: "escape", kind: "symlink", outside: true }]);
    expect(JSON.stringify(body)).not.toContain("secret.txt");
  });
});
