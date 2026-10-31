import { statusText } from '../../lib/meetingStatus'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { useRecorder } from '../../state/recorder'
import { fmtClock, fmtDate, fmtDateTime, mod } from '../../lib/id'
import type { Meeting, MeetingStatus } from '../../types'
import EmptyState from '../../components/EmptyState'
import { importTranscriptText } from '../../lib/importTranscript'
import { deleteMeetingCascade, renameMeeting } from '../../lib/meetingActions'

function statusDot(s: MeetingStatus): string {
  switch (s) {
    case 'recording': return 'bg-danger'
    case 'processing':
    case 'transcribed':
    case 'summarizing': return 'bg-warning'
    case 'summarized': return 'bg-accent'
    case 'failed': return 'bg-danger'
  }
}

/**
 * 全部会议列表 + 选中预览。MVP：右栏展示简要 metadata + 跳详情按钮。
 */
export default function MeetingsPage(): JSX.Element {
  const meetings = useLiveQuery(
    () => db.meetings.orderBy('started_at').reverse().toArray(),
    [],
  ) ?? []
  const goMeeting = useUI((s) => s.goMeeting)
  const start = useRecorder((s) => s.start)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  // 自动选中最近一个
  const activeId = selectedId ?? meetings[0]?.id ?? null
  const active = useLiveQuery(
    async () => activeId ? await db.meetings.get(activeId) : undefined,
    [activeId],
  )

  // 按日期分组
  const grouped = useMemo(() => {
    const map = new Map<string, Meeting[]>()
    for (const m of meetings) {
      const day = m.started_at.slice(0, 10)
      const list = map.get(day) ?? []
      list.push(m)
      map.set(day, list)
    }
    return [...map.entries()]
  }, [meetings])

  useEffect(() => {
    if (!menuFor) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('[data-rowmenu]')) setMenuFor(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuFor])

  return (
    <div className="h-full flex">
      {/* 列表 */}
      <div className="w-[300px] shrink-0 border-r border-line overflow-y-auto">
        <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur px-5 py-4 border-b border-line flex items-center">
          <h1 className="text-sm font-semibold text-text-1">会议</h1>
          <span className="ml-2 text-[11px] text-text-3 tabular-nums">{meetings.length}</span>
          <button
            onClick={() => setImportOpen(true)}
            className="ml-auto btn-ghost text-xs h-7 px-2.5"
          >导入转录</button>
          <button
            onClick={() => void start()}
            className="btn-primary text-xs h-7 px-2.5"
          >● 新建录音</button>
        </div>
        {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}

        {meetings.length === 0 ? (
          <EmptyState
            icon="◌"
            title="还没有会议"
            hint={`按 ${mod()}⇧R 或点右上角立刻开始。`}
            action={
              <button onClick={() => void start()} className="btn-primary h-8 text-xs">● 开始录音</button>
            }
          />
        ) : (
          grouped.map(([day, list]) => (
            <div key={day} className="py-1">
              <div className="px-5 py-1.5 text-[11px] font-semibold tracking-widest text-text-3">
                {fmtDate(day, true)}
              </div>
              <ul>
                {list.map((m) => {
                  const active = activeId === m.id
                  return (
                    <li key={m.id} className="group relative">
                      {renamingId === m.id ? (
                        <div className="flex items-center gap-2.5 px-5 py-2">
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot(m.status)}`} />
                          <input
                            autoFocus
                            defaultValue={m.title}
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => {
                              if (e.nativeEvent.isComposing) return
                              if (e.key === 'Enter') e.currentTarget.blur()
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                            onBlur={(e) => { void renameMeeting(m, e.target.value); setRenamingId(null) }}
                            className="input !h-6 flex-1 min-w-0 px-1 text-sm"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => setSelectedId(m.id)}
                          className={`w-full flex items-center gap-2.5 px-5 py-2 text-left text-sm transition-colors ${
                            active ? 'bg-bg-overlay' : ''
                          } hover:bg-bg-overlay/50`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot(m.status)}`} />
                          <span className="flex-1 min-w-0 truncate text-text-1">{m.title}</span>
                          <span className="text-[11px] text-text-3 font-mono tabular-nums shrink-0 group-hover:hidden">
                            {fmtClock(m.audio.duration_ms)}
                          </span>
                          <span
                            onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === m.id ? null : m.id) }}
                            className="hidden group-hover:flex w-5 h-5 items-center justify-center rounded text-text-3 hover:text-text-1 shrink-0"
                            title="更多操作"
                          >⋯</span>
                        </button>
                      )}
                      {menuFor === m.id && (
                        <div data-rowmenu className="card shadow-lg absolute right-2 top-8 z-50 w-36 p-1 flex flex-col gap-0.5">
                          <button
                            className="px-2 py-1.5 rounded-[6px] text-[13px] text-left text-text-1 hover:bg-bg-overlay transition-colors"
                            onClick={() => { setRenamingId(m.id); setMenuFor(null) }}
                          >重命名</button>
                          <button
                            className="px-2 py-1.5 rounded-[6px] text-[13px] text-left text-danger hover:bg-bg-overlay transition-colors"
                            onClick={() => {
                              setMenuFor(null)
                              if (window.confirm(`删除「${m.title}」？所有关联转录、纪要、待办都会被清理。`)) {
                                void deleteMeetingCascade(m).then(() => { if (selectedId === m.id) setSelectedId(null) })
                              }
                            }}
                          >删除</button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* 预览 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {active ? (
          <MeetingPreview meeting={active} onOpen={() => goMeeting(active.id)} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <EmptyState icon="◐" title="选择左侧一条会议" hint="预览卡片；点条目进入完整详情。" />
          </div>
        )}
      </div>
    </div>
  )
}

function MeetingPreview({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }): JSX.Element {
  const transcript = useLiveQuery(
    () => db.transcripts.where('meeting_id').equals(meeting.id).first(),
    [meeting.id],
  )
  const summary = useLiveQuery(
    () => db.summaries.where('meeting_id').equals(meeting.id).first(),
    [meeting.id],
  )
  const pendingTodos = useLiveQuery(
    () => db.todos.where('meeting_id').equals(meeting.id).and((x) => x.status === 'pending_review').count(),
    [meeting.id],
  ) ?? 0

  return (
    <div className="max-w-[720px] mx-auto px-8 py-10">
      <div className="flex items-center gap-2 mb-3">
        <span className={`h-2 w-2 rounded-full ${statusDot(meeting.status)}`} />
        <span className="text-xs text-text-3">{statusText(meeting)}</span>
        <span className="ml-auto text-xs text-text-3">{fmtDateTime(meeting.started_at)}</span>
      </div>
      <h2 className="text-2xl font-semibold text-text-1 mb-1">{meeting.title}</h2>
      <div className="flex items-center gap-3 text-xs text-text-3 mb-6">
        <span className="tabular-nums">{fmtClock(meeting.audio.duration_ms)}</span>
        <span>·</span>
        <span>音频 {meeting.audio.format} · {meeting.audio.chunk_count} 片</span>
        {meeting.audio.size_bytes > 0 && (
          <>
            <span>·</span>
            <span>{(meeting.audio.size_bytes / (1024 * 1024)).toFixed(1)} MB</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <Stat label="转录" value={transcript ? `${transcript.segments.length} 段` : '—'} />
        <Stat label="纪要" value={summary ? '已生成' : '—'} />
        <Stat label="待审待办" value={String(pendingTodos)} />
      </div>

      {summary ? (
        <div className="card p-5 mb-6">
          <div className="section-title mb-2">摘要预览</div>
          <p className="text-sm text-text-2 line-clamp-4 whitespace-pre-wrap">{summary.content_md}</p>
        </div>
      ) : (
        <div className="card p-5 mb-6">
          <div className="section-title mb-2">尚未生成纪要</div>
          <p className="text-sm text-text-3">在详情页可触发总结，或换模板重新生成。</p>
        </div>
      )}

      <button onClick={onOpen} className="btn-primary h-10 px-5">打开详情 →</button>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card p-3">
      <div className="text-[11px] text-text-3 tracking-wider uppercase">{label}</div>
      <div className="text-base text-text-1 font-medium mt-1">{value}</div>
    </div>
  )
}

/** 导入腾讯会议 / 飞书妙记导出的转录文本 */
function ImportModal({ onClose }: { onClose: () => void }): JSX.Element {
  const goMeeting = useUI((s) => s.goMeeting)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState<'tencent' | 'feishu'>('tencent')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0]
    if (!f) return
    setText(await f.text())
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''))
  }

  async function submit(): Promise<void> {
    if (!title.trim()) { setErr('填个标题'); return }
    if (!text.trim()) { setErr('粘贴或选择转录文本'); return }
    setBusy(true)
    setErr('')
    try {
      const id = await importTranscriptText(db, { title: title.trim(), source, text })
      onClose()
      goMeeting(id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="card w-[480px] max-h-[80vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="section-title mb-3">导入转录</div>
        <div className="space-y-3">
          <input
            className="input w-full" placeholder="会议标题" value={title}
            onChange={(e) => setTitle(e.target.value)} autoFocus
          />
          <div className="flex items-center gap-3">
            <select className="input text-xs h-8" value={source} onChange={(e) => setSource(e.target.value as 'tencent' | 'feishu')}>
              <option value="tencent">腾讯会议</option>
              <option value="feishu">飞书妙记</option>
            </select>
            <label className="text-xs text-accent cursor-pointer hover:underline">
              选择 .txt 文件
              <input type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => void onFile(e)} />
            </label>
          </div>
          <textarea
            className="input w-full h-48 text-xs font-mono resize-y"
            placeholder={'粘贴转录文本，支持：\n00:01:23 张三: 大家好\n[00:01:23] 李四 大家好\n或纯文本'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost text-xs h-8 px-3" onClick={onClose}>取消</button>
            <button className="btn-primary text-xs h-8 px-4" disabled={busy} onClick={() => void submit()}>
              {busy ? '导入中…' : '导入'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}