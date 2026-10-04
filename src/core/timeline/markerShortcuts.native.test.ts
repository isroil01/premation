/**
 * Comp markers on the number keys.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is THE PLAYHEAD MOVING when a number chord is pressed. It is
 * produced by a chain of four units that each already had guards:
 * `chordFromEvent` → `chordKey` match in `ShortcutManager` → the command
 * registry → the playhead seek (`timelineView`). Every one of them can be correct while
 * the chord still does nothing, so the medium has to be a real `keydown` on
 * `window` — that is the only place the crossing is observable (F30).
 *
 * The unit tests below exist too, but the seam test is the one that would have
 * caught the bug this feature nearly shipped with.
 *
 * ## The bug this nearly shipped with
 *
 * `chordFromEvent` read `e.key` raw. For Shift+1 on a US layout `e.key` is
 * `'!'`, so a binding registered as `{ key: '1', shift: true }` could never
 * match — nine commands would have appeared in the palette, appeared in
 * Customize, and silently never fired from the keyboard. Nothing would have gone
 * red: every unit was correct.
 *
 * ## What the clean fixture would exclude
 *
 * Markers are created OUT OF TIME ORDER on purpose. Creating them 30 → 60 → 90
 * makes creation order and time order identical, so a `goToMarkerIndex` that
 * never sorted would pass every assertion. The fixture creates 90 → 30 → 60.
 */

import { playheadSeconds, seekPlayhead } from './timelineView';
import { buildStaticCommands } from '@providers/Providers';
import { getCommandRegistry, chordKey } from '@core/commands/Command';
import { CommandSystem, setCommandSystem, chordFromEvent } from '@core/commands/CommandSystem';
import { ShortcutManager, setShortcutManager } from '@core/commands/ShortcutManager';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';

/** Deliberately NOT ascending — see the header. */
const MARKER_FRAMES = [90, 30, 60];

let shortcuts: ShortcutManager;

afterEach(() => {
  shortcuts?.detach();
});

/** Register the real commands and attach a real ShortcutManager over them. */
function wireShortcuts(): void {
  // The registry is a singleton with no public constructor, so it is cleared
  // rather than replaced — which is also what `Application.boot` does.
  getCommandRegistry().clear();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  for (const cmd of buildStaticCommands()) getCommandRegistry().register(cmd);
  shortcuts = new ShortcutManager();
  setShortcutManager(shortcuts);
  shortcuts.rehydrateFromRegistry();
}

// ── The chord layer ────────────────────────────────────────────────

describe('chordFromEvent resolves the digit row from e.code', () => {
  const ev = (init: Partial<KeyboardEventInit> & { key: string; code?: string }): KeyboardEvent =>
    new KeyboardEvent('keydown', { bubbles: true, ...init } as KeyboardEventInit);

  it('POSITIVE CONTROL: Shift+1 really does report "!" as e.key', async () => {
    // The whole reason the fix exists. If a browser/jsdom ever normalised this
    // itself, the fix would be dead code and this file should say so.
    expect(ev({ key: '!', code: 'Digit1', shiftKey: true }).key).toBe('!');
  });

  it('maps Shift+1 to the chord {key:"1", shift:true}', async () => {
    const c = chordFromEvent(ev({ key: '!', code: 'Digit1', shiftKey: true }));
    expect({ key: c.key, shift: c.shift }).toEqual({ key: '1', shift: true });
  });

  it('leaves a BARE digit alone — the existing 1/2 bindings must not move', async () => {
    // `view.activeCamera` is on bare `1`. A normalisation that changed this
    // would silently re-bind 3D view switching.
    expect(chordFromEvent(ev({ key: '1', code: 'Digit1' })).key).toBe('1');
  });

  it('leaves non-digit keys alone', async () => {
    // Scoped to Digit*, deliberately — remapping letters to physical codes
    // would change every existing chord on a non-US layout.
    expect(chordFromEvent(ev({ key: 'A', code: 'KeyA', shiftKey: true })).key).toBe('A');
    expect(chordFromEvent(ev({ key: '[', code: 'BracketLeft' })).key).toBe('[');
  });

  it('resolves a non-US layout where the bare digit key produces a symbol', async () => {
    // AZERTY: bare Digit1 gives '&'. Before this, the shipped `1` binding for
    // 3D view switching did not fire on that layout at all.
    expect(chordFromEvent(ev({ key: '&', code: 'Digit1' })).key).toBe('1');
  });
});

// The ordering itself (1-based, by TIME, not creation) is the crossing below:
// Shift+3 lands on the third marker in time, not the third one created.

// ── The registry layer ─────────────────────────────────────────────

