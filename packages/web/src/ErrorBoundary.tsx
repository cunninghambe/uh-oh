import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean };

/**
 * Minimal top-level error boundary (H2). Layout previously had no error boundary at all, so
 * any render-time throw (e.g. the hooks-order crash this brief fixes, or any future bug in a
 * page component) produced a blank white screen with no way out but a manual URL edit.
 *
 * React error boundaries must be class components — there is no hook equivalent as of React 19.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Last-resort diagnostic — there's no error reporting path once the UI itself has crashed.
    console.error('uh-oh dashboard crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-6">
          <div className="max-w-sm text-center space-y-4">
            <div className="font-mono text-2xl text-amber-400">uh-oh</div>
            <p className="text-sm text-zinc-400">Something broke on this page.</p>
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
              className="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
