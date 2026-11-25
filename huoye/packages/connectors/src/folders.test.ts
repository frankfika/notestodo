import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FOLDER_ERROR,
  LocalFolderRegistry,
  describeFolderFsError,
  isDisallowedRoot,
  listTopLevel,
  normalizeFolderInput,
  publicCatalog,
} from "./index";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function registry(): { home: string; folders: LocalFolderRegistry; store: string } {
  const home = tempDir("huoye-folders-");
  const store = path.join(home, "data", "local-folders.json");
  return { home, folders: new LocalFolderRegistry(store), store };
}

afterEach(() => {
  // 权限测试会把目录改成 000，先恢复以免清理失败。
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
  }
});

describe("normalizeFolderInput / 拒绝范围过大的路径", () => {
  it("拒绝空路径、空白、单独的 ~ 和 $HOME", () => {
    for (const value of ["", "   ", "~", "~/", "~/.", "$HOME", "$HOME/", "${HOME}"]) {
      expect(() => normalizeFolderInput(value)).toThrow();
    }
    try {
      normalizeFolderInput("");
    } catch (error) {
      expect((error as Error).message).toBe(FOLDER_ERROR.empty);
    }
    try {
      normalizeFolderInput("~");
    } catch (error) {
      expect((error as Error).message).toBe(FOLDER_ERROR.home);
    }
  });

  it("拒绝家目录、/home 和磁盘根，不把它们当成默认可选项", () => {
    expect(isDisallowedRoot(os.homedir())).toBe(true);
    expect(isDisallowedRoot("/")).toBe(true);
    expect(isDisallowedRoot("/home")).toBe(true);
    expect(isDisallowedRoot("/Users")).toBe(true);
    const nested = path.join(os.homedir(), "Documents");
    expect(isDisallowedRoot(nested)).toBe(false);
  });

  it("拒绝相对路径，避免按服务器当前目录去猜", () => {
    expect(() => normalizeFolderInput("Documents")).toThrow(FOLDER_ERROR.relative);
    expect(() => normalizeFolderInput("./notes")).toThrow(FOLDER_ERROR.relative);
  });

  it("~/具体目录 会展开，但不会把家目录本身放行", () => {
    const expanded = normalizeFolderInput("~/Documents/huoye-notes");
    expect(expanded).toBe(path.resolve(path.join(os.homedir(), "Documents/huoye-notes")));
    expect(isDisallowedRoot(expanded)).toBe(false);
  });
});

describe("LocalFolderRegistry", () => {
  it("添加后持久化，移除后从工作区文件里删掉", () => {
    const { folders, store } = registry();
    const oneRaw = path.join(tempDir("huoye-folder-a-"), "notes");
    const twoRaw = path.join(tempDir("huoye-folder-b-"), "photos");
    mkdirSync(oneRaw, { recursive: true });
    mkdirSync(twoRaw, { recursive: true });
    // macOS 上 os.tmpdir() 是 /var 的符号链接，注册表保存的是规范化后的真实路径。
    const one = realpathSync(oneRaw);
    const two = realpathSync(twoRaw);

    const added = folders.add(oneRaw);
    expect(added).toEqual([one]);
    folders.add(twoRaw);
    expect(existsSync(store)).toBe(true);
    const saved = JSON.parse(readFileSync(store, "utf8")) as { localFolders: string[] };
    expect(saved.localFolders).toEqual([one, two]);

    const after = folders.remove(oneRaw);
    expect(after).toEqual([two]);
    const savedAgain = JSON.parse(readFileSync(store, "utf8")) as { localFolders: string[] };
    expect(savedAgain.localFolders).toEqual([two]);
    expect(folders.inspect()).toEqual([{ path: two, status: "connected" }]);
  });

  it("拒绝空路径和家目录范围的添加，即使带上旧的二次确认参数也不会写入", () => {
    const { folders, store } = registry();
    expect(() => folders.add("")).toThrow(FOLDER_ERROR.empty);
    expect(() => folders.add("~")).toThrow(FOLDER_ERROR.home);
    expect(() => folders.add(os.homedir())).toThrow(FOLDER_ERROR.home);
    expect(() => folders.add("/")).toThrow(FOLDER_ERROR.home);
    expect(() => folders.add("/home")).toThrow(FOLDER_ERROR.home);
    expect(existsSync(store)).toBe(false);
    expect(folders.list()).toEqual([]);
  });

  it("目录不存在时给出明确错误，不会标成已连接", () => {
    const { folders } = registry();
    const missing = path.join(tempDir("huoye-folder-missing-"), "no-such-dir");
    expect(() => folders.add(missing)).toThrow(FOLDER_ERROR.missing);
    expect(folders.list()).toEqual([]);
    expect(publicCatalog(folders).find((item) => item.id === "local-folders")?.status).toBe("not_connected");
  });

  it("已经添加的目录后来被删掉时，状态是错误而不是已连接", () => {
    const { folders } = registry();
    const dirRaw = path.join(tempDir("huoye-folder-gone-"), "later-gone");
    mkdirSync(dirRaw, { recursive: true });
    const dir = realpathSync(dirRaw);
    folders.add(dirRaw);
    rmdirSync(dirRaw);
    const views = folders.inspect();
    expect(views).toEqual([{ path: dir, status: "error", error: FOLDER_ERROR.missing }]);
    const catalogItem = publicCatalog(folders).find((item) => item.id === "local-folders");
    expect(catalogItem?.status).toBe("error");
    expect(catalogItem?.folders?.[0]?.error).toBe(FOLDER_ERROR.missing);
  });

  it("指向家目录的符号链接不会被添加", () => {
    const { folders } = registry();
    const holder = tempDir("huoye-folder-symlink-home-");
    const link = path.join(holder, "to-home");
    symlinkSync(os.homedir(), link);
    expect(() => folders.add(link)).toThrow(FOLDER_ERROR.home);
    expect(folders.list()).toEqual([]);
  });

  it("列出顶层内容时，不会跟随指向允许根目录之外的符号链接", () => {
    const { folders } = registry();
    const root = path.join(tempDir("huoye-folder-root-"), "allowed");
    const outside = path.join(tempDir("huoye-folder-out-"), "secret");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "do-not-read\n");
    writeFileSync(path.join(root, "readme.md"), "ok\n");
    mkdirSync(path.join(root, "sub"));
    symlinkSync(outside, path.join(root, "escape"));

    folders.add(root);
    const listing = folders.listing(root);
    expect(listing.status).toBe("connected");
    expect(listing.entries).toEqual([
      { name: "escape", kind: "symlink", outside: true },
      { name: "readme.md", kind: "file" },
      { name: "sub", kind: "directory" },
    ]);
    expect(JSON.stringify(listing)).not.toContain("secret.txt");
    expect(JSON.stringify(listing)).not.toContain(outside);

    const direct = listTopLevel(root);
    expect(direct.entries.find((entry) => entry.name === "escape")?.outside).toBe(true);
  });

  it("没有读取权限时给出明确错误", () => {
    const { folders } = registry();
    const dir = path.join(tempDir("huoye-folder-perm-"), "locked");
    mkdirSync(dir, { recursive: true });
    folders.add(dir);
    chmodSync(dir, 0);
    try {
      const view = folders.inspect()[0];
      expect(view.status).toBe("error");
      expect(view.error).toBe(FOLDER_ERROR.permission);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("把 EACCES 映射成可读的权限错误", () => {
    const mapped = describeFolderFsError(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    expect(mapped).toEqual({ message: FOLDER_ERROR.permission, code: "permission" });
  });
});
