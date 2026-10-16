/**
 * 同一场会议同一阶段只跑一份：并发调用（两个模型先后下完触发两次续跑、双击重新整理……）
 * 共享正在进行的那次，避免重复写转录 / 重复生成待办。
 */
export function oncePerMeeting(fn: (meetingId: string) => Promise<void>): (meetingId: string) => Promise<void> {
  const inflight = new Map<string, Promise<void>>()
  return (meetingId) => {
    const running = inflight.get(meetingId)
    if (running) return running
    const p = fn(meetingId).finally(() => inflight.delete(meetingId))
    inflight.set(meetingId, p)
    return p
  }
}
