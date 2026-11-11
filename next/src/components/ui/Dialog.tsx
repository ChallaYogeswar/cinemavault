import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Small text above the title, e.g. "Add to library". */
  readonly eyebrow?: string;
  readonly size?: 'md' | 'lg';
}

/**
 * Modal dialog: a bottom sheet on phones, a centred card from `sm` up.
 * Accessibility: role=dialog + aria-modal, labelled by its title, focus moves in on open, Tab is
 * trapped, Escape and a backdrop click close it, page scroll is locked, and focus returns to the
 * element that opened it. Mount it conditionally; unmounting closes it.
 */
export function Dialog({ title, onClose, children, eyebrow, size = 'md' }: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Prefer the first field over the close button so typing can start immediately.
    const first =
      panel?.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select, textarea',
      ) ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const head = items[0];
      const tail = items[items.length - 1];
      if (!head || !tail) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === head || document.activeElement === panel)) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`cv-fade border-line bg-surface relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] border p-5 shadow-2xl outline-none sm:rounded-[28px] sm:p-7 ${
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
        }`}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-gold mb-1.5 font-mono text-[11px] uppercase tracking-[0.2em]">
                {eyebrow}
              </p>
            ) : null}
            <h2
              id={titleId}
              className="font-serif text-2xl font-semibold leading-tight tracking-tight break-words sm:text-3xl"
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="border-line text-muted hover:text-text grid size-10 shrink-0 place-items-center rounded-full border text-lg leading-none transition-colors"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
