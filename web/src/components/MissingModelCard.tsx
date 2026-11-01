import { MODEL_MISSING } from '../llm/builtin'
import { CATALOG, downloadModel, modelState, useBuiltinModels, type CatalogModel } from '../lib/builtinModels'

/** 缺模型错误 → 可操作的下载卡片（把「语音转录模型」和「笔记/对话模型」说清楚） */
export default function MissingModelCard({ err }: { err: string }): JSX.Element {
  useBuiltinModels((s) => s.models) // 订阅下载进度
  const nameInErr = /：(.+?)。/.exec(err)?.[1] ?? ''
  const target: CatalogModel | undefined = CATALOG.find((x) => nameInErr.includes(x.name))
  const st = target ? modelState(target.id) : null
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-left space-y-2">
      <div className="text-[13px] text-text-1 font-medium">
        还缺{target?.kind === 'asr' ? '语音转录' : '笔记 / 对话'}模型{target ? `「${target.name}」` : ''}
      </div>
      <p className="text-[11.5px] text-text-3 leading-relaxed">
        转录（听懂录音）和笔记（AI 助手 / 整理纪要）是两个独立模型，各下各的——你可能只下了其中一个。
      </p>
      {target && st?.state === 'downloading' ? (
        <p className="text-[11.5px] text-text-2">正在下载…（可离开，后台继续，下好后自动可用）</p>
      ) : target ? (
        <button onClick={() => void downloadModel(target.id)} className="btn-primary text-xs h-7 px-3">
          一键下载（{(target.bytes / 1e9).toFixed(1)}GB）
        </button>
      ) : null}
    </div>
  )
}

export const isModelMissing = (err: string): boolean => err.startsWith(MODEL_MISSING)