describe('the nine commands are registered', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `timeline.goToMarker${i + 1}`);

  it('POSITIVE CONTROL: buildStaticCommands returns a real command set', async () => {
    expect(buildStaticCommands().length).toBeGreaterThan(20);
  });

  it('all nine exist, so each appears in the palette and in Customize', async () => {
    const registered = new Set(buildStaticCommands().map((c) => String(c.id)));
    expect(ids.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('each carries the Shift+digit chord matching its own index', async () => {
    // Anchored to the INDEX IN THE ID, not to the order of the array — a
    // generator that emitted nine copies of marker 1 would pass a length check.
    const byId = new Map(buildStaticCommands().map((c) => [String(c.id), c]));
    const wrong = ids.filter((id) => {
      const n = id.replace('timeline.goToMarker', '');
      const s = byId.get(id)?.shortcut;
      return !s || s.key !== n || s.shift !== true;
    });
    expect(wrong).toEqual([]);
  });

  it('no chord is claimed by two ALWAYS-ENABLED commands', async () => {
    // The general guard, not just for these nine.
    //
    // Sharing a chord is legal here and used deliberately: `ShortcutManager`
    // skips a binding whose command is disabled, so `Escape` is a fallthrough
    // chain — `tool.cameraExit` (enabled only while a camera tool is active)
    // sits in front of `edit.deselect`. A guard that banned all sharing would
    // have flagged that, and the first version of this test did.
    //
    // What is actually broken is two UNCONDITIONAL commands on one chord: the
    // second can never run, and nothing reports it. "Unconditional" is read off
    // the predicate rather than listed, so a new always-on command is covered
    // the moment it exists.
    const alwaysOn = (c: { enabled?: () => boolean }): boolean =>
      !c.enabled || /\(\)=>true/.test(String(c.enabled).replace(/\s/g, ''));

    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const c of buildStaticCommands()) {
      if (!c.shortcut || !alwaysOn(c)) continue;
      const k = chordKey(c.shortcut);
      const prev = seen.get(k);
      if (prev) clashes.push(`${k}: ${prev} vs ${String(c.id)}`);
      else seen.set(k, String(c.id));
    }
    expect(clashes).toEqual([]);
  });

  it('POSITIVE CONTROL: the always-on detector actually classifies both ways', async () => {
    // Otherwise the check above passes by classifying every command as
    // conditional and comparing nothing.
    const alwaysOn = (c: { enabled?: () => boolean }): boolean =>
      !c.enabled || /\(\)=>true/.test(String(c.enabled).replace(/\s/g, ''));
    const cmds = buildStaticCommands().filter((c) => c.shortcut);
    const on = cmds.filter(alwaysOn).length;
    expect({ someAlwaysOn: on > 0, someConditional: cmds.length - on > 0 })
      .toEqual({ someAlwaysOn: true, someConditional: true });
  });

  it('and the bare digits still belong to 3D view switching', async () => {
    // Stated positively so a future change that DOES take them fails here with
    // a reason, rather than silently.
    const byChord = new Map(
      buildStaticCommands().filter((c) => c.shortcut).map((c) => [chordKey(c.shortcut!), String(c.id)]),
    );
    expect(byChord.get('1')).toBe('view.activeCamera');
    expect(byChord.get('2')).toBe('view.lastCustom');
  });
});

// ── The crossing (F30) ─────────────────────────────────────────────

describe('a real Shift+digit keydown moves the playhead', () => {
  // The playhead is the clock store (block 3: timelineView, not the TypeScript TimelineController).
  // The commands' `enabled` counts the active composition's markers in the
  // document MIRROR (B4), so these markers are made through the app's engine
  // (still out of time order) and have landed in the mirror before the key.
  let h: (Harness) | null = null;
  const addMarkersOutOfOrder = async (): Promise<void> => {
    h = await setupAppEngine();
    const comp = documentMirror().compIds[0] ?? 'comp_root';
    for (const f of MARKER_FRAMES) {
      await h.run({ type: 'addMarkers', markers: [{ owner: { comp }, time: sec(f / 30), duration: 0, name: `M${f}`, comment: '', label: 0 }] });
    }
    await engineIdle();
    await documentMirror().whenIdle();
    seekPlayhead(0 / 30);
  };
  afterEach(async () => {
    await h?.dispose();
    h = null;
  });

  it('Shift+1 seeks the first marker — the whole chain, end to end', async () => {
    await addMarkersOutOfOrder();
    wireShortcuts();
    seekPlayhead(0 / 30);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '!', code: 'Digit1', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(Math.round(playheadSeconds() * 30)).toBe(30);
  });

  it('Shift+3 seeks the third marker, not the third one created', async () => {
    // Creation order was 90, 30, 60 — so a chain that skipped the sort lands on
    // 60 here and this is the assertion that says so.
    await addMarkersOutOfOrder();
    wireShortcuts();
    seekPlayhead(0 / 30);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '#', code: 'Digit3', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(Math.round(playheadSeconds() * 30)).toBe(90);
  });

  it('Shift+5 with three markers does nothing — the command disables itself', async () => {
    await addMarkersOutOfOrder();
    wireShortcuts();
    seekPlayhead(45 / 30);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '%', code: 'Digit5', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(Math.round(playheadSeconds() * 30)).toBe(45);
  });

  it('a BARE 1 does not seek a marker — it still belongs to the 3D view', async () => {
    // The collision check, at the layer where a collision would actually bite.
    await addMarkersOutOfOrder();
    wireShortcuts();
    seekPlayhead(45 / 30);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '1', code: 'Digit1', bubbles: true, cancelable: true,
    }));

    expect(Math.round(playheadSeconds() * 30)).toBe(45);
  });
});
