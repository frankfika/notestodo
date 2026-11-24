/**
 * 从本机音频字节里读出可播放时长。WAV 可以精确解析；
 * 其他格式交给浏览器，这里只判断空文件。
 */

export interface AudioInspection {
  bytes: number;
  durationMs: number | null;
  playable: boolean;
  error?: string;
}

export function inspectAudio(bytes: Uint8Array | Buffer | null | undefined, ext?: string): AudioInspection {
  if (!bytes || bytes.byteLength === 0) {
    return { bytes: 0, durationMs: 0, playable: false, error: "这段音频是空的，没法播放。" };
  }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const kind = (ext ?? "").toLowerCase().replace(/^\./, "");
  if (kind === "wav" || kind === "wave" || isRiffWave(view)) {
    const durationMs = wavDurationMs(view);
    if (durationMs == null) {
      return { bytes: view.byteLength, durationMs: null, playable: false, error: "这段音频没法播放，文件可能已损坏。" };
    }
    if (durationMs <= 0) {
      return { bytes: view.byteLength, durationMs: 0, playable: false, error: "这段音频是空的，没法播放。" };
    }
    return { bytes: view.byteLength, durationMs, playable: true };
  }
  return { bytes: view.byteLength, durationMs: null, playable: true };
}

export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44 || !isRiffWave(bytes)) return null;
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(data);
  let offset = 12;
  let byteRate = 0;
  let dataSize: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && size >= 16 && offset + 16 <= bytes.byteLength) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (id === "data") dataSize = size;
    const advance = 8 + size + (size % 2);
    if (advance <= 0) break;
    offset += advance;
  }
  if (!byteRate || dataSize == null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

function isRiffWave(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const tag = (start: number, expected: string) =>
    expected.split("").every((ch, i) => bytes[start + i] === ch.charCodeAt(0));
  return tag(0, "RIFF") && tag(8, "WAVE");
}
