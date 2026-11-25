import { Card, PageHeader, Pill } from "@huoye/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../lib/api";

export function AssistantPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const name = settings.data?.assistantName ?? "叶";
  return (
    <div className="pt-4">
      <PageHeader title={name} description="这是助手的档案。关于你的记录，在记忆页里。" />
      <div className="grid gap-4 md:grid-cols-[200px_1fr]">
        <Card className="p-6 grid place-items-center">
          <div className="w-24 h-24 rounded-full bg-white grid place-items-center hy-title text-4xl text-[var(--hy-accent)]">
            {name.slice(0, 1)}
          </div>
          <div className="mt-3">{name}</div>
          <Pill>本地助手</Pill>
        </Card>
        <Card className="p-6">
          <p>记录都留在这台电脑上。</p>
          <p className="hy-muted">日记入口在记忆页。改你的基本档案前，会先问你。</p>
          <div className="flex gap-3 mt-4">
            <Link to="/memories">打开记忆</Link>
            <Link to="/chat">开始聊天</Link>
            <Link to="/settings/models">模型设置</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
