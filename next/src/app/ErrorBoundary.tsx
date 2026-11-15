import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from './errorReporter';

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly failed: boolean;
}

/**
 * The last line of defence: anything that breaks while drawing outside a screen (the providers,
 * sign-in handling) ends here instead of in a blank page. Screens have their own, friendlier
 * `RouteError`; this one deliberately uses no app components or styles beyond plain markup, because
 * whatever broke may be exactly those.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    reportError(error, 'render');
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '1.5rem',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: '28rem' }}>
          <h1 style={{ fontSize: '1.5rem', margin: 0 }}>CinemaVault hit a problem</h1>
          <p style={{ opacity: 0.75, lineHeight: 1.5 }}>
            Your library is safe. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.reload();
            }}
            style={{
              minHeight: '2.75rem',
              padding: '0 1.25rem',
              borderRadius: '999px',
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
}
