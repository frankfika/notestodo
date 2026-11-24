export function onboardingFinishPatch(input: {
  alreadyCompleted: boolean;
  existingDisplayName?: string;
  existingAssistantName?: string;
  displayName: string;
  assistantName: string;
}): { displayName: string; assistantName: string; onboardingCompleted: true } | null {
  if (input.alreadyCompleted) return null;
  const existingName = (input.existingDisplayName ?? "").trim();
  const existingAssistant = (input.existingAssistantName ?? "").trim();
  return {
    displayName: input.displayName.trim() || existingName || "你",
    assistantName: input.assistantName.trim() || existingAssistant || "叶",
    onboardingCompleted: true,
  };
}
