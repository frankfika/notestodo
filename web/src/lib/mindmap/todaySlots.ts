import { db } from '../../db/db'
import { now } from '../id'
import type { ID } from '../../types'
import { indexByParent, todayEligible } from './leaf'
import type { AddSlotResult, TodaySlot, TodayState } from './types'

const KV_KEY = 'today_slots'
const DEFAULT: TodayState = { capacity: 5, slots: [] }

function clampCap(n: number): number {
  return Math.min(7, Math.max(3, Math.round(n)))
}

export async function getToday(): Promise<TodayState> {
  const row = await db.kv.get(KV_KEY)
  const v = (row?.value ?? null) as TodayState | null
  if (!v || !Array.isArray(v.slots)) return { ...DEFAULT, slots: [] }
  return { capacity: clampCap(v.capacity ?? 5), slots: v.slots }
}

/**
 * 槽位写路径全部串行化。
 *
 * getToday→setToday 是读-改-写，Dexie 的表锁管不到这个粒度：
 * 之前 addSlot / swapSlot / evict / purge 并发交错会静默丢更新
 * （比如 applyTodoStatus 的 fire-and-forget purge 撞上随后的 addSlot）。
 * 所有公开写操作排进这条 promise 链，一次只跑一个。
 */
let writeChain: Promise<void> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeChain.then(fn)
  writeChain = p.then(
    () => undefined,
    () => undefined,
  )
  return p
}

export async function setToday(state: TodayState): Promise<void> {
  const slots: TodaySlot[] = []
  const seen = new Set<string>()
  for (const s of state.slots) {
    if (seen.has(s.leafId)) continue
    seen.add(s.leafId)
    slots.push(s)
  }
  await db.kv.put({
    key: KV_KEY,
    value: { capacity: clampCap(state.capacity), slots },
  })
}

export async function addSlot(leafId: ID, mapId: ID): Promise<AddSlotResult> {
  return serialized(async () => {
    const state = await getToday()
    if (state.slots.some((s) => s.leafId === leafId)) {
      return { ok: false, reason: 'duplicate', state }
    }
    const all = await db.todos.toArray()
    const byParent = indexByParent(all)
    const t = all.find((x) => x.id === leafId)
    if (!t || !todayEligible(t, byParent)) {
      return { ok: false, reason: 'not_eligible', state }
    }
    if (state.slots.length >= state.capacity) {
      return { ok: false, reason: 'full', state }
    }
    const next: TodayState = {
      ...state,
      slots: [...state.slots, { leafId, mapId, slottedAt: now() }],
    }
    await setToday(next)
    return { ok: true, state: next }
  })
}

/**
 * 换出：一次串行化内原子完成「删旧 + 加新」。
 * 之前是先 removeSlot 再 addSlot 两次独立读-改-写 —— add 失败时旧槽已丢。
 */
export async function swapSlot(
  leafId: ID,
  mapId: ID,
  swapOutId: ID,
): Promise<AddSlotResult> {
  return serialized(async () => {
    const state = await getToday()
    if (!state.slots.some((s) => s.leafId === swapOutId)) {
      return { ok: false, reason: 'not_eligible', state }
    }
    if (state.slots.some((s) => s.leafId === leafId)) {
      return { ok: false, reason: 'duplicate', state }
    }
    const all = await db.todos.toArray()
    const byParent = indexByParent(all)
    const t = all.find((x) => x.id === leafId)
    if (!t || !todayEligible(t, byParent)) {
      return { ok: false, reason: 'not_eligible', state }
    }
    const next: TodayState = {
      ...state,
      slots: [
        ...state.slots.filter((s) => s.leafId !== swapOutId),
        { leafId, mapId, slottedAt: now() },
      ],
    }
    await setToday(next)
    return { ok: true, state: next }
  })
}

export async function removeSlot(leafId: ID): Promise<TodayState> {
  return serialized(async () => {
    const state = await getToday()
    const next = { ...state, slots: state.slots.filter((s) => s.leafId !== leafId) }
    await setToday(next)
    return next
  })
}

/** 若在槽则踢出；完成 / 变结构 / Waiting / 软删时调用 */
export async function evictIfPresent(leafId: ID): Promise<boolean> {
  return serialized(async () => {
    const state = await getToday()
    if (!state.slots.some((s) => s.leafId === leafId)) return false
    const next = { ...state, slots: state.slots.filter((s) => s.leafId !== leafId) }
    await setToday(next)
    return true
  })
}

/** 结构或状态变化后清扫不再符合条件的槽位 */
export async function purgeIneligibleSlots(): Promise<TodayState> {
  return serialized(async () => {
    const state = await getToday()
    if (state.slots.length === 0) return state
    const all = await db.todos.toArray()
    const byParent = indexByParent(all)
    const slots = state.slots.filter((s) => {
      const t = all.find((x) => x.id === s.leafId)
      return t && todayEligible(t, byParent)
    })
    if (slots.length === state.slots.length) return state
    const next = { ...state, slots }
    await setToday(next)
    return next
  })
}

/** API 响应用 snake_case */
export function todayStatePublic(state: TodayState, todos: { id: string; title: string }[]): unknown {
  const titleOf = (id: string) => todos.find((t) => t.id === id)?.title ?? ''
  return {
    capacity: state.capacity,
    slots: state.slots.map((s) => ({
      leaf_id: s.leafId,
      map_id: s.mapId,
      title: titleOf(s.leafId),
      slotted_at: s.slottedAt,
    })),
  }
}

export function slotsPublicOnly(state: TodayState): { leaf_id: string; map_id: string; slotted_at: string }[] {
  return state.slots.map((s) => ({
    leaf_id: s.leafId,
    map_id: s.mapId,
    slotted_at: s.slottedAt,
  }))
}
