/**
 * Reported (issue #13): "in the properties tab I think values are supposed to
 * be changeable by drag, like AE — it works, but not continuous like AE."
 *
 * It was two separate defects wearing one symptom.
 *
 * 1. The window listeners that drive the drag were torn off MID-GESTURE.
 *    `onPointerMove` / `onPointerUp` are `useCallback`s over `onChange`, `step`,
 *    `min` and `max`, and the cleanup effect listed them as dependencies. The
 *    first committed value re-rendered the parent, which handed the field a
 *    fresh inline `onChange`, which changed the callbacks' identity, which ran
 *    the cleanup. So the drag applied exactly ONE delta and then went dead
 *    until you released and pressed again — a drag that "works but stutters".
 *
 * 2. Pressing a modifier mid-drag re-scaled the WHOLE accumulated travel
 *    instead of changing sensitivity from that point on, so the value
 *    teleported. (The math for that lives in `scrubContinuity.test.ts`; this
 *    file checks it through the real component.)
 *
 * A parent that passes a fresh `onChange` on every render is not a strawman —
 * it is how every inspector row in this app is written.
 */

import { useState } from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { ValueField } from './ValueField';

afterEach(cleanup);

/** A parent shaped like the real inspector rows: new `onChange` every render. */
function Host({ initial = 0, step = 1 }: { initial?: number; step?: number }): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <ValueField
      value={value}
      // Deliberately NOT memoized — a fresh identity on every render is the
      // condition that used to kill the drag.
      onChange={(v) => setValue(v)}
      step={step}
      aria-label="Position X"
    />
  );
}

function field(): HTMLElement {
  return screen.getByRole('spinbutton', { name: 'Position X' });
}

function shown(): number {
  return Number(field().getAttribute('aria-valuenow'));
}

interface Mods { shiftKey?: boolean; altKey?: boolean }

function press(x: number): void {
  act(() => {
    field().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }),
    );
  });
}

function move(x: number, mods: Mods = {}): void {
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1,
        clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        ...mods,
      }),
    );
  });
}

function release(x: number, mods: Mods = {}): void {
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true, button: 0, buttons: 0,
        clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        ...mods,
      }),
    );
  });
}

describe('ValueField scrub survives re-renders', () => {
  it('keeps tracking the pointer across every commit, not just the first', () => {
    render(<Host initial={100} />);
    press(0);
    move(10);                       // +10 → 110, and re-renders the parent
    expect(shown()).toBe(110);
    move(20);                       // this one used to do nothing at all
    expect(shown()).toBe(120);
    move(30);
    expect(shown()).toBe(130);
    move(40);
    release(40);
    expect(shown()).toBe(140);
  });

  it('tracks a long drag without drift', () => {
    render(<Host initial={0} />);
    press(0);
    for (let x = 5; x <= 300; x += 5) move(x);
    release(300);
    expect(shown()).toBe(300);
  });

  it('reverses cleanly', () => {
    render(<Host initial={0} />);
    press(0);
    move(120);
    move(60);
    move(0);
    release(0);
    expect(shown()).toBe(0);
  });

  it('honours a custom step across the whole gesture', () => {
    render(<Host initial={0} step={0.5} />);
    press(0);
    move(20);
    move(40);
    release(40);
    expect(shown()).toBe(20);
  });
});

describe('ValueField modifier changes mid-drag', () => {
  it('does not jump when Shift goes down part-way through', () => {
    render(<Host initial={100} />);
    press(0);
    move(40);
    expect(shown()).toBe(140);

    // Shift down, pointer stationary: the value must not move at all.
    move(40, { shiftKey: true });
    expect(shown()).toBe(140);

    // From here 10× per pixel, measured from 140 — NOT 100 + 45×10.
    move(45, { shiftKey: true });
    release(45, { shiftKey: true });
    expect(shown()).toBe(190);
  });

  it('does not jump when Shift is released part-way through', () => {
    render(<Host initial={0} />);
    press(0);
    move(10, { shiftKey: true });   // +100
    expect(shown()).toBe(100);
    move(10);                       // let go of Shift, no movement
    expect(shown()).toBe(100);
    move(20);                       // +10 at normal gear
    release(20);
    expect(shown()).toBe(110);
  });

  it('switches to the fine gear with Alt without jumping', () => {
    render(<Host initial={0} />);
    press(0);
    move(50);
    expect(shown()).toBe(50);
    move(50, { altKey: true });
    expect(shown()).toBe(50);
    move(60, { altKey: true });     // +10 × 0.1
    release(60, { altKey: true });
    expect(shown()).toBe(51);
  });
});

