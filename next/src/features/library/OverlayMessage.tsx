import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

interface Props {
  readonly title: string;
  readonly message: string;
  readonly onClose: () => void;
}

/** Used when an overlay URL cannot show its normal content (not found, view-only, loading). */
export function OverlayMessage({ title, message, onClose }: Props) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="text-muted text-sm leading-relaxed">{message}</p>
      <div className="mt-6 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

export function OverlayLoading({ onClose }: { readonly onClose: () => void }) {
  return (
    <Dialog title="Loading…" onClose={onClose}>
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="sr-only">Loading title</span>
        <div className="bg-surface-2 h-4 w-2/3 animate-pulse rounded" />
        <div className="bg-surface-2 h-4 w-1/2 animate-pulse rounded" />
        <div className="bg-surface-2 h-24 animate-pulse rounded-2xl" />
      </div>
    </Dialog>
  );
}
