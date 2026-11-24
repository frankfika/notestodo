import { describe, expect, it } from "vitest";
import { pickedDirectoryPath } from "./picker";

describe("桌面文件夹选择", () => {
  it("取消或空结果不会当成选中了家目录或任意路径", () => {
    expect(pickedDirectoryPath({ canceled: true, filePaths: ["/home/someone"] })).toBeUndefined();
    expect(pickedDirectoryPath({ canceled: false, filePaths: [] })).toBeUndefined();
    expect(pickedDirectoryPath({ canceled: false, filePaths: ["  "] })).toBeUndefined();
  });

  it("只返回用户在对话框里选中的那一个路径", () => {
    expect(pickedDirectoryPath({ canceled: false, filePaths: ["/tmp/notes", "/tmp/other"] })).toBe("/tmp/notes");
  });
});
