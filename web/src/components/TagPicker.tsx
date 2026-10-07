import { useState, useMemo } from 'react'
import { db } from '../db/db'
import { useLiveQuery } from 'dexie-react-hooks'
import { now, uid } from '../lib/id'
import type { Tag, TagBinding } from '../types'

export interface TagPickerProps {
  targetType: 'todo' | 'note' | 'meeting'
  targetId: string
}

/**
 * 极简 chip 输入：键入名字 + Enter 创建/绑定；点击 ✕ 解绑。
 */
export default function TagPicker({ targetType, targetId }: TagPickerProps): JSX.Element {
  const [input, setInput] = useState('')

  const bindings = useLiveQuery(
    () => db.tagBindings.where('[target_type+target_id]').equals([targetType, targetId]).toArray(),
    [targetType, targetId],
  )
  const boundTagIds = useMemo(() => (bindings ?? []).map((b) => b.tag_id), [bindings])

  const allTags = useLiveQuery(() => db.tags.orderBy('name').toArray(), []) ?? []
  const boundTags = useMemo(
    () => allTags.filter((t) => boundTagIds.includes(t.id)),
    [allTags, boundTagIds],
  )

  async function commit(name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    let tag: Tag | undefined = allTags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())
    if (!tag) {
      tag = {
        id: uid(),
        name: trimmed,
        color: '#888',
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
        sync_version: 0,
      }
      await db.tags.add(tag)
    }
    if (boundTagIds.includes(tag.id)) {
      setInput('')
      return
    }
    const binding: TagBinding = {
      id: uid(),
      tag_id: tag.id,
      target_type: targetType,
      target_id: targetId,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      sync_version: 0,
    }
    await db.tagBindings.add(binding)
    setInput('')
  }

  async function unbind(tagId: string): Promise<void> {
    const binding = (bindings ?? []).find((b) => b.tag_id === tagId)
    if (!binding) return
    await db.tagBindings.delete(binding.id)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {boundTags.map((t) => (
        <span key={t.id} className="chip">
          #{t.name}
          <button
            type="button"
            aria-label="解绑标签"
            onClick={() => void unbind(t.id)}
            className="text-text-3 hover:text-danger leading-none ml-0.5"
          >✕</button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(input)
          } else if (e.key === 'Backspace' && input === '' && boundTags.length > 0) {
            void unbind(boundTags[boundTags.length - 1].id)
          }
        }}
        placeholder="加标签…"
        className="bg-transparent text-xs outline-none placeholder:text-text-3 w-20"
      />
    </div>
  )
}