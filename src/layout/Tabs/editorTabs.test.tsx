/**
 * Scene is permanent.
 *
 * The viewport holds the GPU context, the playback state and the viewport
 * transform; if it ever unmounts, all three are lost and the user reads it as
 * "the editor lost my view". The assertion is on IDENTITY, not appearance: a
 * remounted Scene looks identical in the DOM and is a different object with a
 * different context.
 *
 * Native plugins' pages (2026-11) are closable tabs of the strip again; the
 * last suite drives them and checks the Scene guarantees hold around them.
 */

import { useRef } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { usePluginPageStore } from '@stores/pluginPageStore';
import { EditorTabs } from './EditorTabs';

// The page itself has its own suite; here it only has to say which plugin it is.
jest.mock('@layout/Plugins/PluginDetailPage', () => ({
  __esModule: true,
  default: ({ id, name }: { id: string; name: string }) => <div data-testid="plugin-page">{`${name} (${id})`}</div>,
}));

let mountCount = 0;
let liveContext: object | null = null;

/** A stand-in viewport that records its own lifecycle (the context lives in a ref, per instance). */
function FakeScene(): JSX.Element {
  const ref = useRef<object | null>(null);
  if (ref.current === null) {
    mountCount += 1;
    ref.current = { id: mountCount };
    liveContext = ref.current;
  }
  return <canvas data-testid="fake-canvas" />;
}

beforeEach(() => {
  mountCount = 0;
  liveContext = null;
  usePluginPageStore.setState({ pages: [], active: null });
});

describe('Scene is permanent', () => {
  it('is mounted once, visible, and survives a re-render with its context intact', () => {
    const { rerender } = render(<EditorTabs scene={<FakeScene />} />);
    const before = liveContext;
    rerender(<EditorTabs scene={<FakeScene />} />);
    expect(screen.getByTestId('fake-canvas')).toBeTruthy();
    expect(screen.getByTestId('scene-pane').getAttribute('aria-hidden')).toBe('false');
    expect(liveContext).toBe(before);
    expect(mountCount).toBe(1);
  });

  it('gives Scene a tab that has no close control', () => {
    render(<EditorTabs scene={<FakeScene />} />);
    expect(screen.queryByLabelText('Close Scene')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Close / })).toBeNull();
  });

  it('Ctrl/Cmd+W never falls through to closing the window', () => {
    render(<EditorTabs scene={<FakeScene />} />);
    const ctrl = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true });
    const cmd = new KeyboardEvent('keydown', { key: 'W', metaKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ctrl);
      window.dispatchEvent(cmd);
    });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(cmd.defaultPrevented).toBe(true);
    expect(mountCount).toBe(1);
  });

  it('leaves a plain W alone', () => {
    render(<EditorTabs scene={<FakeScene />} />);
    const plain = new KeyboardEvent('keydown', { key: 'w', cancelable: true });
    act(() => { window.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
  });
});

describe('plugin pages', () => {
  it('open as closable "Plugin: <name>" tabs over a Scene that stays mounted', async () => {
    render(<EditorTabs scene={<FakeScene />} />);
    act(() => { usePluginPageStore.getState().open({ id: 'premation.deepglow', name: 'Deep Glow' }); });
    const tab = screen.getByRole('tab', { name: /Plugin: Deep Glow/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('plugin-page')).toHaveTextContent('Deep Glow (premation.deepglow)');
    expect(screen.getByTestId('scene-pane').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('tab', { name: /^Composition/ })).toHaveAttribute('aria-selected', 'false');

    // Back to the composition: the page's tab stays, the same Scene shows.
    fireEvent.click(screen.getByRole('tab', { name: /^Composition/ }));
    expect(screen.getByTestId('scene-pane').getAttribute('aria-hidden')).toBe('false');
    expect(screen.queryByTestId('plugin-page')).toBeNull();
    fireEvent.click(tab);
    expect(await screen.findByTestId('plugin-page')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close the Deep Glow page' }));
    expect(screen.queryByRole('tab', { name: /Plugin: Deep Glow/ })).toBeNull();
    expect(screen.getByTestId('scene-pane').getAttribute('aria-hidden')).toBe('false');
    expect(mountCount).toBe(1);
  });

  it('reuses one tab per plugin', () => {
    render(<EditorTabs scene={<FakeScene />} />);
    act(() => {
      usePluginPageStore.getState().open({ id: 'a', name: 'Alpha' });
      usePluginPageStore.getState().open({ id: 'b', name: 'Beta' });
      usePluginPageStore.getState().open({ id: 'a', name: 'Alpha' });
    });
    expect(screen.getAllByRole('tab', { name: /^Plugin: / })).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Plugin: Alpha/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('Ctrl/Cmd+W closes the page in front, never the window', () => {
    render(<EditorTabs scene={<FakeScene />} />);
    act(() => { usePluginPageStore.getState().open({ id: 'a', name: 'Alpha' }); });
    const ctrl = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true });
    act(() => { window.dispatchEvent(ctrl); });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(usePluginPageStore.getState().pages).toEqual([]);
    expect(mountCount).toBe(1);
  });
});
