import { type JSX, useEffect, useRef, useState } from 'react'
import { useRecorder } from '../state/recorder'
import { useUI } from '../state/ui'
import { fmtClock } from '../lib/id'
import { isTauri } from '../lib/tauri'
import LevelMeter from './LevelMeter'
import { openMicrophoneSettings } from '../lib/tauriSystemAudio'
import { CATALOG, downloadModel, isReady, useBuiltinModels } from '../lib/builtinModels'
import { useSettings } from '../db/settings'
import { resolveASRConfig } from '../types'

/** 连续多少秒几乎没有声音就提醒（3 秒足够长，不会误伤「正在想」）。 */
const SILENT_SEC = 3
/** 开了系统声音采集后，等多久还没收到 chunk 就说明没捕到。 */
const SYS_AUDIO_GRACE_SEC = 20

/**
 * 顶部录音状态条，仅在录制/异常时出现；停止时完全退出 DOM（不占空间、不打扰）。
 * 永远只有一个主操作（停止），其他让路。
 *
 * 视觉反馈：红点呼吸 + 实时时钟 + 5 段实时麦克风电平条，
 * 让用户立即看到"麦在响"，解决"我按了录音但真的录上了吗"的疑虑。
 *
 * honest banner —— 显式告诉用户「当前是 mic-only，
 * 系统声音需桌面版 / 屏录权限」，绝不静默假装。
 *
 * 录音诊断（用户说「外部声音根本录不进去」的直接对策）：
 *   ① 连续 3 秒没声音 → 提醒可能是麦克风静音/未授权，给「检查麦克风」直达
 *   ② 声称在录系统声音却一个 chunk 都没收到 → 提醒（会议里对方的声音会丢）
 *   ③ 内置转录模型没下载 → 当场提示并一键下载，别等录完一小时才说
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
  const systemChunks = useRecorder((s) => s.systemChunks)
  const error = useRecorder((s) => s.error)
  const stop = useRecorder((s) => s.stop)
  const goMeeting = useUI((s) => s.goMeeting)
  const onLivePage = useUI((s) => s.view === 'meeting-detail' && s.meetingId === meeting?.id)

  // 电平用 ref 读，避免每 100ms 重建定时器
  const levelRef = useRef(0)
  levelRef.current = audioLevel
  const sysRef = useRef(0)
  sysRef.current = systemChunks
  const modeRef = useRef(captureMode)
  modeRef.current = captureMode

  const [silent, setSilent] = useState(false)
  const [noSysAudio, setNoSysAudio] = useState(false)

  useEffect(() => {
    if (phase !== 'recording') { setSilent(false); setNoSysAudio(false); return }
    let quiet = 0
    let sysQuiet = 0
    let everHeard = false
    const id = window.setInterval(() => {
      // 只要听到过一次就不算故障：中途安静是正常的（会议里没人说话）
      if (levelRef.current > 0.01) everHeard = true
      quiet = everHeard ? 0 : quiet + 1
      setSilent(quiet >= SILENT_SEC)
      // 声称在录系统声音，却一直收不到 chunk → 提醒（对方的声音会丢）
      sysQuiet = modeRef.current === 'mic+system' && sysRef.current === 0 ? sysQuiet + 1 : 0
      setNoSysAudio(sysQuiet >= SYS_AUDIO_GRACE_SEC)
    }, 1000)
    return () => window.clearInterval(id)
  }, [phase])

  if (phase === 'idle') return null
  // 在速记页本身已有计时/电平/结束按钮，不再重复一条顶栏（出错 / 麦克风中断时仍显示，否则会中看不到警示）

  const isError = phase === 'error'
  const accentClass = isError
    ? 'bg-danger/15 border-danger/40'
    : interrupted
      ? 'bg-warning/10 border-warning/30' // 麦克风被中断/恢复中 — 警示而非危险
      : 'bg-danger/5 border-danger/20'

  // 何时展示 system-audio banner？
  //   - 浏览器 + 录音中          → 必显示（"需要桌面版"）
  //   - Tauri 但 captureMode==unsupported → 必显示（"需屏录授权 / 未实装"）
  //   - captureMode==mic-only 且在 Tauri → 不显示（探测中或纯 mic 即可）
  //   - captureMode==mic+system → 不显示（已升级）
  const showCaptureBanner =
    captureMode === 'unsupported' || !isTauri()

  return (
    <div className="border-b border-line">
      {(!onLivePage || isError || interrupted) && (
      <div
        {...(isTauri() ? { 'data-tauri-drag-region': true } : {})}
        className={`flex items-center gap-3 px-5 h-12 ${accentClass} text-sm`}
      >
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
      {silent && <SilentWarning onOpenMic={() => void openMicrophoneSettings()} />}
      {noSysAudio && <NoSysAudioWarning />}
      <ModelMissingHint />
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
    ? '浏览器中只能录制麦克风；系统声音需 openNotion 桌面版，并在「系统设置 → 隐私与安全性 → 屏幕录制」中授权。'
    : note ?? '系统音频采集暂不可用（macOS 桌面版 + 屏幕录制权限）。'
  return (
    <div
      {...(isTauri() ? { 'data-tauri-drag-region': true } : {})}
      className="px-5 py-1.5 bg-bg-overlay border-t border-line text-[11.5px] text-text-3 flex items-center gap-2"
    >
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

/** 从头到尾一点声音都没听到 —— 麦克风静音/被占用/未授权，用户当场就能修。 */
function SilentWarning({ onOpenMic }: { onOpenMic: () => void }): JSX.Element {
  return (
    <div className="px-5 py-1.5 bg-warning/10 border-t border-line text-[11.5px] text-warning flex items-center gap-2">
      <span aria-hidden="true">⚠</span>
      <span className="truncate">
        一直没检测到任何声音 —— 麦克风可能被静音 / 未授权，或你正在用外放、系统声音需要屏幕录制权限。
      </span>
      <button
        type="button"
        onClick={onOpenMic}
        className="ml-auto shrink-0 btn-outline text-xs h-6 px-2"
      >检查麦克风</button>
    </div>
  )
}

