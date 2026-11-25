import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

/** 玻璃卡：一切区块容器的基元。strong 用更实的白面（气泡、输入框底）。 */
export function Card({
  children,
  className = "",
  strong = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { strong?: boolean; children: ReactNode }) {
  return (
    <div className={`hy-glass ${strong ? "hy-glass-strong" : ""} ${className}`} {...props}>
      {children}
    </div>
  );
}

export function Button({
  children,
  tone = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" | "quiet" }) {
  const toneClass =
    tone === "ghost"
      ? "hy-btn-ghost"
      : tone === "danger"
        ? "hy-btn-danger"
        : tone === "quiet"
          ? "hy-btn-quiet"
          : "";
  return (
    <button className={`hy-btn ${toneClass} ${className}`} {...props}>
      {children}
    </button>
  );
}

/** 页头：无衬线主标题 + 小字眉题，正文列宽受控。 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 24,
        alignItems: "flex-end",
        marginBottom: 28,
        flexWrap: "wrap",
      }}
    >
      <div style={{ maxWidth: "42rem" }}>
        {eyebrow ? <div className="hy-eyebrow" style={{ marginBottom: 10 }}>{eyebrow}</div> : null}
        <h1 className="hy-title" style={{ margin: 0, fontSize: "var(--hy-fs-2xl)", lineHeight: 1.15 }}>
          {title}
        </h1>
        {description ? (
          <p className="hy-muted" style={{ margin: "10px 0 0", fontSize: "var(--hy-fs-base)", lineHeight: 1.7 }}>
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`hy-pill ${className}`.trim()}>{children}</span>;
}

/** 自绘标记：一枚摊开的纸页与墨点，不使用任何第三方产品图形。 */
export function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M7.5 5.5h12.6L26 11.3v15.2a1.5 1.5 0 0 1-1.5 1.5h-17a1.5 1.5 0 0 1-1.5-1.5V7a1.5 1.5 0 0 1 1.5-1.5Z"
        style={{ fill: "#fbfcfe", stroke: "var(--hy-accent)" }}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M20 5.5v5.8h6"
        style={{ fill: "none", stroke: "var(--hy-accent)" }}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M11 17.5h10M11 21.5h6.5"
        style={{ fill: "none", stroke: "var(--hy-ink-soft)" }}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
