/**
 * The last line of defence: if a render throws, say so plainly and offer a
 * reload instead of leaving a blank page. The document itself is saved on the
 * server, so reloading loses nothing that was synced.
 */
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <p className="app-error__title">Playground hit a problem and stopped.</p>
        <p className="app-error__body">Your work is saved. Reload to pick up where you left off.</p>
        <button type="button" className="app-error__action" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
