import path from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function fixturePaths() {
  const root = repoRoot();
  return {
    memorySeed: path.join(root, "fixtures/memory-seed"),
    agentSeed: path.join(root, "fixtures/agent-seed/AGENT.md"),
  };
}