describe('ValueField click vs drag', () => {
  it('treats a press with no travel as a click and opens the editor', () => {
    render(<Host initial={42} />);
    press(0);
    release(0);
    expect(screen.getByDisplayValue('42')).toBeTruthy();
  });

  it('ignores movement inside the dead zone', () => {
    render(<Host initial={42} />);
    press(0);
    move(2);                        // under the 3px dead zone
    expect(shown()).toBe(42);
    release(2);
    // Still a click: the editor opened rather than the value changing.
    expect(screen.getByDisplayValue('42')).toBeTruthy();
  });
});

describe('ValueField pointer-lock lifecycle', () => {
  it('releases a lock that resolves after the scrub already ended', async () => {
    render(<Host initial={0} />);
    const target = field();
    let resolveLock: (() => void) | undefined;
    Object.defineProperty(target, 'requestPointerLock', {
      configurable: true,
      value: () => new Promise<void>((resolve) => { resolveLock = resolve; }),
    });
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      value: null,
      writable: true,
    });
    const exitPointerLock = jest.fn(() => {
      Object.defineProperty(document, 'pointerLockElement', {
        configurable: true,
        value: null,
        writable: true,
      });
    });
    Object.defineProperty(document, 'exitPointerLock', {
      configurable: true,
      value: exitPointerLock,
    });

    press(0);
    move(10);
    release(10);

    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      value: target,
      writable: true,
    });
    await act(async () => resolveLock?.());

    expect(exitPointerLock).toHaveBeenCalledTimes(1);
    expect(document.pointerLockElement).toBeNull();
  });
});

/**
 * Reported: "if I drag to the right the value should increase, but it goes to
 * minus" — together with "the cursor disappears".
 *
 * Both are the same moment: the instant the drag gets long enough to acquire
 * pointer lock. Chromium delivers ONE enormous `movementX` on that event —
 * the jump from the real cursor to the locked origin, not a hand movement —
 * and it points from the cursor back to the origin, so dragging RIGHT produces
 * a large NEGATIVE spike. The value lurched hundreds of units the wrong way at
 * exactly the moment the cursor vanished, which is why the two were reported
 * as one bug.
 *
 * Clamping the spike (which is what `sanitizeMovement` does) only bounds the
 * damage — a 300-unit jump in the wrong direction is still the reported bug.
 * The acquisition event carries no real travel, so it must be DISCARDED.
 */
describe('ValueField pointer-lock acquisition spike', () => {
  function lockTo(el: Element | null): void {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true, value: el, writable: true,
    });
  }

  /** A move carrying an explicit `movementX`, as a locked pointer does. */
  function moveLocked(clientX: number, movementX: number): void {
    act(() => {
      const e = new PointerEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1,
        clientX, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      });
      Object.defineProperty(e, 'movementX', { configurable: true, value: movementX });
      window.dispatchEvent(e);
    });
  }

  afterEach(() => { lockTo(null); });

  it('discards the acquisition spike instead of scrubbing hundreds of units backwards', async () => {
    render(<Host initial={0} />);
    const target = field();
    lockTo(null);
    Object.defineProperty(target, 'requestPointerLock', {
      configurable: true,
      value: () => Promise.resolve(),
    });

    press(0);
    move(10);                     // crosses the dead zone, requests the lock
    expect(shown()).toBe(10);

    // The browser grants the lock, then delivers the bogus jump. The user is
    // still dragging RIGHT; the spike points left.
    await act(async () => { lockTo(target); });
    moveLocked(10, -500);
    expect(shown()).toBe(10);     // was -290: clamped, but still backwards

    // Real locked movement after the acquisition still counts, at full fidelity.
    moveLocked(10, 20);
    expect(shown()).toBe(30);
    moveLocked(10, 20);
    expect(shown()).toBe(50);
  });

  it('does not double-count the frame the lock is lost (Esc mid-drag)', async () => {
    render(<Host initial={0} />);
    const target = field();
    lockTo(null);
    Object.defineProperty(target, 'requestPointerLock', {
      configurable: true,
      value: () => Promise.resolve(),
    });

    press(0);
    move(10);
    await act(async () => { lockTo(target); });
    moveLocked(10, 0);            // acquisition frame, discarded
    moveLocked(10, 30);
    expect(shown()).toBe(40);

    // Esc drops the lock. `clientX` is meaningless on that frame — it is the
    // frozen coordinate the locked cursor was parked at — so it must not be
    // measured against.
    lockTo(null);
    move(900);
    expect(shown()).toBe(40);

    // Cursor-bound tracking resumes from the new position, no teleport.
    move(910);
    release(910);
    expect(shown()).toBe(50);
  });
});
