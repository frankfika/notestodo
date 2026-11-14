import { type JSX, useEffect, useMemo, useState } from 'react'
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
/** 点过「一键授权」的时间戳：用来区分「还没重启」和「重启了仍未生效」 */
const REQUESTED_KEY = 'perm_guide_requested_at'

/**
 * 三种真实状态的文案与下一步。
 * macOS 的行为是：授权只对新进程生效 → 请求后必须重启；
 * 如果重启后仍未生效，多半是系统设置里的开关没打开。
 */
const STAGE_COPY: Record<'ask' | 'restart' | 'settings', { title: string; body: string }> = {
  ask: {
    title: '开启系统声音录制',
    body:
      '想录到会议里对方的声音（Zoom / Meet），需要 macOS「屏幕录制」权限。只录音频，不录画面。点「一键授权」后系统会弹窗。',
  },
  restart: {
    title: '已请求授权，重启后生效',
    body:
      'macOS 的屏幕录制权限只对新启动的进程生效 —— 点「重启 openNotion」之后权限才会真正可用。不重启也能录，只是录不到对方的声音。',
  },
  settings: {
    title: '仍未获得屏幕录制权限',
    body:
      '请到「系统设置 → 隐私与安全性 → 屏幕录制」，把 openNotion 的开关拨到「开」，然后重启 openNotion。若开关已经是开的，说明本次构建的身份变了（临时签名），把开关关掉再打开一次即可。',
  },
}

/**
 * 屏幕录制授权向导（仅 Tauri macOS）。
 *
 * 目标：用户不用自己找设置页。
 *   ① 一键授权  → 触发系统弹窗（同时把「openNotion」自动加进屏幕录制列表）
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
  const [requestedAt, setRequestedAt] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  /** 本次进程启动时刻：授权后必须重启进程才生效，用来判断「还没重启」 */
  const processStart = useMemo(() => Date.now() - performance.now(), [])

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

  // 读回「上次请求授权」的时间，判断用户重启过没有
  useEffect(() => {
    if (!open) return
    let alive = true
    void db.kv
      .get(REQUESTED_KEY)
      .then((r) => {
        if (alive && typeof r?.value === 'number') setRequestedAt(r.value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open])

  if (!open || !isTauri()) return null

  /**
   * 状态机（macOS 的真实行为）：
   *   ① 没请求过 → 点「一键授权」弹系统框
   *   ② 请求过、但当前进程还没重启 → macOS 授权只对新进程生效，点「重启」
   *   ③ 已经重启过、仍未授权 → 系统设置里的开关没打开
   *      （或本次构建签名变了，系统当成新 App → 需要把开关重新拨一次）
   */
  const restarted = requestedAt !== null && requestedAt <= processStart
  const stage: 'ask' | 'restart' | 'settings' = !requestedAt
    ? 'ask'
    : restarted
      ? 'settings'
      : 'restart'

  async function authorize(): Promise<void> {
    setErr(null)
    const ok = await requestScreenPermission()
    if (ok) {
      setGranted(true)
      return
    }
    // 记下请求时间：之后即使重启仍未生效，也能告诉用户「开关要再拨一次」
    await db.kv.put({ key: REQUESTED_KEY, value: Date.now() })
    setRequestedAt(Date.now())
  }
  async function openSettings(): Promise<void> {
    setErr(null)
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

  function continueWithMicOnly(): void {
    setOpen(false)
  }

  return (
    <div
      className="fixed right-4 bottom-24 md:bottom-5 z-50 w-[420px] max-w-[calc(100vw-1.5rem)]"
      role="dialog"
      aria-modal="false"
      aria-label="开启系统声音录制"
    >
      <div className="rounded-2xl border border-line bg-bg-raise/96 backdrop-blur shadow-xl p-5 space-y-4">
        <div>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-text-1">
            {granted ? '✓ 系统声音已就绪' : STAGE_COPY[stage].title}
              </h2>
              <p className="text-xs text-text-3 mt-1 leading-relaxed">
                {granted
                  ? '之后录音会同时录下麦克风和 Zoom / Meet 等会议里对方的声音。'
                  : STAGE_COPY[stage].body}
              </p>
            </div>
            <button
              className="btn-ghost h-7 px-2 text-xs shrink-0"
              onClick={() => continueWithMicOnly()}
              title="先继续录音"
            >×</button>
          </div>
        </div>

        {err && <div className="text-xs text-danger">{err}</div>}

        {!granted && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-line bg-bg px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.08em] text-text-3">现在继续</div>
              <div className="mt-1 text-sm font-medium text-text-1">只录麦克风</div>
              <div className="mt-1 text-xs leading-relaxed text-text-3">你自己的声音能录下来，会议里对方的声音录不到。</div>
            </div>
            <div className="rounded-xl border border-line bg-bg px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.08em] text-text-3">授权后</div>
              <div className="mt-1 text-sm font-medium text-text-1">双方声音都能录</div>
              <div className="mt-1 text-xs leading-relaxed text-text-3">适合 Zoom、Meet、播客回听这类双向音频场景。</div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {granted ? (
            <button className="btn-primary h-8 px-3 text-sm ml-auto" onClick={() => setOpen(false)}>完成</button>
          ) : (
            <>
              {stage === 'ask' && (
                <button className="btn-primary h-8 px-3 text-sm" onClick={() => void authorize()}>一键授权</button>
              )}
              {stage === 'restart' && (
                <button className="btn-primary h-8 px-3 text-sm" onClick={() => void restartApp()}>重启 openNotion</button>
              )}
              {stage === 'settings' && (
                <button className="btn-primary h-8 px-3 text-sm" onClick={() => void openSettings()}>打开系统设置</button>
              )}
              {stage !== 'settings' && (
                <button className="btn-outline h-8 px-3 text-sm" onClick={() => void openSettings()}>打开系统设置</button>
              )}
              {stage !== 'ask' && (
                <button className="btn-outline h-8 px-3 text-sm" onClick={() => void restartApp()}>重启 openNotion</button>
              )}
              <button className="btn-ghost h-8 px-3 text-sm ml-auto" onClick={() => continueWithMicOnly()}>
                本次只录麦克风继续
              </button>
            </>
          )}
        </div>

        {!granted && (
          <div className="flex items-center gap-3 text-xs text-text-3 pt-2 border-t border-line">
            <span>这个引导不会阻止你继续录音。</span>
            <button className="ml-auto hover:text-text-1" onClick={() => void snooze()}>稍后</button>
            <button className="hover:text-text-1" onClick={() => void neverRemind()}>不再提醒</button>
          </div>
        )}
      </div>
    </div>
  )
}
