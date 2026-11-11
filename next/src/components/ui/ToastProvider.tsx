import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type ToastApi, type ToastTone } from './toast';

interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
}

const TONE_STYLE: Record<ToastTone, string> = {
  success: 'border-gold/40',
  info: 'border-line',
  error: 'border-danger/60',
};

/** Errors stay until dismissed (the user needs to read them); other toasts clear themselves. */
const AUTO_DISMISS_MS = 4_500;

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setItems((current) => [...current.slice(-3), { id, tone, message }]);
      if (tone !== 'error') {
        const timer = setTimeout(() => {
          dismiss(id);
        }, AUTO_DISMISS_MS);
        timers.current.set(id, timer);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6"
        data-testid="toast-region"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border bg-surface-3 px-4 py-3 text-sm shadow-2xl cv-fade ${TONE_STYLE[item.tone]}`}
          >
            <span className="flex-1 leading-snug">{item.message}</span>
            <button
              type="button"
              onClick={() => {
                dismiss(item.id);
              }}
              className="text-muted hover:text-text -mr-1 rounded-full px-2 text-base leading-none"
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
