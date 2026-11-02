import { useState } from 'react'

/**
 * 原生 <input type="date"> + 中文占位覆盖层。
 * 空值且未聚焦时藏起浏览器原生的 mm/dd/yyyy（随浏览器语言变化，中文 UI 里突兀），
 * 用覆盖层显示「年/月/日」；聚焦或已有值时恢复原生段选/文本。
 */
export default function DateInput({ value, onChange, className, title }: {
  value: string
  onChange: (v: string) => void
  className?: string
  title?: string
}): JSX.Element {
  const [focused, setFocused] = useState(false)
  const empty = !value
  const hideNative = empty && !focused
  return (
    <span className="relative inline-flex">
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        title={title}
        className={`${className ?? ''} ${hideNative ? 'text-transparent' : ''}`}
      />
      {hideNative && (
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-text-3">
          年/月/日
        </span>
      )}
    </span>
  )
}
