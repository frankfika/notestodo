import { describe, expect, it } from "vitest";
import { formatAudioTime } from "./audio";

describe("formatAudioTime", () => {
  it("keeps a tenth of a second so short wavs are not shown as 0:00", () => {
    expect(formatAudioTime(0.3)).toBe("0:00.3");
    expect(formatAudioTime(0.2)).toBe("0:00.2");
    expect(formatAudioTime(1)).toBe("0:01");
    expect(formatAudioTime(65)).toBe("1:05");
    expect(formatAudioTime(0)).toBe("0:00");
  });
});
