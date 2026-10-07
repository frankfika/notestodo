/**
 * 麦克风电平条：5 根细竖条，根据 audioLevel (0..1) 用 scaleY 实时缩放，
 * 中段在 0.6 以上变红，传达"音量在安全区 / 过载"信号。
 * 视觉简洁 — 没有数字、没有滑块；用于 RecordingBar 与 TodayPage 的录音卡。
 */
export interface LevelMeterProps {
  /** 0..1 RMS — typically already clamped + boosted (x2.5) in the engine */
  level: number
  /** 是否对中段峰值变红（默认 true） */
  peak?: boolean
  /** 高度像素 */
  size?: number
}

const HEIGHTS = [4, 7, 10, 13, 16] // px per bar

export default function LevelMeter({ level, peak = true, size = 16 }: LevelMeterProps): JSX.Element {
  const clamped = Math.max(0, Math.min(1, level))
  return (
    <span
      className="flex items-end gap-0.5 h-5"
      style={{ height: `${size}px` }}
      aria-hidden
      title={`电平 ${Math.round(clamped * 100)}%`}
    >
      {HEIGHTS.map((h, i) => {
        const weight = 0.4 + i * 0.15
        const scaledY = Math.max(0.15, clamped * weight)
        const isPeak = peak && scaledY > 0.6
        return (
          <span
            key={i}
            className="block w-[3px] rounded-sm transition-all duration-100 ease-out"
            style={{
              height: `${h}px`,
              transform: `scaleY(${scaledY})`,
              backgroundColor: isPeak ? 'var(--danger)' : 'var(--line-strong)',
            }}
          />
        )
      })}
    </span>
  )
}