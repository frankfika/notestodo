import { db } from '../db/db'

/**
 * 转录热词：让人名 / 术语按正确写法出现（实测：没有热词时「李四」→「理事」、「PoC」→「point」）。
 * 来源按优先级：用户在设置里填的常用词 → 待办里出现过的负责人 → 本场速记里的短词 → 会议标题。
 */
export function mergeHotwords(...groups: (string | string[] | undefined)[]): string[] {
  const out: string[] = []
  for (const g of groups) {
    const items = typeof g === 'string' ? g.split(/[\n,，、;；]/) : g ?? []
    for (const raw of items) {
      const w = raw.trim().replace(/^@/, '')
      // 太长的是句子不是词；默认占位标题不算
      if (!w || w.length > 16 || /^会议\s*·/.test(w)) continue
      if (!out.includes(w)) out.push(w)
    }
  }
  return out.slice(0, 40)
}

/** 尽力而为：收集失败绝不影响转录本身（返回空列表） */
export async function collectHotwords(meetingId: string, userList: string): Promise<string[]> {
  try {
    return await collect(meetingId, userList)
  } catch (e) {
    console.warn('收集热词失败，按无热词转录', e)
    return mergeHotwords(userList)
  }
}

async function collect(meetingId: string, userList: string): Promise<string[]> {
  const [meeting, todos, scribbles] = await Promise.all([
    db.meetings.get(meetingId),
    db.todos.toArray(), // updated_at 无索引：全量读后按负责人出现频次排序
    db.scribbles.where('meeting_id').equals(meetingId).toArray(),
  ])
  const freq = new Map<string, number>()
  for (const t of todos) if (t.assignee && !t.deleted_at) freq.set(t.assignee, (freq.get(t.assignee) ?? 0) + 1)
  const assignees = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  // 速记里 2–12 字的短条目多是人名 / 术语 / 关键词
  const shorts = scribbles.flatMap((s) => s.text.split(/[\s,，、/]+/)).filter((w) => w.length >= 2 && w.length <= 12)
  return mergeHotwords(userList, assignees, shorts, meeting?.title)
}
