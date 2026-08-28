/**
 * The renderer half of auto-update.
 *
 * Two things are worth pinning, and they pull against each other.
 *
 * THE QUIET: the shell checks, downloads and installs on its own, and the whole
 * design depends on the renderer staying silent through all of it. A regression
 * that starts announcing "checking for updates…" every six hours would
 * type-check, run, and be exactly the interruption this replaced.
 *
 * THE ONE LOUD THING: when a version IS waiting, the user has to see it. That
 * used to be a toast, and users reported not noticing it — a corner notice that
 * competes with every other notice and can be dismissed, after which an update
 * was ready with nothing on screen saying so. It is now a persistent button in
 * the title bar, so what these tests assert is that the FACT survives (the
 * store), not that a transient appeared.
 */

import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useAutoUpdate } from './useAutoUpdate';
import { useUpdateStore } from './updateStore';
import { UpdateButton } from '@layout/TitleBar/UpdateButton';
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
 * The hook plus the control it drives, so these assert what a user would see
 * rather than what the store happens to hold.
 */
function Harness(): JSX.Element {
  useAutoUpdate();
  return <UpdateButton />;
}

const button = (): HTMLElement | null => screen.queryByRole('button', { name: /Restart to update/i });

beforeEach(() => {
  useUIStore.setState({ notifications: [] });
  useUpdateStore.setState({ readyVersion: null, restarting: false });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('useAutoUpdate — the quiet', () => {
  it('shows nothing while the shell checks and downloads', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'checking' });
    bridge.push({ kind: 'available', version: '0.4.0', downloading: true });
    bridge.push({ kind: 'downloading', version: '0.4.0', percent: 12 });
    bridge.push({ kind: 'downloading', version: '0.4.0', percent: 87 });

    expect(button()).toBeNull();
    expect(useUpdateStore.getState().readyVersion).toBeNull();
  });

  it('stays silent on errors — a failed check is not the user’s problem', () => {
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'error', message: 'getaddrinfo ENOTFOUND github.com' });
    expect(button()).toBeNull();
  });

  it('raises no toast at all — the button replaced it, it did not join it', () => {
    // Both at once would announce one update twice.
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'ready', version: '0.4.0' });
    expect(useUIStore.getState().notifications).toHaveLength(0);
  });
});

describe('useAutoUpdate — the standing notice', () => {
  it('shows the button when a version is waiting to install', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'ready', version: '0.4.0' });

    expect(button()).not.toBeNull();
    // The version rides in the accessible name and the tooltip, not the label —
    // a label that changes width reflows the whole title bar.
    expect(button()!.getAttribute('title')).toContain('0.4.0');
    expect(button()!.textContent).toContain('Restart to update');
  });

  it('STAYS until acted on — no dismiss, which is what the toast got wrong', () => {
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'ready', version: '0.4.0' });

    // Nothing in the control offers a way to make it go away.
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull();
    // ...and further status traffic does not retract it.
    bridge.push({ kind: 'checking' });
    bridge.push({ kind: 'idle' } as UpdateStatus);
    expect(button()).not.toBeNull();
  });

  it('does not duplicate for a version already recorded', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'ready', version: '0.4.0' });
    bridge.push({ kind: 'ready', version: '0.4.0' });
    bridge.push({ kind: 'ready', version: '0.4.0' });

    expect(screen.getAllByRole('button', { name: /Restart to update/i })).toHaveLength(1);
  });

  it('moves to a genuinely newer version', () => {
    const bridge = installBridge();
    render(<Harness />);

    bridge.push({ kind: 'ready', version: '0.4.0' });
    bridge.push({ kind: 'ready', version: '0.4.1' });

    expect(button()!.getAttribute('title')).toContain('0.4.1');
  });

  it('restarts the app, and latches so a second click cannot land', () => {
    const bridge = installBridge();
    render(<Harness />);
    bridge.push({ kind: 'ready', version: '0.4.0' });

    fireEvent.click(button()!);
    expect(bridge.restarts()).toBe(1);

    // `restartAndInstall` tears the window down but not instantly; the button
    // must not stay live during the teardown.
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button()!);
    expect(bridge.restarts()).toBe(1);
  });

  it('catches up on a status that arrived before it mounted', async () => {
    installBridge();
    // A reload lands here: the download finished while the renderer was gone.
    (window as unknown as { motionEditor: { updates: { getStatus: () => Promise<UpdateStatus> } } })
      .motionEditor.updates.getStatus = () => Promise.resolve({ kind: 'ready', version: '0.4.2' });

    render(<Harness />);

    await waitFor(() => expect(button()).not.toBeNull());
    expect(button()!.getAttribute('title')).toContain('0.4.2');
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
    expect(button()).toBeNull();
  });
});
