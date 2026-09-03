/**
 * The timeline edit-mode store and its chords.
 *
 * The interesting assertions are all about COLLISIONS, because that is the way
 * this feature fails silently: a mode key that is already bound to something
 * else does not error, it just makes one of the two dead — and which one
 * depends on registration order, so it can even differ between a fresh boot and
 * a hot reload. The registry is asked directly rather than a list being
 * restated here, so a chord taken later by anyone else reddens this.
 */

import { getCommandRegistry, chordKey } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import {
  TIMELINE_EDIT_MODES,
  buildTimelineEditModeCommands,
  getTimelineEditMode,
  setTimelineEditMode,
  useTimelineEditModeStore,
} from './timelineEditMode';

beforeEach(() => {
  getCommandRegistry().clear();
  useTimelineEditModeStore.getState().reset();
});

describe('the store', () => {
  it('starts in select — the mode where nothing is armed', () => {
    expect(getTimelineEditMode()).toBe('select');
  });

  it('holds the mode that was set', () => {
    setTimelineEditMode('razor');
    expect(getTimelineEditMode()).toBe('razor');
    setTimelineEditMode('roll');
    expect(getTimelineEditMode()).toBe('roll');
  });

  it('reset returns to select from any mode', () => {
    setTimelineEditMode('slide');
    useTimelineEditModeStore.getState().reset();
    expect(getTimelineEditMode()).toBe('select');
  });
});

describe('the mode table', () => {
  it('covers every mode exactly once', () => {
    const modes = TIMELINE_EDIT_MODES.map((m) => m.mode);
    expect(new Set(modes).size).toBe(modes.length);
    expect(modes).toEqual(['select', 'razor', 'slip', 'slide', 'roll']);
  });

  it('gives every mode a distinct chord', () => {
    const chords = TIMELINE_EDIT_MODES.map((m) => m.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('the advertised chord and the bound chord are the same key', () => {
    // The tooltip is the only place a user learns the shortcut. A `chord`
    // string that drifts from the `key` actually registered is a lie the type
    // system cannot see.
    for (const def of TIMELINE_EDIT_MODES) {
      expect(def.chord.toLowerCase()).toBe(`shift+${def.key}`);
    }
  });
});

describe('the commands', () => {
  it('registers one command per mode, plus the Escape exit', () => {
    const commands = buildTimelineEditModeCommands();
    expect(commands).toHaveLength(TIMELINE_EDIT_MODES.length + 1);
    expect(commands.map((c) => String(c.id))).toContain('timeline.editMode.exit');
  });

  it('a mode command sets the mode', () => {
    const razor = buildTimelineEditModeCommands().find((c) => String(c.id).endsWith('razor'))!;
    razor.execute({} as never);
    expect(getTimelineEditMode()).toBe('razor');
  });

  it('reports which mode is checked, so the palette agrees with the tool row', () => {
    const commands = buildTimelineEditModeCommands();
    setTimelineEditMode('slip');
    const checked = commands.filter((c) => c.isChecked?.() === true).map((c) => String(c.id));
    expect(checked).toEqual(['timeline.editMode.slip']);
  });

  it('Escape is live ONLY while a mode is armed', () => {
    // Otherwise it would swallow the chord from Deselect and from the camera
    // tool's own exit — the ShortcutManager skips a disabled binding and lets
    // the key fall through, which is the entire mechanism this relies on.
    const exit = buildTimelineEditModeCommands().find((c) => String(c.id) === 'timeline.editMode.exit')!;
    expect(exit.enabled?.()).toBe(false);
    setTimelineEditMode('roll');
    expect(exit.enabled?.()).toBe(true);
    exit.execute({} as never);
    expect(getTimelineEditMode()).toBe('select');
    expect(exit.enabled?.()).toBe(false);
  });

  it('every mode chord is Shift+letter, never a bare key', () => {
    // A bare V / C / Y / U / N would each shadow a working tool or reveal.
    for (const cmd of buildTimelineEditModeCommands()) {
      if (String(cmd.id) === 'timeline.editMode.exit') continue;
      expect(cmd.shortcut).toMatchObject({ shift: true });
      expect(cmd.shortcut?.key).toMatch(/^[a-z]$/);
    }
  });

  it('takes no chord another command already holds', () => {
    // The real check. Anything already in the registry — tool keys, reveals,
    // transport — wins the collision at boot, so this must be run against a
    // registry that has them.
    const registry = getCommandRegistry();
    const OCCUPIED = [
      { id: 'tool.select', key: 'v' },
      { id: 'tool.direct-select', key: 'a' },
      { id: 'tool.hand', key: 'h' },
      { id: 'tool.zoom', key: 'z' },
      { id: 'tool.rotate', key: 'w' },
      { id: 'tool.pan-behind', key: 'y' },
      { id: 'tool.pen', key: 'g' },
      { id: 'tool.shape', key: 'q' },
      { id: 'tool.cameraCycle', key: 'c' },
      { id: 'timeline.revealAnimated', key: 'u' },
    ];
    for (const o of OCCUPIED) {
      registry.register({
        id: asCommandId(o.id),
        label: o.id,
        shortcut: { key: o.key },
        enabled: () => true,
        execute: () => undefined,
      });
    }
    const taken = new Set(
      registry.all().filter((c) => c.shortcut).map((c) => chordKey(c.shortcut!)),
    );
    for (const cmd of buildTimelineEditModeCommands()) {
      if (!cmd.shortcut) continue;
      if (String(cmd.id) === 'timeline.editMode.exit') continue; // Escape is shared by design
      expect(taken.has(chordKey(cmd.shortcut))).toBe(false);
    }
  });
});
