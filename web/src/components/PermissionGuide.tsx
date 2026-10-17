import { useEffect, useState } from 'react'
import { db } from '../db/db'
import { useUI } from '../state/ui'
import { useRecorder } from '../state/recorder'
import { isTauri } from '../lib/tauri'
import {
  openScreenRecordingSettings,
  requestScreenPermission,
  restartApp,
  systemAudioStatus,
} from '../lib/tauriSystemAudio'

const DISMISS_KEY = 'perm_guide_dismissed_v1'
/** 「稍后」snooze：写入到该时间（ms）之前都不自动弹，但手动打开（setPermGuideOpen(true)）照常 */
const SNOOZE_KEY = 'perm_guide_snooze_until'
const SNOOZE_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * 屏幕录制授权向导（仅 Tauri macOS）。
 *
 * 目标：用户不用自己找设置页。
 *   ① 一键授权  → 触发系统弹窗（同时把「拾贝」自动加进屏幕录制列表）
 *   ② 打开设置  → 直达「屏幕录制」页，只需拨开关
 *   ③ 重启生效  → macOS 不会即时刷新已运行进程，一键重启
 * 授权状态每 1.5s 轮询，授权成功自动切到完成态。
 *
 * 启动策略（v2）：不再在 app 启动时自动弹；只在录音真的开始（phase → recording）
 * 且未授权 + 未选「不再提醒」 + 未在 24h snooze 内时才弹。手动入口（Settings /
 * RecordingBanner 的「一键开启」）始终有效。
 */
export default function PermissionGuide(): JSX.Element | null {
  const open = useUI((s) => s.permGuideOpen)
  const setOpen = useUI((s) => s.setPermGuideOpen)
  const phase = useRecorder((s) => s.phase)
  const [granted, setGranted] = useState(false)
  const [touched, setTouched] = useState(false) // 已弹过授权框或开过设置页
  const [err, setErr] = useState<string | null>(null)

  // 录音真正开始时才考虑弹向导；isTauri + 未授权 + 未永久 dismiss + 未 snooze
  useEffect(() => {
    if (!isTauri() || phase !== 'recording' || open) return
    let alive = true
    void (async () => {
      // 手动打开（setPermGuideOpen(true)）走另一路径，不受这些持久化 flag 阻挡
      const [dismissed, snoozed] = await Promise.all([
        db.kv.get(DISMISS_KEY).catch(() => undefined),
        db.kv.get(SNOOZE_KEY).catch(() => undefined),
      ])
      if (!alive) return
      if (dismissed?.value === true) return
      const until = typeof snoozed?.value === 'number' ? snoozed.value : 0
      if (until > Date.now()) return // 24h 内已点过「稍后」
      const st = await systemAudioStatus()
      if (alive && st.supported && !st.permission_granted) setOpen(true)
    })()
    return () => {
      alive = false
    }
  }, [phase, open, setOpen])

  // 打开期间轮询授权状态
  useEffect(() => {
    if (!open) return
    let alive = true
    const tick = (): void => {
      void systemAudioStatus().then((st) => {
        if (alive) setGranted(st.supported && st.permission_granted)
      })
    }
    tick()
    const id = window.setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [open])

  if (!open || !isTauri()) return null

  async function authorize(): Promise<void> {
    setErr(null)
    setTouched(true)
    const ok = await requestScreenPermission()
    if (ok) setGranted(true)
  }
  async function openSettings(): Promise<void> {
    setErr(null)
    setTouched(true)
    try {
      await openScreenRecordingSettings()
    } catch (e) {
      setErr(`无法自动打开设置：${e instanceof Error ? e.message : String(e)}。请手动前往「系统设置 → 隐私与安全性 → 屏幕录制」。`)
    }
  }
  async function neverRemind(): Promise<void> {
    await db.kv.put({ key: DISMISS_KEY, value: true })
    setOpen(false)
  }
  /** 「稍后」：snooze 24h 后才会再自动弹；该段时间内手动入口仍可开 */
  async function snooze(): Promise<void> {
    await db.kv.put({ key: SNOOZE_KEY, value: Date.now() + SNOOZE_MS })
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="开启系统声音录制"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-bg-raise shadow-xl p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-text-1">
            {granted ? '✓ 系统声音已就绪' : '开启系统声音录制'}
          </h2>
          <p className="text-xs text-text-3 mt-1 leading-relaxed">
            {granted
              ? '之后录音会同时录下麦克风和 Zoom / Meet 等会议里对方的声音。'
              : '想录到会议里对方的声音，需要 macOS「屏幕录制」权限。只录音频，不录屏幕画面。三步搞定：'}
          </p>
        </div>

        {!granted && (
          <ol className="space-y-2 text-sm text-text-1">
            <Step n={1} done={touched} text="点「一键授权」，在系统弹窗里选「允许」/「打开系统设置」" />
            <Step n={2} done={false} text="在设置页的列表里把「拾贝」的开关拨到开（点下方按钮可直达）" />
            <Step n={3} done={false} text="回来点「重启拾贝」让授权生效" />
          </ol>
        )}

        {err && <div className="text-xs text-danger">{err}</div>}

        <div className="flex flex-wrap items-center gap-2">
          {granted ? (
            <button className="btn-primary h-8 px-3 text-sm ml-auto" onClick={() => setOpen(false)}>完成</button>
          ) : (
            <>
              <button className="btn-primary h-8 px-3 text-sm" onClick={() => void authorize()}>一键授权</button>
              <button className="btn-outline h-8 px-3 text-sm" onClick={() => void openSettings()}>打开系统设置</button>
              <button
                className={touched ? 'btn-primary h-8 px-3 text-sm' : 'btn-outline h-8 px-3 text-sm'}
                onClick={() => void restartApp()}
              >重启拾贝</button>
            </>
          )}
        </div>

        {!granted && (
          <div className="flex items-center gap-3 text-xs text-text-3 pt-1 border-t border-line">
            <span className="pt-2">不授权也能用：只录麦克风。</span>
            <button className="pt-2 ml-auto hover:text-text-1" onClick={() => void snooze()}>稍后</button>
            <button className="pt-2 hover:text-text-1" onClick={() => void neverRemind()}>不再提醒</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Step({ n, done, text }: { n: number; done: boolean; text: string }): JSX.Element {
  return (
    <li className="flex gap-2 items-start">
      <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${done ? 'bg-accent text-white' : 'border border-line text-text-3'}`}>
        {done ? '✓' : n}
      </span>
      <span className="leading-snug">{text}</span>
    </li>
  )
}
