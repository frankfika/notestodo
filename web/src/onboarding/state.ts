import { db } from '../db/db'

const ONBOARDING_KEY = 'onboarding_done_v1'

/**
 * 用户做出第一个真实动作后调用，关闭 onboarding 并持久化 done=true。
 * 调用场景：开始录音 / 新建 todo / 新建 Note 等。
 * 在 Onboarding 组件中也会监听 db.kv 变化自动关闭（通过 liveQuery）。
 */
export async function completeOnboarding(): Promise<void> {
  await db.kv.put({ key: ONBOARDING_KEY, value: true })
}

export async function resetOnboarding(): Promise<void> {
  await db.kv.delete(ONBOARDING_KEY)
}

export async function isOnboardingDone(): Promise<boolean> {
  const row = await db.kv.get(ONBOARDING_KEY)
  return row?.value === true
}