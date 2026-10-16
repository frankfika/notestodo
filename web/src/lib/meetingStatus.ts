import { MODEL_MISSING } from '../llm/builtin'
import type { Meeting } from '../types'

/** 会议展示状态：在等本地模型下载的不算「失败」（录音已安全保存，模型就绪后自动续跑） */
export type DisplayStatus = Meeting['status'] | 'waiting_model'

export const displayStatus = (m: Pick<Meeting, 'status' | 'error'>): DisplayStatus =>
  m.status === 'failed' && m.error?.includes(MODEL_MISSING) ? 'waiting_model' : m.status

const LABEL: Record<DisplayStatus, string> = {
  recording: '录音中', processing: '转录中', transcribed: '整理中', summarizing: '整理中',
  summarized: '已完成', failed: '失败', waiting_model: '等待模型',
}
export const statusText = (m: Pick<Meeting, 'status' | 'error'>): string => LABEL[displayStatus(m)]
