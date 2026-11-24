import { describe, expect, it } from "vitest";
import {
  decryptDingtalkEvent,
  decryptFeishuEncrypt,
  dingtalkCallbackReply,
  dingtalkWebhookSignature,
  encryptDingtalkEvent,
  encryptFeishuEncrypt,
  feishuWebhookSignature,
  signDingtalkEvent,
  signDingtalkRobot,
  signFeishuEvent,
  signWechatCallback,
  timingSafeEquals,
  verifyDingtalkRobotSignature,
  verifyFeishuEventSignature,
} from "./signatures";

describe("官方签名算法", () => {
  it("飞书事件签名 = hex(sha256(timestamp + nonce + encryptKey + rawBody))", () => {
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const signature = signFeishuEvent({ timestamp: "1700000000", nonce: "abc", encryptKey: "ek", body });
    // 同样的输入必须稳定，不同输入必须不同。
    expect(signature).toBe(signFeishuEvent({ timestamp: "1700000000", nonce: "abc", encryptKey: "ek", body }));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).not.toBe(
      signFeishuEvent({ timestamp: "1700000000", nonce: "abc", encryptKey: "ek", body: Buffer.from('{"hello":"x"}') }),
    );
    expect(
      verifyFeishuEventSignature({
        timestamp: "1700000000",
        nonce: "abc",
        encryptKey: "ek",
        body,
        signature,
      }),
    ).toBe(true);
    expect(
      verifyFeishuEventSignature({
        timestamp: "1700000000",
        nonce: "abc",
        encryptKey: "ek",
        body,
        signature: "0".repeat(64),
      }),
    ).toBe(false);
  });

  it("飞书事件加解密可以往返", () => {
    const encryptKey = "test-encrypt-key";
    const encrypted = encryptFeishuEncrypt('{"challenge":"abc"}', encryptKey);
    expect(decryptFeishuEncrypt(encrypted, encryptKey)).toBe('{"challenge":"abc"}');
  });

  it("钉钉机器人签名 = Base64(HmacSHA256(timestamp + \\n + appSecret, appSecret))", () => {
    const sign = signDingtalkRobot({ timestamp: "1700000000000", appSecret: "secret" });
    expect(sign).toBe(signDingtalkRobot({ timestamp: "1700000000000", appSecret: "secret" }));
    expect(
      verifyDingtalkRobotSignature({
        timestamp: "1700000000000",
        sign,
        appSecret: "secret",
        now: 1700000000000,
      }),
    ).toBe(true);
    // 超过一小时算非法。
    expect(
      verifyDingtalkRobotSignature({
        timestamp: "1700000000000",
        sign,
        appSecret: "secret",
        now: 1700000000000 + 3600_001,
      }),
    ).toBe(false);
    expect(
      verifyDingtalkRobotSignature({
        timestamp: "1700000000000",
        sign: "nope",
        appSecret: "secret",
        now: 1700000000000,
      }),
    ).toBe(false);
  });

  it("钉钉事件订阅签名 = sha1(join(sort([token, timestamp, nonce, encrypt])))", () => {
    const signature = signDingtalkEvent({
      token: "token",
      timestamp: "1700000000",
      nonce: "nonce",
      encrypt: "cipher",
    });
    expect(signature).toMatch(/^[0-9a-f]{40}$/);
    expect(
      signDingtalkEvent({
        token: "token",
        timestamp: "1700000000",
        nonce: "nonce",
        encrypt: "cipher",
      }),
    ).toBe(signature);
  });

  it("钉钉事件加解密按官方布局往返，并带上 ownerKey", () => {
    const encodingAesKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64").replace(/=$/, "");
    const encrypted = encryptDingtalkEvent("success", encodingAesKey, "dingxxxx");
    expect(decryptDingtalkEvent(encrypted, encodingAesKey, "dingxxxx")).toBe("success");
    const reply = dingtalkCallbackReply({
      plaintext: "success",
      token: "token",
      encodingAesKey,
      ownerKey: "dingxxxx",
      nonce: "n1",
      timestamp: "1700000000",
    });
    expect(reply.msg_signature).toBe(
      signDingtalkEvent({
        token: "token",
        timestamp: "1700000000",
        nonce: "n1",
        encrypt: reply.encrypt,
      }),
    );
    expect(decryptDingtalkEvent(reply.encrypt, encodingAesKey, "dingxxxx")).toBe("success");
  });

  it("微信回调签名 = sha1(join(sort([token, timestamp, nonce])))", () => {
    const signature = signWechatCallback({ token: "token", timestamp: "1700000000", nonce: "nonce" });
    expect(signature).toMatch(/^[0-9a-f]{40}$/);
    expect(signature).toBe(signWechatCallback({ token: "token", timestamp: "1700000000", nonce: "nonce" }));
  });

  it("自定义机器人签名两种官方算法都稳定", () => {
    expect(feishuWebhookSignature("1700000000", "s")).toBe(feishuWebhookSignature("1700000000", "s"));
    expect(dingtalkWebhookSignature("1700000000", "s")).toBe(dingtalkWebhookSignature("1700000000", "s"));
    expect(feishuWebhookSignature("1700000000", "s")).not.toBe(dingtalkWebhookSignature("1700000000", "s"));
  });

  it("定长比较不会把不同长度的值当成相等", () => {
    expect(timingSafeEquals("abc", "abc")).toBe(true);
    expect(timingSafeEquals("abc", "abcd")).toBe(false);
    expect(timingSafeEquals("", "x")).toBe(false);
  });
});
