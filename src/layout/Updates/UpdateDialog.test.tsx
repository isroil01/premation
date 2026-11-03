/**
 * Help ▸ Check for Updates…'s dialog, driven through a fake preload bridge:
 * every answer the shell can give lands as something the user can read and
 * act on, and a found update is followed through to Restart now.
 */

import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { UpdateDialog } from './UpdateDialog';
import { useUpdateStore } from '@stores/updateStore';
import type { InteractiveCheckResult, UpdateStatus } from '@app-types/motionEditor';

function installBridge(answers: InteractiveCheckResult[]): {
  push: (s: UpdateStatus) => void;
  checks: () => number;
  restarts: () => number;
} {
  const listeners = new Set<(s: UpdateStatus) => void>();
  let checks = 0;
  let restarts = 0;
  (window as unknown as { motionEditor: unknown }).motionEditor = {
    updates: {
      onStatus: (h: (s: UpdateStatus) => void) => {
        listeners.add(h);
        return () => listeners.delete(h);
      },
      checkInteractive: () => {
        const answer = answers[Math.min(checks, answers.length - 1)]!;
        checks += 1;
        return Promise.resolve(answer);
      },
      restartAndInstall: () => {
        restarts += 1;
        return Promise.resolve();
      },
    },
  };
  return {
    push: (s) => act(() => listeners.forEach((l) => l(s))),
    checks: () => checks,
    restarts: () => restarts,
  };
}

async function openDialog(): Promise<void> {
  render(<UpdateDialog />);
  await act(async () => {
    useUpdateStore.getState().setDialogOpen(true);
  });
}

beforeEach(() => {
  useUpdateStore.setState({ readyVersion: null, restarting: false, dialogOpen: false });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('UpdateDialog', () => {
  it('renders nothing until the menu opens it', () => {
    installBridge([{ kind: 'upToDate', version: '1.0.4' }]);
    render(<UpdateDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when this is the newest version, and OK closes it', async () => {
    installBridge([{ kind: 'upToDate', version: '1.0.4' }]);
    await openDialog();
    expect(await screen.findByText("You're up to date")).toBeTruthy();
    expect(screen.getByText('Premation 1.0.4 is the newest version.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it('follows a found update through its download to Restart now', async () => {
    const bridge = installBridge([{ kind: 'found', version: '1.0.5' }]);
    await openDialog();
    expect(await screen.findByText('Downloading Premation 1.0.5')).toBeTruthy();

    bridge.push({ kind: 'downloading', version: '1.0.5', percent: 42 });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');

    bridge.push({ kind: 'ready', version: '1.0.5' });
    expect(screen.getByText('Premation 1.0.5 is ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(bridge.restarts()).toBe(1);
    expect(useUpdateStore.getState().restarting).toBe(true);
  });

  it('shows a failure with its reason, and Try again checks again', async () => {
    const bridge = installBridge([
      { kind: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' },
      { kind: 'upToDate', version: '1.0.4' },
    ]);
    await openDialog();
    expect(await screen.findByText("Couldn't check for updates")).toBeTruthy();
    expect(screen.getByText('net::ERR_INTERNET_DISCONNECTED')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(bridge.checks()).toBe(2);
    expect(await screen.findByText("You're up to date")).toBeTruthy();
  });

  it('turns a download error into the failure state', async () => {
    const bridge = installBridge([{ kind: 'found', version: '1.0.5' }]);
    await openDialog();
    await screen.findByText('Downloading Premation 1.0.5');
    bridge.push({ kind: 'error', message: 'sha512 checksum mismatch' });
    expect(screen.getByText("Couldn't check for updates")).toBeTruthy();
    expect(screen.getByText('sha512 checksum mismatch')).toBeTruthy();
  });
});
