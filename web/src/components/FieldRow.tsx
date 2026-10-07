import type { ReactNode } from 'react'

/**
 * label + control 一行的表单原语（DESIGN §5.2）。
 */
export interface FieldRowProps {
  label: string
  hint?: string
  htmlFor?: string
  children: ReactNode
}

export default function FieldRow({ label, hint, htmlFor, children }: FieldRowProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="label" htmlFor={htmlFor}>
        {label}
        {hint && <span className="text-text-3 font-normal"> · {hint}</span>}
      </label>
      {children}
    </div>
  )
}