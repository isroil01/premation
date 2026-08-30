/**
 * The tracker store's two load-bearing behaviours: it must not leave the
 * viewport armed for a click that will never come, and it must be able to
 * tell a GLOBAL shortcut to stand down.
 *
 * The second one has a source-level guard as well as a unit test, and that
 * deserves an explanation. Escape is bound to `BuiltinCommands.Deselect`
 * through `ShortcutManager`, which listens on window in the CAPTURE phase and
 * is registered at app boot — so a listener mounted later by the Track Motion
 * panel cannot win the chord, with or without `stopImmediatePropagation`. The
 * only supported way for a transient mode to take a bound chord is for the
 * competing command to report itself DISABLED, which lets the event fall
 * through. That coupling lives in a closure inside a 900-line provider file
 * and is invisible from here; deleting it does not fail a type check, does not
 * fail a render test, and reappears as "Escape closes the tracker panel",
 * which reads like a layout bug rather than a shortcut one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPickArmed, useTrackerStore } from './trackerStore';

beforeEach(() => {
  useTrackerStore.getState().clear();
});

describe('isPickArmed', () => {
  it('is false when the tracker is idle', () => {
    expect(isPickArmed()).toBe(false);
  });

  it('is true only while waiting for the viewport click', () => {
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    expect(isPickArmed()).toBe(true);

    useTrackerStore.getState().setAutoPhase('analyzing');
    expect(isPickArmed()).toBe(false);
  });

  it('goes false when the pick turns into a run', () => {
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    useTrackerStore.getState().finishTracking(null, 'done');
    expect(isPickArmed()).toBe(false);
  });

  it('goes false when the panel closes mid-pick', () => {
    // Closing the section unmounts the overlay; an armed phase left behind
    // would keep a global chord suppressed with nothing on screen to explain
    // why Escape had stopped deselecting.
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    useTrackerStore.getState().disarm();
    expect(isPickArmed()).toBe(false);
  });

  it('goes false when the tracker moves to another layer', () => {
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    useTrackerStore.getState().activate('video_2');
    expect(isPickArmed()).toBe(false);
  });
});

describe('the Escape/Deselect stand-down', () => {
  it('is wired into the Deselect command, which is where Escape is decided', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/Providers.tsx'), 'utf8');
    const start = src.indexOf('BuiltinCommands.Deselect');
    expect(start).toBeGreaterThan(-1);
    // The binding runs from the id to its `execute` — `enabled` sits between.
    const binding = src.slice(start, src.indexOf('execute:', start));
    expect(binding).toContain("shortcut: { key: 'Escape' }");
    expect(binding).toContain('isPickArmed()');
  });
});
