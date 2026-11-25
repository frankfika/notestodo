import { Card, PageHeader, Pill } from "@huoye/ui";
import { Link } from "react-router";

export function NotReadyPage({ kind }: { kind: "health" | "recordings" }) {
  const title = kind === "health" ? "健康" : "录音";
  return (
    <div className="pt-4">
      <PageHeader title={title} description="还没接通，先留个位置。" />
      <Card className="p-6">
        <Pill className="hy-pill-strong">未就绪</Pill>
        <p className="hy-muted mt-3">
          {kind === "health"
            ? "健康记录还没有接通。这一页先留在这里。"
            : "录音和纪要还没有接通。这一页先留在这里。"}
        </p>
        <Link to="/memories">回到记忆</Link>
      </Card>
    </div>
  );
}
