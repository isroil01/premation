/**
 * Scene is permanent.
 *
 * The viewport holds the GPU context, the playback state and the viewport
 * transform; if it ever unmounts, all three are lost and the user reads it as
 * "the editor lost my view". The assertion is on IDENTITY, not appearance: a
 * remounted Scene looks identical in the DOM and is a different object with a
 * different context.
 *
 * (Until 0.9 this suite drove JavaScript plugins' page tabs through the strip.
 * The plugin system and its tabs are gone; the Scene guarantees are what stay.)
 */

import { useRef } from 'react';
import { render, screen, act } from '@testing-library/react';
import { EditorTabs } from './EditorTabs';

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
