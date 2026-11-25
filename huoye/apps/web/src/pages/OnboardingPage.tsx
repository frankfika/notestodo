import { Button, Card, Mark, PageHeader } from "@huoye/ui";
import { ASSISTANT_NAME_CANDIDATES, pickRandomAssistantName } from "@huoye/config/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/api";
import { onboardingFinishPatch } from "../lib/onboarding";

const STEPS = ["welcome", "name", "assistant", "preview", "folders"] as const;

export function OnboardingPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [step, setStep] = useState<(typeof STEPS)[number]>("welcome");
  const [displayName, setDisplayName] = useState(settings.data?.displayName === "你" ? "" : (settings.data?.displayName ?? ""));
  const [assistantName, setAssistantName] = useState(settings.data?.assistantName ?? "叶");

  useEffect(() => {
    if (!settings.data) return;
    setDisplayName((current) => {
      if (current.trim()) return current;
      const existing = settings.data?.displayName ?? "";
      return existing === "你" ? "" : existing;
    });
    setAssistantName((current) => current.trim() || settings.data?.assistantName || "叶");
  }, [settings.data]);

  const finish = useMutation({
    mutationFn: async () => {
      const patch = onboardingFinishPatch({
        alreadyCompleted: settings.data?.onboardingCompleted === true,
        existingDisplayName: settings.data?.displayName,
        existingAssistantName: settings.data?.assistantName,
        displayName,
        assistantName,
      });
      if (patch) await api.saveSettings(patch);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["settings"] }),
        client.prefetchQuery({ queryKey: ["brief"], queryFn: api.latestBrief }),
        client.prefetchQuery({ queryKey: ["today-cards"], queryFn: api.todayCards }),
        client.prefetchQuery({ queryKey: ["tasks"], queryFn: api.tasks }),
      ]);
      navigate("/today", { replace: true });
    },
  });

  async function skip() {
    if (settings.data?.onboardingCompleted) {
      navigate("/today", { replace: true });
      return;
    }
    await finish.mutateAsync();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="max-w-xl w-full" strong style={{ padding: "40px 44px" }}>
        <div className="flex items-center gap-2.5 mb-6">
          <Mark />
          <span className="hy-title" style={{ fontSize: "var(--hy-fs-lg)" }}>
            活页
          </span>
        </div>
        {step === "welcome" ? (
          <>
            <PageHeader title="先把这一页留给你自己" description="活页把关于你的记录，保存在这台电脑的文件里。可以先不配模型密钥，用本机档案和演示回复开始；需要时再到设置里填写你自己的密钥。" />
            <p className="hy-muted text-sm">可以随时跳过引导，直接进入应用。跳过不会清掉以后写下的内容。</p>
            <div className="flex gap-2">
              <Button onClick={() => setStep("name")}>继续</Button>
              <Button tone="quiet" onClick={() => void skip()}>
                跳过
              </Button>
            </div>
          </>
        ) : null}
        {step === "name" ? (
          <>
            <PageHeader title="怎么称呼你？" description="可以跳过，默认会用「你」。" />
            <input className="hy-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="比如：陈方" />
            <div className="flex gap-2 mt-5">
              <Button onClick={() => setStep("assistant")}>继续</Button>
              <Button tone="quiet" onClick={() => setStep("assistant")}>
                跳过
              </Button>
            </div>
          </>
        ) : null}
        {step === "assistant" ? (
          <>
            <PageHeader title="给你的助手起个名字" description="默认是「叶」。也可以让我从一组原创名字里挑一个。" />
            <input className="hy-input" value={assistantName} onChange={(e) => setAssistantName(e.target.value)} />
            <button
              className="hy-btn hy-btn-ghost mt-3"
              type="button"
              onClick={() => setAssistantName(pickRandomAssistantName())}
            >
              给我一个名字
            </button>
            <p className="hy-faint text-xs mt-2">候选：{ASSISTANT_NAME_CANDIDATES.join("、")}</p>
            <div className="flex gap-2 mt-5">
              <Button onClick={() => setStep("preview")}>继续</Button>
              <Button tone="quiet" onClick={() => setStep("preview")}>
                跳过
              </Button>
            </div>
          </>
        ) : null}
        {step === "preview" ? (
          <>
            <PageHeader title="先看一眼记忆页" description="填写后，会写进你的基本档案。不填也可以，以后再补。" />
            <Card className="p-4">
              <div className="hy-title text-lg">基本档案</div>
              <p>称呼：{displayName.trim() || "（还空着，进入后随时可写）"}</p>
              <p>时区：Asia/Shanghai</p>
              <p>助手名：{assistantName.trim() || "叶"}</p>
            </Card>
            <div className="flex gap-2 mt-5">
              <Button onClick={() => setStep("folders")}>继续</Button>
              <Button tone="quiet" onClick={() => setStep("folders")}>
                跳过
              </Button>
            </div>
          </>
        ) : null}
        {step === "folders" ? (
          <>
            <PageHeader title="连接应用" description="现在不必连接任何应用。需要时再在设置里添加文件夹，或接通飞书、钉钉、微信。" />
            <p className="hy-muted">飞书、钉钉、微信在设置的通道里，配好开放平台凭证之后就能收发；不接也不影响聊天和记忆。</p>
            <div className="flex gap-2 mt-5">
              <Button onClick={() => void finish.mutateAsync()} disabled={finish.isPending}>
                进入活页
              </Button>
              <Button tone="quiet" onClick={() => void skip()} disabled={finish.isPending}>
                跳过
              </Button>
            </div>
          </>
        ) : null}
      </Card>
    </div>
  );
}
