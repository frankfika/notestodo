import { useState, type FormEvent } from "react";

export function Composer({
  placeholder,
  disabled,
  onSubmit,
}: {
  placeholder: string;
  disabled?: boolean;
  onSubmit: (text: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    try {
      await onSubmit(text);
      setValue("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="hy-glass hy-glass-strong px-3 py-2 flex items-end gap-2">
      <textarea
        className="hy-input !w-auto min-w-0 flex-1 !border-0 !shadow-none !bg-transparent min-h-[44px] max-h-32 resize-none"
        rows={1}
        placeholder={placeholder}
        value={value}
        disabled={disabled || busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit(e);
          }
        }}
      />
      <button
        className="hy-btn shrink-0 whitespace-nowrap self-end"
        disabled={disabled || busy || !value.trim()}
        type="submit"
        aria-label="发送"
      >
        发送
      </button>
    </form>
  );
}
