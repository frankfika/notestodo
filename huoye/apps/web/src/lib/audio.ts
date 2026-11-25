/** 把秒数写成播放器时长。不足一秒时保留一位小数，避免 0.3 秒被显示成 0:00 / 0:00。 */
export function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  if (seconds > 0 && seconds < 10 && Math.abs(rest - Math.round(rest)) >= 0.05) {
    return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
  }
  return `${minutes}:${String(Math.floor(rest + 1e-9)).padStart(2, "0")}`;
}
