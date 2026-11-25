import { describe, expect, it } from "vitest";
import { onboardingFinishPatch } from "./onboarding";

describe("onboardingFinishPatch", () => {
  it("does not write settings when onboarding is already completed", () => {
    expect(
      onboardingFinishPatch({
        alreadyCompleted: true,
        existingDisplayName: "方陈",
        displayName: "",
        assistantName: "",
      }),
    ).toBeNull();
  });

  it("keeps an existing displayName when skip leaves the name blank", () => {
    expect(
      onboardingFinishPatch({
        alreadyCompleted: false,
        existingDisplayName: "方陈",
        existingAssistantName: "叶",
        displayName: "",
        assistantName: "",
      }),
    ).toEqual({ displayName: "方陈", assistantName: "叶", onboardingCompleted: true });
  });

  it("may use 你 on a fresh install with no existing name", () => {
    expect(
      onboardingFinishPatch({
        alreadyCompleted: false,
        displayName: "",
        assistantName: "",
      }),
    ).toEqual({ displayName: "你", assistantName: "叶", onboardingCompleted: true });
  });
});
