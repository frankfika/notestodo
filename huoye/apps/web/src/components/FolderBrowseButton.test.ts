import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { hasDesktopFolderPicker } from "../lib/desktop-folder-picker";
import { FolderBrowseButton } from "./FolderBrowseButton";

describe("桌面文件夹「浏览…」按钮", () => {
  it("没有桌面 preload 时检测为否，并且不渲染按钮（网页版不应出现）", () => {
    expect(hasDesktopFolderPicker(undefined)).toBe(false);
    expect(hasDesktopFolderPicker(null)).toBe(false);
    expect(hasDesktopFolderPicker({})).toBe(false);
    expect(hasDesktopFolderPicker({ pickLocalFolder: "nope" })).toBe(false);
    const html = renderToStaticMarkup(createElement(FolderBrowseButton, { onPicked: () => undefined }));
    expect(html).toBe("");
    expect(html).not.toContain("浏览");
  });

  it("注入了 pickLocalFolder 时渲染「浏览…」按钮", () => {
    const pickLocalFolder = vi.fn(async () => "/tmp/notes");
    expect(hasDesktopFolderPicker({ pickLocalFolder })).toBe(true);
    const html = renderToStaticMarkup(
      createElement(FolderBrowseButton, { desktop: { pickLocalFolder }, onPicked: () => undefined }),
    );
    expect(html).toContain("浏览…");
    expect(html).toContain("<button");
  });
});
