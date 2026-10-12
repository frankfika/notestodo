import { useState } from 'react'

/** ⋯ 菜单：把危险/次要操作收起来，不占 hero 区 */
export default function OverflowMenu({ items }: {
  items: { label: string; onClick: () => void; danger?: boolean }[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="icon-btn" aria-label="更多" title="更多">⋯</button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <ul className="absolute right-0 z-40 mt-1 min-w-[160px] card p-1 text-sm shadow-lg">
            {items.map((it) => (
              <li key={it.label}>
                <button
                  onClick={() => { setOpen(false); it.onClick() }}
                  className={`w-full text-left px-3 py-1.5 rounded-md ${it.danger ? 'text-danger hover:bg-danger/8' : 'text-text-1 hover:bg-bg-overlay'}`}
                >{it.label}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
