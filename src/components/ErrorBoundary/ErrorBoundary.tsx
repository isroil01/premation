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
  /**
   * Label for logs (e.g. panel name), and what the fallback calls the thing
   * that broke. `'dashboard'` is worded for a page; everything else keeps the
   * editor's wording, which is what the root boundary has always said.
   */
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

  /**
   * What to call the surface, and what reloading it is called.
   *
   * The root boundary catches BOTH the editor and the dashboard, and used to
   * tell a user whose Billing page had thrown that there was an "Editor error"
   * and offer to "Reload editor" — while they were looking at a dashboard. A
   * dashboard-scoped boundary around those routes gets wording that matches
   * where the reader actually is.
   */
  private wording(): { badge: string; reload: string } {
    return this.props.scope === 'dashboard'
      ? { badge: 'Dashboard error', reload: 'Reload page' }
      : { badge: 'Editor error', reload: 'Reload editor' };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className={styles.root} role="alert">
        <div className={styles.card}>
          <div className={styles.badge}>{this.wording().badge}</div>
          <h1 className={styles.title}>Something went wrong</h1>
          <p className={styles.message}>{error.message || 'An unexpected error occurred.'}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={this.reset}>Try again</button>
            <button type="button" className={styles.primary} onClick={() => window.location.reload()}>
              {this.wording().reload}
            </button>
          </div>
          {/* Lazily imported: the help opener pulls in the modal store and the
              docs glob, and a boundary that fails to render its own fallback
              because of an import cycle would be the one thing worse than the
              error it caught. */}
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              void import('@layout/Help/openHelp').then(({ openHelp }) => openHelp('errorBoundary'));
            }}
          >
            Learn more about recovering from errors
          </button>
        </div>
      </div>
    );
  }
}
