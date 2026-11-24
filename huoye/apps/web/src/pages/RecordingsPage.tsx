import { Button, Card, PageHeader, Pill } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router";
import { RecordingAudioPlayer } from "../components/RecordingAudioPlayer";
import { api } from "../lib/api";
import { visibleMemoryMarkdown } from "../lib/labels";

export function RecordingsPage() {
  const { id } = useParams();
  if (id) return <RecordingDetailPage id={id} />;
  return <RecordingListPage />;
}

function RecordingListPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["recordings"], queryFn: api.recordings });
  const fileRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState("");
  const [recorderHint, setRecorderHint] = useState("");
  const [recording, setRecording] = useState(false);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [pasted, setPasted] = useState("");
  const [pasteHint, setPasteHint] = useState("");
  const [pasteResult, setPasteResult] = useState<{ title: string; href: string } | null>(null);

  const paste = useMutation({
    mutationFn: () => api.summarizeMeeting({ transcript: pasted }),
    onSuccess: async (result) => {
      setPasteHint(result.message);
      setPasteResult({ title: result.title, href: result.href });
      await client.invalidateQueries({ queryKey: ["notes"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
      await client.invalidateQueries({ queryKey: ["today-cards"] });
    },
    onError: (error) => {
      setPasteHint(error instanceof Error ? error.message : "没有整理成。");
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadRecording(file),
    onSuccess: async (result) => {
      setHint(result.transcribe.ok ? "已经写成纪要。" : result.item.error || "音频已经保存。");
      await client.invalidateQueries({ queryKey: ["recordings"] });
      await client.invalidateQueries({ queryKey: ["today-cards"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
      navigate(`/memories/recordings/${result.item.id}`);
    },
    onError: (error) => {
      setHint(error instanceof Error ? error.message : "没有保存成。");
    },
  });

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    upload.mutate(file);
  }

  async function toggleBrowserRecording() {
    setRecorderHint("");
    if (recording && mediaRef.current) {
      mediaRef.current.stop();
      return;
    }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecorderHint("这个浏览器还不能在页面里录音，请改用上传音频。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/ogg")
          ? "audio/ogg"
          : "";
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        mediaRef.current = null;
        const type = recorder.mimeType || "audio/webm";
        const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunksRef.current, { type });
        if (!blob.size) {
          setRecorderHint("这一段是空的，没有保存。");
          return;
        }
        const file = new File([blob], `browser-${Date.now()}.${ext}`, { type });
        upload.mutate(file);
      };
      mediaRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecorderHint("浏览器没有允许使用麦克风，也可以改用上传音频。");
    }
  }

  const items = list.data?.items ?? [];
  const configured = list.data?.transcribeConfigured === true;

  return (
    <div className="pt-4 pb-24">
      <PageHeader
        title="录音"
        description="把音频放到工作区，能转写时会写成纪要；还没有语音密钥时，也会把文件留下来，方便你自己补记。"
        action={
          <Link to="/memories" className="hy-btn hy-btn-ghost">
            返回记忆
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <Card className="p-5">
          <h2 className="hy-title text-xl m-0">加入一段音频</h2>
          <p className="hy-muted text-sm mt-1">支持常见的 wav、mp3、m4a、ogg，上限 50 MB。</p>
          <div className="flex flex-wrap gap-3 mt-4">
            <Button onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? "正在保存…" : "上传音频"}
            </Button>
            <Button tone="ghost" onClick={() => void toggleBrowserRecording()} disabled={upload.isPending}>
              {recording ? "停止并保存" : "在页面里录一段"}
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm,.aac"
            className="hidden"
            onChange={onPick}
          />
          {hint ? <p className="text-sm mt-3">{hint}</p> : null}
          {recorderHint ? <p className="text-sm mt-3">{recorderHint}</p> : null}
          {!configured ? (
            <p className="hy-faint text-xs mt-3">
              还没有配置可用的语音转写。配好 MiniMax 等语音接口后，新上传的音频会尝试写成纪要。
            </p>
          ) : null}
        </Card>
        <Card className="p-5">
          <h2 className="hy-title text-xl m-0">粘贴一段转录</h2>
          <p className="hy-muted text-sm mt-1">
            腾讯会议、飞书妙记这类导出的文字直接贴进来，整理成纪要存到 meetings/。
          </p>
          <textarea
            className="hy-textarea min-h-[10rem] mt-3 font-[var(--hy-font-mono)] text-sm"
            value={pasted}
            placeholder="张三：这次先做记忆页的检索。&#10;李四：好，我这边整理待办。"
            onChange={(e) => setPasted(e.target.value)}
          />
          {pasteHint ? <p className="text-sm mt-2">{pasteHint}</p> : null}
          {pasteResult ? (
            <p className="text-sm mt-2">
              <Link to={pasteResult.href} className="hy-link">
                打开纪要：{pasteResult.title}
              </Link>
            </p>
          ) : null}
          <div className="mt-3">
            <Button onClick={() => paste.mutate()} disabled={paste.isPending || !pasted.trim()}>
              {paste.isPending ? "正在整理…" : "导入并整理成纪要"}
            </Button>
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="hy-title text-xl m-0">会议软件</h2>
          <div className="flex items-center justify-between gap-3 mt-3">
            <span>会议或通话应用</span>
            <Pill>未连接</Pill>
          </div>
          <p className="hy-faint text-xs mt-2">{list.data?.meetings.label ?? "会议软件还没有连接。"}</p>
        </Card>
      </div>

      <div className="mt-6">
        <h3 className="hy-title text-xl">以往的录音</h3>
        {items.length === 0 ? (
          <p className="hy-muted mt-3">还没有录音纪要。上传一段音频，或在页面里录一段。</p>
        ) : (
          <div className="space-y-2 mt-3">
            {items.map((item) => (
              <Link key={item.id} to={`/memories/recordings/${item.id}`} className="block no-underline">
                <Card className="p-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{item.title}</div>
                    <div className="hy-muted text-sm">{item.summary || item.originalName}</div>
                  </div>
                  <Pill>{item.status === "transcribed" ? "已转写" : "未转写"}</Pill>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecordingDetailPage({ id }: { id: string }) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ["recording", id], queryFn: () => api.recording(id) });
  const [content, setContent] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [meetingResult, setMeetingResult] = useState<{ title: string; href: string; message: string } | null>(null);
  const item = detail.data?.item;
  const shown = content ?? item?.content ?? "";

  const save = useMutation({
    mutationFn: () => api.saveRecordingNote(id, shown, item?.revision ?? ""),
    onSuccess: async (result) => {
      setContent(result.item.content);
      setHint("纪要已保存。");
      await client.invalidateQueries({ queryKey: ["recording", id] });
      await client.invalidateQueries({ queryKey: ["recordings"] });
      await client.invalidateQueries({ queryKey: ["today-cards"] });
    },
    onError: (error) => {
      setHint(error instanceof Error ? error.message : "没有保存成。");
    },
  });

  const meeting = useMutation({
    mutationFn: () => api.summarizeMeeting({ recordingId: id }),
    onSuccess: async (result) => {
      setMeetingResult({ title: result.title, href: result.href, message: result.message });
      await client.invalidateQueries({ queryKey: ["notes"] });
      await client.invalidateQueries({ queryKey: ["recordings"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
      await client.invalidateQueries({ queryKey: ["today-cards"] });
    },
    onError: (error) => {
      setMeetingResult({ title: "", href: "", message: error instanceof Error ? error.message : "没有整理成。" });
    },
  });

  return (
    <div className="pt-4 pb-24">
      <PageHeader
        title={item?.title || "录音纪要"}
        description={item?.originalName ? `来自 ${item.originalName}` : "这段音频保存在本机工作区。"}
        action={
          <Link to="/memories/recordings" className="hy-btn hy-btn-ghost">
            返回录音
          </Link>
        }
      />
      {detail.isError ? <p className="hy-muted">找不到这段录音。</p> : null}
      {item ? (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Pill>{item.status === "transcribed" ? "已转写" : "未转写"}</Pill>
            {item.error ? <span className="hy-muted text-sm">{item.error}</span> : null}
          </div>
          <Card className="p-5 mb-4">
            <RecordingAudioPlayer
              id={item.id}
              durationMs={item.durationMs}
              playable={item.playable}
              audioError={item.audioError}
              bytes={item.bytes}
            />
          </Card>
          <Card className="p-5">
            <h2 className="hy-title text-xl m-0">纪要</h2>
            <p className="hy-muted text-sm mt-1">可以直接改。没有转写成功时，也可以自己把内容补上。</p>
            <textarea
              className="hy-textarea min-h-[16rem] mt-3 font-[var(--hy-font-mono)] text-sm"
              value={shown}
              onChange={(e) => setContent(e.target.value)}
            />
            {hint ? <p className="text-sm mt-3">{hint}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "正在保存…" : "保存纪要"}
              </Button>
              <Button tone="ghost" onClick={() => meeting.mutate()} disabled={meeting.isPending}>
                {meeting.isPending ? "正在整理…" : "整理成纪要"}
              </Button>
            </div>
            {meetingResult ? (
              <p className="text-sm mt-3">
                {meetingResult.message}
                {meetingResult.href ? (
                  <>
                    {" "}
                    <Link to={meetingResult.href} className="hy-link">
                      打开纪要：{meetingResult.title}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </Card>
          {item.status === "transcribed" ? (
            <div className="markdown-body mt-5 leading-7">
              <Markdown>{visibleMemoryMarkdown(shown)}</Markdown>
            </div>
          ) : null}
        </>
      ) : detail.isLoading ? (
        <p className="hy-muted">正在打开…</p>
      ) : null}
    </div>
  );
}
