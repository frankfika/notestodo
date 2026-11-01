import type { Tag } from '../../types'

/** 任务行上的 tag 小 chips：最多 2 个，多出折叠为 +n */
export default function TodoTags({ ids, tagsById }: { ids: string[]; tagsById: Map<string, Tag> }): JSX.Element | null {
  if (ids.length === 0) return null
  const shown = ids.slice(0, 2)
  return (
    <span className="flex items-center gap-1 shrink-0">
      {shown.map((id) => {
        const tag = tagsById.get(id)
        if (!tag) return null
        return (
          <span key={id} className="px-1.5 h-[18px] leading-[18px] rounded-[5px] text-[10px] bg-bg-overlay text-text-2">
            {tag.name}
          </span>
        )
      })}
      {ids.length > 2 && <span className="text-[10px] text-text-3">+{ids.length - 2}</span>}
    </span>
  )
}
