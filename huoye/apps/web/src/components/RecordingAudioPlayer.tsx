import { useEffect, useRef, useState } from "react";
import { formatAudioTime } from "../lib/audio";

export function RecordingAudioPlayer(props: {
  id: string;
  durationMs?: number | null;
  playable?: boolean;
  audioError?: string;
  bytes?: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [browserDuration, setBrowserDuration] = useState<number | null>(null);
  const known = props.durationMs != null && props.durationMs > 0 ? props.durationMs / 1000 : null;
  const duration = known ?? (browserDuration && browserDuration > 0 ? browserDuration : null);
  const broken = props.playable === false || Boolean(props.audioError) || props.bytes === 0;

  useEffect(() => {
    const node = audioRef.current;
    if (!node) return;
    const onTime = () => setCurrent(node.currentTime || 0);
    const onMeta = () => {
      if (Number.isFinite(node.duration) && node.duration > 0) setBrowserDuration(node.duration);
    };
    const onEnd = () => setPlaying(false);
    node.addEventListener("timeupdate", onTime);
    node.addEventListener("loadedmetadata", onMeta);
    node.addEventListener("durationchange", onMeta);
    node.addEventListener("ended", onEnd);
    return () => {
      node.removeEventListener("timeupdate", onTime);
      node.removeEventListener("loadedmetadata", onMeta);
      node.removeEventListener("durationchange", onMeta);
      node.removeEventListener("ended", onEnd);
    };
  }, [props.id]);

  if (broken) {
    return <p className="hy-muted text-sm">{props.audioError || "这段音频没法播放。"}</p>;
  }

  async function toggle() {
    const node = audioRef.current;
    if (!node) return;
    if (playing) {
      node.pause();
      setPlaying(false);
      return;
    }
    try {
      await node.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }

  const progress = duration ? Math.min(1, current / duration) : 0;

  return (
    <div>
      <audio ref={audioRef} preload="metadata" src={`/api/recordings/${props.id}/audio`} className="hidden" />
      <div className="flex items-center gap-3">
        <button type="button" className="hy-btn !px-3 !py-2 shrink-0" onClick={() => void toggle()} aria-label={playing ? "暂停" : "播放"}>
          {playing ? "暂停" : "播放"}
        </button>
        <div className="flex-1 min-w-0">
          <div className="h-1.5 rounded-full bg-black/10 overflow-hidden">
            <div className="h-full rounded-full bg-[var(--hy-accent)]" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="hy-muted text-xs mt-2 tabular-nums">
            {formatAudioTime(current)} / {duration != null ? formatAudioTime(duration) : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
