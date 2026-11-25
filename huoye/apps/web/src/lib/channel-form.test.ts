import { describe, expect, it } from "vitest";
import type { ChannelFieldView } from "./api";
import {
  CHANNEL_SAVE_INCOMPLETE_ERROR,
  ChannelFormError,
  channelSaveErrorKeys,
  channelSaveErrorMessage,
  unresolvedChannelFields,
} from "./channel-form";

const FEISHU_FIELDS: ChannelFieldView[] = [
  { key: "appId", label: "App ID", type: "text", required: true, placeholder: "cli_x" },
  { key: "appSecret", label: "App Secret", type: "secret", required: true, placeholder: "secret" },
  { key: "verificationToken", label: "Verification Token", type: "secret", required: true, placeholder: "token" },
  { key: "encryptKey", label: "Encrypt Key", type: "secret", required: false, placeholder: "optional" },
];

describe("unresolvedChannelFields", () => {
  it("marks every required field when the draft is empty and nothing is saved", () => {
    expect(unresolvedChannelFields(FEISHU_FIELDS, undefined)).toEqual([
      "appId",
      "appSecret",
      "verificationToken",
    ]);
    expect(unresolvedChannelFields(FEISHU_FIELDS, {})).toEqual([
      "appId",
      "appSecret",
      "verificationToken",
    ]);
  });

  it("ignores optional fields and treats whitespace as empty", () => {
    const missing = unresolvedChannelFields(FEISHU_FIELDS, {
      appId: "  ",
      appSecret: "secret",
      verificationToken: "token",
      encryptKey: "",
    });
    expect(missing).toEqual(["appId"]);
  });

  it("keeps a configured secret if the user has not typed a replacement", () => {
    const fields: ChannelFieldView[] = [
      { key: "appId", label: "App ID", type: "text", required: true, placeholder: "", value: "cli_saved" },
      { key: "appSecret", label: "App Secret", type: "secret", required: true, placeholder: "", configured: true },
      { key: "verificationToken", label: "Verification Token", type: "secret", required: true, placeholder: "", configured: true },
    ];
    expect(unresolvedChannelFields(fields, undefined)).toEqual([]);
    expect(unresolvedChannelFields(fields, { appId: "cli_new" })).toEqual([]);
  });

  it("treats a cleared draft value as missing, even if a secret was previously configured", () => {
    const fields: ChannelFieldView[] = [
      { key: "appId", label: "App ID", type: "text", required: true, placeholder: "", value: "cli_saved" },
      { key: "appSecret", label: "App Secret", type: "secret", required: true, placeholder: "", configured: true },
    ];
    expect(unresolvedChannelFields(fields, { appId: "", appSecret: "  " })).toEqual(["appId", "appSecret"]);
  });
});

describe("channel save error copy", () => {
  it("uses the inline incomplete message for missing required fields", () => {
    const error = new ChannelFormError(CHANNEL_SAVE_INCOMPLETE_ERROR, ["appId"]);
    expect(channelSaveErrorMessage(error)).toBe("还缺必填项，没有保存");
    expect(channelSaveErrorKeys(error, FEISHU_FIELDS, {})).toEqual(["appId"]);
  });

  it("maps the API incomplete error to the same Chinese copy and field keys", () => {
    const error = new Error("还没有填完必填项，通道仍是未连接。");
    expect(channelSaveErrorMessage(error)).toBe("还缺必填项，没有保存");
    expect(channelSaveErrorKeys(error, FEISHU_FIELDS, { appId: "cli_x" })).toEqual([
      "appSecret",
      "verificationToken",
    ]);
  });

  it("keeps unrelated save failures verbatim", () => {
    expect(channelSaveErrorMessage(new Error("无法写入密钥文件"))).toBe("无法写入密钥文件");
  });
});
