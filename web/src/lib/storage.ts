/**
 * 存储持久化与配额 — 本地优先应用的生死项。
 *
 * 浏览器在磁盘压力下可能驱逐未持久化的 IndexedDB（Best-Effort），
 * Safari ITP 更是默认 7 天不互动即删脚本存储。录音/纪要/待办一旦被驱逐
 * 无法找回，因此启动时必须尽早申请 persistent storage。
 *
 * 参考：
 *   - MDN StorageManager.persist() — https://developer.mozilla.org/docs/Web/API/StorageManager/persist
 *   - WebKit ITP 7 天上限说明（已对安装型 PWA/主屏幕应用豁免）
 */

export interface StorageStatus {
  /** persistent 已获批（一旦批准终身有效，除非用户在浏览器设置里撤回） */
  persisted: boolean
  /** 浏览器不支持 storage.persist（如旧 Firefox private window） */
  supported: boolean
  /** 已用 / 配额（bytes），不可用时为 null */
  usage: number | null
  quota: number | null
}

/** 启动时调用：申请持久化 + 读取配额。失败静默（某些上下文会 throw）。 */
export async function ensurePersistentStorage(): Promise<StorageStatus> {
  const status: StorageStatus = {
    persisted: false,
    supported: false,
    usage: null,
    quota: null,
  }
  try {
    if (navigator.storage?.persist) {
      status.supported = true
      status.persisted = await navigator.storage.persist()
    }
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate()
      status.usage = est.usage ?? null
      status.quota = est.quota ?? null
    }
  } catch {
    // 隐私模式 / 不支持的环境 — 应用照常工作，只是 Best-Effort 持久化
  }
  return status
}

/** 设置页展示用：把字节数转成人话。 */
export function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}