import { create } from 'zustand'

/**
 * 极简全局提示条：左下浮条，支持「撤销」回调。
 * 纯前端、零依赖 —— 用于「删除任务」这类可逆操作，替代 window.confirm。
 */

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastState {
  msg: string | null
  action: ToastAction | null
  /** 每次 show 递增，用于让组件重新挂载并重置计时 */
  key: number
}

interface ToastStore extends ToastState {
  show: (msg: string, action?: ToastAction, ms?: number) => void
  close: () => void
}

export const useToast = create<ToastStore>((set) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
  }
  return {
    msg: null,
    action: null,
    key: 0,
    show: (msg, action, ms = 5000) => {
      clear()
      set((s) => ({ msg, action: action ?? null, key: s.key + 1 }))
      timer = setTimeout(() => set({ msg: null, action: null }), ms)
    },
    close: () => {
      clear()
      set({ msg: null, action: null })
    },
  }
})
