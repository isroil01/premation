/**
 * The renderer half of auto-update.
 *
 * What is worth pinning here is the QUIET: the shell now checks, downloads and
 * installs on its own, and the whole design depends on the renderer staying
 * silent through all of it except for the one moment a restart is pending. A
 * regression that starts toasting "checking for updates…" every six hours would
 * type-check, run, and be exactly the interruption this replaced.
 */

import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useAutoUpdate } from './useAutoUpdate';
import { NotificationHost } from '@layout/overlays/NotificationHost';
import { TooltipProvider } from '@components/Tooltip';
import { useUIStore } from '@stores/uiStore';
import type { UpdateStatus } from '@app-types/motionEditor';

/** A stand-in for the Electron preload bridge. */
function installBridge(): {
  push: (status: UpdateStatus) => void;
  restarts: () => number;
  subscribers: () => number;
} {
  const listeners = new Set<(s: UpdateStatus) => void>();
  let restarts = 0;
  (window as unknown as { motionEditor: unknown }).motionEditor = {
    updates: {
      getStatus: () => Promise.resolve<UpdateStatus>({ kind: 'idle' }),
      onStatus: (h: (s: UpdateStatus) => void) => {
        listeners.add(h);
        return () => listeners.delete(h);
      },
      getSettings: () => Promise.resolve({ autoDownload: true }),
      setAutoDownload: (v: boolean) => Promise.resolve({ autoDownload: v }),
      check: () => Promise.resolve<UpdateStatus>({ kind: 'idle' }),
      downloadNow: () => Promise.resolve(true),
      restartAndInstall: () => {
        restarts += 1;
        return Promise.resolve();
      },
    },
  };
  return {
    push: (status) => act(() => { listeners.forEach((l) => l(status)); }),
    restarts: () => restarts,
    subscribers: () => listeners.size,
  };
}

/**
 * The hook plus the surface it drives, so these assert what a user would see
 * rather than what the store happens to hold.
 *
 * `TooltipProvider` because the toast's dismiss button is an `IconButton`, and
 * that renders a Radix tooltip which throws outside a provider.
 */
function Harness(): JSX.Element {
  useAutoUpdate();
  return (
    <TooltipProvider>
      <NotificationHost />
    </TooltipProvider>
  );
}

beforeEach(() => {
  useUIStore.setState({ notifications: [] });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('useAutoUpdate', () => {
  it('says nothing while the shell checks and downloads', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'checking' });
    bridge.push({ kind: 'available', version: '0.4.0', downloading: true });
    bridge.push({ kind: 'downloading', version: '0.4.0', percent: 12 });
    bridge.push({ kind: 'downloading', version: '0.4.0', percent: 87 });

    expect(useUIStore.getState().notifications).toHaveLength(0);
  });

  it('stays silent on errors — a failed check is not the user’s problem', () => {
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'error', message: 'getaddrinfo ENOTFOUND github.com' });
    expect(useUIStore.getState().notifications).toHaveLength(0);
  });

  it('announces exactly once when an update is ready to install', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'ready', version: '0.4.0' });

    const notes = useUIStore.getState().notifications;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('0.4.0');
    // Never auto-dismisses: a restart prompt that vanishes after 2.6s cannot be
    // acted on.
    expect(notes[0]!.durationMs).toBe(0);
  });

  it('does not repeat for a version it already announced', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'ready', version: '0.4.0' });
    bridge.push({ kind: 'ready', version: '0.4.0' });
    bridge.push({ kind: 'ready', version: '0.4.0' });

    expect(useUIStore.getState().notifications).toHaveLength(1);
  });

  it('announces a genuinely newer version after the first', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'ready', version: '0.4.0' });
    bridge.push({ kind: 'ready', version: '0.4.1' });

    expect(useUIStore.getState().notifications).toHaveLength(2);
  });

  it('offers Restart now, and it reaches the shell', () => {
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'ready', version: '0.4.0' });

    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));

    expect(bridge.restarts()).toBe(1);
    // The toast goes first, so the window is not left showing a live prompt
    // while the app tears down.
    expect(useUIStore.getState().notifications).toHaveLength(0);
  });

  it('can be dismissed without restarting', () => {
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'ready', version: '0.4.0' });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(useUIStore.getState().notifications).toHaveLength(0);
    expect(bridge.restarts()).toBe(0);
  });

  it('catches up on a status that arrived before it mounted', async () => {
    installBridge();
    // A reload lands here: the download finished while the renderer was gone.
    (window as unknown as { motionEditor: { updates: { getStatus: () => Promise<UpdateStatus> } } })
      .motionEditor.updates.getStatus = () => Promise.resolve({ kind: 'ready', version: '0.4.2' });

    render(<Harness />);

    await waitFor(() => expect(useUIStore.getState().notifications).toHaveLength(1));
    expect(useUIStore.getState().notifications[0]!.message).toContain('0.4.2');
  });

  it('unsubscribes on unmount', () => {
    const bridge = installBridge();
    const view = render(<Harness />);
    expect(bridge.subscribers()).toBe(1);
    view.unmount();
    expect(bridge.subscribers()).toBe(0);
  });

  it('does nothing at all in a browser build, where there is no shell', () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    expect(() => render(<Harness />)).not.toThrow();
    expect(useUIStore.getState().notifications).toHaveLength(0);
  });
});
