import { useRecorder } from '../state/recorder'
import { useUI } from '../state/ui'
import { fmtClock } from '../lib/id'
import { isTauri } from '../lib/tauri'
import LevelMeter from './LevelMeter'

/**
 * 顶部录音状态条，仅在录制/异常时出现；停止时完全退出 DOM（不占空间、不打扰）。
 * 永远只有一个主操作（停止），其他让路。
 *
 * 视觉反馈：红点呼吸 + 实时时钟 + 5 段实时麦克风电平条，
 * 让用户立即看到"麦在响"，解决"我按了录音但真的录上了吗"的疑虑。
 *
 * Phase-2：状态条下方多一行 honest banner — 显式告诉用户「当前是 mic-only，
 * 系统声音需桌面版 / 屏录权限」，绝不静默假装。
 */
export default function RecordingBar() {
  const phase = useRecorder((s) => s.phase)
  const elapsedMs = useRecorder((s) => s.elapsedMs)
  const meeting = useRecorder((s) => s.meeting)
  const chunkCount = useRecorder((s) => s.chunkCount)
  const audioLevel = useRecorder((s) => s.audioLevel)
  const interrupted = useRecorder((s) => s.interrupted)
  const captureMode = useRecorder((s) => s.captureMode)
  const captureModeNote = useRecorder((s) => s.captureModeNote)
  const error = useRecorder((s) => s.error)
  const stop = useRecorder((s) => s.stop)
  const goMeeting = useUI((s) => s.goMeeting)
  const onLivePage = useUI((s) => s.view === 'meeting-detail' && s.meetingId === meeting?.id)

  if (phase === 'idle') return null
  // 在速记页本身已有计时/电平/结束按钮，不再重复一条顶栏（出错 / 麦克风中断时仍显示，否则会中看不到警示）

  const isError = phase === 'error'
  const accentClass = isError
    ? 'bg-danger/15 border-danger/40'
    : interrupted
      ? 'bg-warning/10 border-warning/30' // 麦克风被中断/恢复中 — 警示而非危险
      : 'bg-danger/5 border-danger/20'

  // Phase-2: 何时展示 system-audio banner？
  //   - 浏览器 + 录音中          → 必显示（"需要桌面版"）
  //   - Tauri 但 captureMode==unsupported → 必显示（"需屏录授权 / 未实装"）
  //   - captureMode==mic-only 且在 Tauri → 不显示（探测中或纯 mic 即可）
  //   - captureMode==mic+system → 不显示（已升级）
  // 注：isError 已 early-return 上面了；此处 phase 已收窄为非 error
  const showCaptureBanner =
    captureMode === 'unsupported' || !isTauri()

  return (
    <div className="border-b border-line">
      {(!onLivePage || isError || interrupted) && (
      <div className={`flex items-center gap-3 px-5 h-12 ${accentClass} text-sm`}>
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
              {captureMode === 'mic+system' ? '麦克风 + 系统声音' : '仅麦克风'} · 已保存 {chunkCount} 片{interrupted && ' · 有空白段'}
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
      )}
      {showCaptureBanner && (
        <CaptureBanner mode={captureMode} note={captureModeNote} />
      )}
    </div>
  )
}

/**
 * Honest banner：告诉用户当前录音采集模式 + 为什么不是 mic+system。
 * 永远诚实；永远不假装「系统声音已开」。
 */
function CaptureBanner({
  mode,
  note,
}: {
  mode: 'mic-only' | 'mic+system' | 'unsupported'
  note: string | null
}): JSX.Element | null {
  if (mode === 'mic+system') return null
  const isWeb = !isTauri()
  const text = isWeb
    ? '浏览器中只能录制麦克风；系统声音需 NotesToGO 桌面版，并在「系统设置 → 隐私与安全性 → 屏幕录制」中授权。'
    : note ?? '系统音频采集暂不可用（macOS 桌面版 + 屏幕录制权限）。'
  return (
    <div className="px-5 py-1.5 bg-bg-overlay border-t border-line text-[11.5px] text-text-3 flex items-center gap-2">
      <span className="text-warning" aria-hidden="true">▣</span>
      <span className="truncate" title={text}>{text}</span>
      {!isWeb && (
        <button
          type="button"
          onClick={() => useUI.getState().setPermGuideOpen(true)}
          className="ml-auto shrink-0 btn-outline text-xs h-6 px-2"
        >一键开启</button>
      )}
    </div>
  )
}