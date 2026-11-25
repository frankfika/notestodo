import { readFileSync } from "node:fs";
import type { ChatTurn } from "@huoye/core";
import type { Workspace } from "./workspace";

export const AGENT_PROMPT_LIMIT = 4000;
export const ABOUT_PROMPT_LIMIT = 3000;

/** 系统上下文：AGENT.md + 「关于你」里已填写的档案。聊天和任务共用同一套。 */
export function buildMemoryContext(workspace: Workspace): string {
  const settings = workspace.readSettings();
  const parts: string[] = [];
  try {
    parts.push(readFileSync(workspace.paths.agent, "utf8").slice(0, AGENT_PROMPT_LIMIT));
  } catch {
    parts.push(`你是${settings.assistantName}，活页里的个人助手。`);
  }
  const about = workspace.memory.composeAboutYou().markdown.slice(0, ABOUT_PROMPT_LIMIT);
  if (about.trim()) {
    parts.push("下面是用户已经写在「关于你」里的档案，请当作已知背景，不要改写事实。", about);
  }
  return parts.join("\n\n");
}

export function buildChatPrompt(
  workspace: Workspace,
  history: Array<{ role: string; content: string }>,
): ChatTurn[] {
  const messages: ChatTurn[] = [{ role: "system", content: buildMemoryContext(workspace) }];
  for (const item of history.slice(-20)) {
    if (item.role === "user" || item.role === "assistant" || item.role === "system") {
      messages.push({ role: item.role, content: item.content });
    }
  }
  return messages;
}

export function buildTaskPrompt(
  workspace: Workspace,
  task: { title: string; instruction: string },
): ChatTurn[] {
  const system = [
    buildMemoryContext(workspace),
    "用一两句中文说明你会怎样处理这个任务。不要假装已经对外发送或改了外部系统。",
  ].join("\n\n");
  const body = task.instruction?.trim()
    ? `任务：${task.title}\n${task.instruction.trim()}`
    : `任务：${task.title}`;
  return [
    { role: "system", content: system },
    { role: "user", content: body },
  ];
}
