/**
 * Plugin Developer Mode on the page (W2): the card saves the switch and the folders through main,
 * says the engine is restarting when its plugin folders change, and is absent outside the desktop
 * app; a rebuild main reports is reloaded in the engine with a toast either way.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '@stores/uiStore';
import { followDevRebuilds } from '@core/nativePlugins/pluginDev';
import { PluginDevModeCard } from './PluginDevMode';

type Settings = { enabled: boolean; folders: string[] };
type Win = { motionEditor?: { plugins?: Record<string, unknown> } };

function installBridge(initial: Settings): { saved: Settings[]; emit: (id: string) => void } {
  let current = initial;
  const saved: Settings[] = [];
  let handler: ((id: string) => void) | null = null;
  (window as unknown as Win).motionEditor = {
    plugins: {
      devSettings: async () => current,
      setDevSettings: async (s: Settings) => {
        saved.push(s);
        current = s;
        return s;
      },
      pickDevFolder: async () => 'C:\\dev\\glow\\build\\plugins',
      onDevChanged: (h: (id: string) => void) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    },
  };
  return { saved, emit: (id) => handler?.(id) };
}

afterEach(() => {
  delete (window as unknown as Win).motionEditor;
});

it('turns Developer Mode on, adds and removes a folder, and says the engine restarts', async () => {
  const b = installBridge({ enabled: false, folders: [] });
  render(<PluginDevModeCard />);
  const toggle = await screen.findByRole('switch', { name: 'Reload plugins when they are rebuilt' });
  await act(async () => {
    fireEvent.click(toggle);
  });
  expect(b.saved.at(-1)).toEqual({ enabled: true, folders: [] });
  expect(screen.getByRole('status')).toHaveTextContent('restarting');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
  });
  expect(b.saved.at(-1)).toEqual({ enabled: true, folders: ['C:\\dev\\glow\\build\\plugins'] });
  expect(screen.getByText('C:\\dev\\glow\\build\\plugins')).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder' }));
  });
  expect(b.saved.at(-1)).toEqual({ enabled: true, folders: [] });
});

it('is not shown outside the desktop app', () => {
  const { container } = render(<PluginDevModeCard />);
  expect(container).toBeEmptyDOMElement();
});

it('reloads a rebuilt plugin and reports both outcomes', async () => {
  const b = installBridge({ enabled: true, folders: [] });
  const calls: unknown[] = [];
  let fail = false;
  const client = {
    execute: async (cmd: unknown) => {
      calls.push(cmd);
      return fail
        ? { ok: false as const, error: { code: 'internal' as const, message: "plugin 'com.you.glow' was not reloaded: LoadLibrary failed" } }
        : { ok: true as const, value: { plugins: [{ id: 'com.you.glow', name: 'Glow' }] } };
    },
    query: async () => ({ ok: true as const, value: { plugins: [], effects: [], commands: [] } }),
  };
  const notices: { level: string; message: string; detail?: string }[] = [];
  const off = followDevRebuilds(() => client as never, (n) => notices.push(n));
  await act(async () => {
    b.emit('com.you.glow');
  });
  expect(calls).toEqual([{ type: 'reloadPlugin', plugin: 'com.you.glow' }]);
  expect(notices.at(-1)).toEqual({ level: 'success', message: 'Reloaded Glow' });
  fail = true;
  await act(async () => {
    b.emit('com.you.glow');
  });
  expect(notices.at(-1)).toEqual(expect.objectContaining({ level: 'error', message: 'Kept the previous build of com.you.glow' }));
  expect(notices.at(-1)?.detail).toMatch(/LoadLibrary failed/);
  off();
  expect(useUIStore.getState().notifications).toBeDefined();
});
