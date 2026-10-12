import { useRecorder } from '../state/recorder'
import { useUI } from '../state/ui'
import { fmtClock } from '../lib/id'
import LevelMeter from './LevelMeter'

/**
 * 顶部录音状态条，仅在录制/异常时出现；停止时完全退出 DOM（不占空间、不打扰）。
 * 永远只有一个主操作（停止），其他让路。
 *
 * 视觉反馈：红点呼吸 + 实时时钟 + 5 段实时麦克风电平条，
 * 让用户立即看到"麦在响"，解决"我按了录音但真的录上了吗"的疑虑。
 */
export default function RecordingBar() {
  const phase = useRecorder((s) => s.phase)
  const elapsedMs = useRecorder((s) => s.elapsedMs)
  const meeting = useRecorder((s) => s.meeting)
  const chunkCount = useRecorder((s) => s.chunkCount)
  const audioLevel = useRecorder((s) => s.audioLevel)
  const interrupted = useRecorder((s) => s.interrupted)
  const error = useRecorder((s) => s.error)
  const stop = useRecorder((s) => s.stop)
  const goMeeting = useUI((s) => s.goMeeting)

  if (phase === 'idle') return null

  const isError = phase === 'error'
  const accentClass = isError
    ? 'bg-danger/15 border-danger/40'
    : interrupted
      ? 'bg-warning/10 border-warning/30' // 麦克风被中断/恢复中 — 警示而非危险
      : 'bg-danger/5 border-danger/20'

  return (
    <div className={`flex items-center gap-3 px-5 h-12 border-b ${accentClass} text-sm`}>
      {isError ? (
        <>
          <span className="text-danger">⨯</span>
          <span className="text-text-1">录音出错：{error ?? '未知错误'}</span>
          <button
            onClick={() => location.reload()}
            className="ml-auto btn-ghost text-xs h-7"
          >重置</button>
        </>
      ) : (
        <>
          <span className={`rec-dot h-2 w-2 rounded-full ${interrupted ? 'bg-warning' : 'bg-danger'}`} />
          <span className="font-medium text-text-1">
            {interrupted ? '麦克风被中断，正在恢复…' : '正在录音'}
          </span>
          <span className="font-mono tabular-nums text-text-1">{fmtClock(elapsedMs)}</span>
          <LevelMeter level={audioLevel} />
          {meeting && (
              <button
                onClick={() => goMeeting(meeting.id)}
                className="text-text-2 hover:text-text-1 max-w-[40ch] truncate"
                title={meeting.title}
              >
                · {meeting.title}
              </button>
            )}
          {meeting && (
            <button onClick={() => goMeeting(meeting.id)} className="btn-outline text-xs h-7 px-2.5">速记</button>
          )}
          <span className="text-text-3 text-xs">
            已保存 {chunkCount} 片{interrupted && ' · 有空白段'}
          </span>
          <button
            onClick={() => void stop()}
            className="ml-auto btn-danger text-xs h-7 px-3"
          >
            ■ 停止
          </button>
        </>
      )}
    </div>
  )
}