/** 声称在录系统声音，却一个 chunk 都没收到 —— 对方的声音会丢，必须说。 */
function NoSysAudioWarning(): JSX.Element {
  return (
    <div className="px-5 py-1.5 bg-warning/10 border-t border-line text-[11.5px] text-warning flex items-center gap-2">
      <span aria-hidden="true">⚠</span>
      <span className="truncate">
        还没捕到任何系统声音 —— 会议里对方的声音不会进这段录音（确认对方声音是从这个屏幕播放的）。
      </span>
      <button
        type="button"
        onClick={() => useUI.getState().setPermGuideOpen(true)}
        className="ml-auto shrink-0 btn-outline text-xs h-6 px-2"
      >检查授权</button>
    </div>
  )
}

/**
 * 内置模型没下载 —— 录音当下就说，别等录完一小时才在会议页看到「等待模型」。
 * 不阻断录音（先录下来总没错），只把「录完会等它」提前讲清楚，并给一键下载。
 * 大模型动辄几个 GB，所以同时给一个轻量版入口，让用户自己权衡「先快后准」。
 */
function ModelMissingHint(): JSX.Element | null {
  const phase = useRecorder((s) => s.phase)
  const settings = useSettings()
  const models = useBuiltinModels((s) => s.models) // 订阅下载进度

  if (phase !== 'recording' || !settings) return null

  const asrId = settings.asr_mode === 'builtin' ? resolveASRConfig(settings).model : null
  const llmId = settings.ai_mode === 'builtin' ? settings.builtin_llm_model : null
  const asrModel = asrId && !isReady(asrId) ? CATALOG.find((x) => x.id === asrId) : undefined
  const llmModel = llmId && !isReady(llmId) ? CATALOG.find((x) => x.id === llmId) : undefined

  // 没有转录模型 = 整段录音没有文字，先补它；笔记模型次之
  const target = asrModel ?? llmModel
  if (!target) return null

  const st = models[target.id]
  const downloading = st?.state === 'downloading'
  const pct = downloading && st.total > 0 ? Math.round((st.received / st.total) * 100) : 0
  // 轻量替代：大 ASR → small，小 LLM → E2B
  const alt = target.kind === 'asr'
    ? CATALOG.find((x) => x.id === 'whisper-small')
    : CATALOG.find((x) => x.id === 'gemma-4-e2b')

  return (
    <div className="px-5 py-1.5 bg-bg-overlay border-t border-line text-[11.5px] text-text-3 flex items-center gap-2">
      <span aria-hidden="true">◷</span>
      {downloading ? (
        <span className="truncate">正在下载「{target.name}」{pct}% —— 录音照常保存，下好后自动转录。</span>
      ) : (
        <span className="truncate">
          「{target.name}」还没下载 —— 录音照常保存，模型下好后自动转录。
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {!downloading && (
          <>
            <button
              type="button"
              onClick={() => void downloadModel(target.id)}
              className="btn-outline text-xs h-6 px-2"
            >下载（{(target.bytes / 1e9).toFixed(1)}GB）</button>
            {alt && (
              <button
                type="button"
                onClick={() => void downloadModel(alt.id)}
                className="btn-ghost text-xs h-6 px-2"
                title={`${alt.name}：${alt.blurb}`}
              >先下轻量版 {alt.name}（{(alt.bytes / 1e9).toFixed(1)}GB）</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
