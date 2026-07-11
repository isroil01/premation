/**
 * ErrorBoundary — catches render/runtime errors in the React tree, logs them
 * through the Logger, and shows a professional recovery surface instead of a
 * blank screen. Wrap the app root (and, later, individual panels) with it.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getLogger } from '@core/logging/Logger';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback. Receives the error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Label for logs (e.g. panel name). */
  scope?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      getLogger().scope(this.props.scope ?? 'ui').error('Uncaught render error', {
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
      });
    } catch {
      /* logging must never itself throw here */
    }
  }

  private reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className={styles.root} role="alert">
        <div className={styles.card}>
          <div className={styles.badge}>Editor error</div>
          <h1 className={styles.title}>Something went wrong</h1>
          <p className={styles.message}>{error.message || 'An unexpected error occurred.'}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={this.reset}>Try again</button>
            <button type="button" className={styles.primary} onClick={() => window.location.reload()}>Reload editor</button>
          </div>
        </div>
      </div>
    );
  }
}
