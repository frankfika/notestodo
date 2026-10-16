import { db } from '../db/db'
import { now } from '../lib/id'
import { runTranscribePipeline } from './transcribe'
import { runSummarizePipeline } from './summarize'
import type { Meeting, MeetingStatus } from '../types'
import { onModelReady } from '../lib/builtinModels'
import { MODEL_MISSING } from '../llm/builtin'

/**
 * On app boot, sweep the DB for meetings that were left in an in-flight
 * state by a previous session (page reload / tab crash / browser kill) and
 * drive each one back to completion.
 *
 * Convention: anything still in flight AND `updated_at` older than two
 * minutes is treated as crashed (a normal pipeline step never idles that
 * long). Two minutes is generous enough to absorb slow networks but
 * short enough that users notice recovery within the same tab.
 *
 * To avoid an avalanche of simultaneous API calls after a long offline
 * period, we stagger each recovery by 2 s.
 */
const STAGGER_MS = 2000
const STALE_MS = 2 * 60 * 1000
const RECOVERABLE: MeetingStatus[] = [
  'recording',
  'processing',
  'transcribed',
  'summarizing',
]

export async function resumePendingJobs(): Promise<void> {
  const threshold = Date.now() - STALE_MS
  const candidates = await db.meetings.toArray()
  const stale = candidates.filter((m) => {
    if (!RECOVERABLE.includes(m.status)) return false
    if (m.status === 'recording') return true // 录音中断总是需要恢复
    const t = Date.parse(m.updated_at)
    return Number.isFinite(t) && t < threshold
  })

  if (stale.length === 0) return

  // 按时间正序处理 — 早的会议优先恢复
  stale.sort((a, b) => a.started_at.localeCompare(b.started_at))

  let delay = 0
  for (const m of stale) {
    schedule(m, delay)
    delay += STAGGER_MS
  }
}

function schedule(meeting: Meeting, delayMs: number): void {
  setTimeout(() => {
    void recover(meeting).catch((e) => {
      console.error(`恢复会议 ${meeting.id} 失败`, e)
    })
  }, delayMs)
}

async function recover(meeting: Meeting): Promise<void> {
  switch (meeting.status) {
    case 'recording':
      // 上次录音被中断/崩溃。把它视作「正常结束」，转入转录管线。
      await db.meetings.update(meeting.id, {
        status: 'processing',
        ended_at: meeting.ended_at ?? now(),
        updated_at: now(),
      })
      await runTranscribePipeline(meeting.id)
      return

    case 'processing':
      await runTranscribePipeline(meeting.id)
      return

    case 'transcribed':
      // 转录已存在；直接进入总结。
      await runSummarizePipeline(meeting.id)
      return

    case 'summarizing':
      await runSummarizePipeline(meeting.id)
      return

    default:
      return
  }
}

/**
 * 内置模型下载完成 → 自动续跑因「模型未下载」而搁置的会议（录完再下模型也不用手动重试）。
 * 已有转录的直接整理，没有的从转录开始。
 */
export async function resumeModelMissing(): Promise<void> {
  const waiting = (await db.meetings.toArray()).filter((m) => m.status === 'failed' && m.error?.includes(MODEL_MISSING))
  for (const m of waiting) {
    const hasTranscript = await db.transcripts.where('meeting_id').equals(m.id).count()
    if (hasTranscript) {
      await db.meetings.update(m.id, { status: 'summarizing', error: undefined, updated_at: now() })
      await runSummarizePipeline(m.id).catch((e) => console.error('续跑整理失败', e))
    } else {
      await runTranscribePipeline(m.id).catch((e) => console.error('续跑转录失败', e))
    }
  }
}
// 合并触发：续跑进行中又有模型下完（比如笔记模型在转录期间下好）→ 结束后再扫一遍，不漏也不并发
let resuming: Promise<void> | null = null
let again = false
function triggerResume(): void {
  if (resuming) { again = true; return }
  resuming = resumeModelMissing()
    .catch((e) => console.error('续跑失败', e))
    .finally(() => { resuming = null; if (again) { again = false; triggerResume() } })
}
onModelReady(triggerResume)
