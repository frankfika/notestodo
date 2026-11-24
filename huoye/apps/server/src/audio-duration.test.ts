import { describe, expect, it } from "vitest";
import { inspectAudio, wavDurationMs } from "./audio-duration";

function silentWav(frames = 1600, sampleRate = 8000): Buffer {
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe("audio duration", () => {
  it("reads duration from a valid wav header", () => {
    const wav = silentWav(2400, 8000);
    expect(wavDurationMs(wav)).toBe(300);
    const inspected = inspectAudio(wav, "wav");
    expect(inspected.playable).toBe(true);
    expect(inspected.durationMs).toBe(300);
    expect(inspected.bytes).toBe(wav.byteLength);
    expect(inspected.error).toBeUndefined();
  });

  it("says honestly when the file is empty or not a readable wav", () => {
    expect(inspectAudio(Buffer.alloc(0), "wav")).toMatchObject({
      playable: false,
      durationMs: 0,
      error: "这段音频是空的，没法播放。",
    });
    const emptyData = silentWav(0, 8000);
    expect(inspectAudio(emptyData, "wav").playable).toBe(false);
    expect(inspectAudio(Buffer.from("not a wav"), "wav")).toMatchObject({
      playable: false,
      error: "这段音频没法播放，文件可能已损坏。",
    });
  });
});
