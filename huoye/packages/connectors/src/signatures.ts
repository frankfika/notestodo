/**
 * 官方开放平台的签名 / 加解密算法。
 * 只实现官方文档写明的算法，方便用 fixture 复现。
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 按字典序排序（官方算法要求 join(sort([...]))）。 */
function sortedStrings(values: string[]): string[] {
  const out = [...values];
  for (let i = 1; i < out.length; i++) {
    const item = out[i];
    let j = i - 1;
    while (j >= 0 && out[j] > item) {
      out[j + 1] = out[j];
      j -= 1;
    }
    out[j + 1] = item;
  }
  return out;
}

export function sha1Hex(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

export function hmacSha256Base64(key: string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64");
}

/** 定长比较，避免用普通字符串比较泄露信息。 */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ---------------------------------- 飞书 / Lark ---------------------------------- */

/** signature = hex(sha256(timestamp + nonce + encryptKey + rawBodyBytes)) */
export function signFeishuEvent(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  body: Buffer | string;
}): string {
  const prefix = Buffer.from(`${input.timestamp}${input.nonce}${input.encryptKey}`, "utf8");
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, "utf8");
  return createHash("sha256").update(Buffer.concat([prefix, body])).digest("hex");
}

export function verifyFeishuEventSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  body: Buffer | string;
  signature: string;
}): boolean {
  return timingSafeEquals(signFeishuEvent(input), input.signature);
}

export function feishuEncryptKeyBytes(encryptKey: string): Buffer {
  return createHash("sha256").update(encryptKey, "utf8").digest();
}

/** 官方解密：base64 解码后前 16 字节是 iv，其余 AES-256-CBC / PKCS7。 */
export function decryptFeishuEncrypt(encrypt: string, encryptKey: string): string {
  const raw = Buffer.from(encrypt, "base64");
  if (raw.length <= 16) throw new Error("加密内容长度不对。");
  const decipher = createDecipheriv("aes-256-cbc", feishuEncryptKeyBytes(encryptKey), raw.subarray(0, 16));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

export function encryptFeishuEncrypt(plaintext: string, encryptKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", feishuEncryptKeyBytes(encryptKey), iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, body]).toString("base64");
}

/* ----------------------------------- 钉钉 ----------------------------------- */

/** 机器人 HTTP 模式：sign = Base64(HmacSHA256(timestamp + "\n" + appSecret, appSecret)) */
export function signDingtalkRobot(input: { timestamp: string; appSecret: string }): string {
  const stringToSign = `${input.timestamp}\n${input.appSecret}`;
  return hmacSha256Base64(input.appSecret, stringToSign);
}

export function verifyDingtalkRobotSignature(input: {
  timestamp: string;
  sign: string;
  appSecret: string;
  now?: number;
  maxSkewMs?: number;
}): boolean {
  const stamp = Number(input.timestamp);
  if (!Number.isFinite(stamp)) return false;
  const skew = input.maxSkewMs ?? 60 * 60 * 1000;
  const now = input.now ?? Date.now();
  if (Math.abs(now - stamp) > skew) return false;
  return timingSafeEquals(signDingtalkRobot({ timestamp: input.timestamp, appSecret: input.appSecret }), input.sign);
}

/** 事件订阅推送：dev_msg_signature = sha1(join(sort([token, timestamp, nonce, encrypt]))) */
export function signDingtalkEvent(input: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}): string {
  return sha1Hex(sortedStrings([input.token, input.timestamp, input.nonce, input.encrypt]).join(""));
}

/**
 * 事件订阅加解密，按官方布局：
 * AESKey = Base64_Decode(EncodingAESKey + "=")，iv 取 AESKey 前 16 字节。
 * 明文 = random(16B) + msg_len(4B, 网络字节序) + msg + $key（appKey 或 corpId）。
 * 见 https://open.dingtalk.com/document/app/callback-event-message-body-encryption-and-decryption.md
 */
export function decryptDingtalkEvent(encrypt: string, encodingAesKey: string, ownerKey?: string): string {
  const aesKey = dingtalkAesKey(encodingAesKey);
  const raw = Buffer.from(encrypt, "base64");
  if (!raw.length) throw new Error("加密内容长度不对。");
  const decipher = createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(raw), decipher.final()]);
  if (plain.length < 20) throw new Error("加密内容长度不对。");
  const messageLength = plain.readUInt32BE(16);
  const start = 20;
  const end = start + messageLength;
  if (end > plain.length) throw new Error("加密内容长度不对。");
  const message = plain.subarray(start, end).toString("utf8");
  const receiveId = plain.subarray(end).toString("utf8");
  if (ownerKey && receiveId && receiveId !== ownerKey) {
    throw new Error("应用标识不匹配。");
  }
  return message;
}

export function encryptDingtalkEvent(plaintext: string, encodingAesKey: string, ownerKey = ""): string {
  const aesKey = dingtalkAesKey(encodingAesKey);
  const random = randomBytes(16);
  const message = Buffer.from(plaintext, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const suffix = Buffer.from(ownerKey, "utf8");
  const plain = Buffer.concat([random, length, message, suffix]);
  const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

/** 官方事件订阅的成功回包：加密的 "success"，外加 msg_signature / timeStamp / nonce。 */
export function dingtalkCallbackReply(input: {
  plaintext?: string;
  token: string;
  encodingAesKey: string;
  ownerKey: string;
  nonce?: string;
  timestamp?: string;
}): { msg_signature: string; timeStamp: string; nonce: string; encrypt: string } {
  const timeStamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomBytes(8).toString("hex");
  const encrypt = encryptDingtalkEvent(input.plaintext ?? "success", input.encodingAesKey, input.ownerKey);
  return {
    msg_signature: signDingtalkEvent({
      token: input.token,
      timestamp: timeStamp,
      nonce,
      encrypt,
    }),
    timeStamp,
    nonce,
    encrypt,
  };
}

function dingtalkAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey 不合法。");
  return key;
}

/* ----------------------------------- 微信 ----------------------------------- */

/** 公众号 / 服务号回调：sha1(join(sort([token, timestamp, nonce]))) */
export function signWechatCallback(input: { token: string; timestamp: string; nonce: string }): string {
  return sha1Hex(sortedStrings([input.token, input.timestamp, input.nonce]).join(""));
}

/* --------------------------------- 自定义机器人 webhook --------------------------------- */

/** 飞书自定义机器人：HMAC-SHA256(key = timestamp + "\n" + secret, data = "") */
export function feishuWebhookSignature(timestamp: string, secret: string): string {
  return hmacSha256Base64(`${timestamp}\n${secret}`, "");
}

/** 钉钉自定义机器人：HMAC-SHA256(key = secret, data = timestamp + "\n" + secret) */
export function dingtalkWebhookSignature(timestamp: string, secret: string): string {
  return hmacSha256Base64(secret, `${timestamp}\n${secret}`);
}
