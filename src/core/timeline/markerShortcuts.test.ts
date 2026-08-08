/**
 * Comp markers on the number keys.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is THE PLAYHEAD MOVING when a number chord is pressed. It is
 * produced by a chain of four units that each already had guards:
 * `chordFromEvent` → `chordKey` match in `ShortcutManager` → the command
 * registry → `TimelineController.seek`. Every one of them can be correct while
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

import { getTimelineController } from './TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { buildStaticCommands } from '@providers/Providers';
import { getCommandRegistry, chordKey } from '@core/commands/Command';
import { CommandSystem, setCommandSystem, chordFromEvent } from '@core/commands/CommandSystem';
import { ShortcutManager, setShortcutManager } from '@core/commands/ShortcutManager';
import type { SceneNode } from '@core/types';

const NODE = 'mk_rect';
/** Deliberately NOT ascending — see the header. */
const MARKER_FRAMES = [90, 30, 60];

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

let shortcuts: ShortcutManager;

beforeEach(() => {
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', {
    id: NODE, name: NODE, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${NODE}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
    ],
  } as never);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  const c = getTimelineController();
  c.syncFromScene('comp_root');
  // The controller is a module singleton and `syncFromScene` does NOT clear
  // comp markers, so without this they accumulate across tests and "the 2nd
  // marker" becomes whichever one a previous test happened to leave behind.
  // Found by this suite: `marker 1` passed while `marker 2` and the count did
  // not, which is the signature of a leaking fixture rather than a broken sort.
  for (const m of c.getMarkers()) c.removeMarker(m.id);
});

afterEach(() => {
  shortcuts?.detach();
});

function addMarkersOutOfOrder(): void {
  const c = getTimelineController();
  for (const f of MARKER_FRAMES) {
    c.timeline.seek(f);
    c.addMarkerAtPlayhead(`M${f}`);
  }
  c.timeline.seek(0);
}

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

  it('POSITIVE CONTROL: Shift+1 really does report "!" as e.key', () => {
    // The whole reason the fix exists. If a browser/jsdom ever normalised this
    // itself, the fix would be dead code and this file should say so.
    expect(ev({ key: '!', code: 'Digit1', shiftKey: true }).key).toBe('!');
  });

  it('maps Shift+1 to the chord {key:"1", shift:true}', () => {
    const c = chordFromEvent(ev({ key: '!', code: 'Digit1', shiftKey: true }));
    expect({ key: c.key, shift: c.shift }).toEqual({ key: '1', shift: true });
  });

  it('leaves a BARE digit alone — the existing 1/2 bindings must not move', () => {
    // `view.activeCamera` is on bare `1`. A normalisation that changed this
    // would silently re-bind 3D view switching.
    expect(chordFromEvent(ev({ key: '1', code: 'Digit1' })).key).toBe('1');
  });

  it('leaves non-digit keys alone', () => {
    // Scoped to Digit*, deliberately — remapping letters to physical codes
    // would change every existing chord on a non-US layout.
    expect(chordFromEvent(ev({ key: 'A', code: 'KeyA', shiftKey: true })).key).toBe('A');
    expect(chordFromEvent(ev({ key: '[', code: 'BracketLeft' })).key).toBe('[');
  });

  it('resolves a non-US layout where the bare digit key produces a symbol', () => {
    // AZERTY: bare Digit1 gives '&'. Before this, the shipped `1` binding for
    // 3D view switching did not fire on that layout at all.
    expect(chordFromEvent(ev({ key: '&', code: 'Digit1' })).key).toBe('1');
  });
});

// ── The controller layer ───────────────────────────────────────────

describe('goToMarkerIndex is 1-based and ordered by TIME', () => {
  it('POSITIVE CONTROL: the fixture is not already in time order', () => {
    // Without this the ordering assertions below would hold for an
    // implementation that never sorted.
    const ascending = [...MARKER_FRAMES].sort((a, b) => a - b);
    expect(MARKER_FRAMES).not.toEqual(ascending);
  });

  /**
   * WHERE THE ORDERING INVARIANT ACTUALLY LIVES, and which guard sees it.
   *
   * `goToMarkerIndex` does not sort — `MarkerList` is ordered by construction
   * (`insertSorted` on add). So deleting a sort from the controller changes
   * nothing and these assertions stay green, which was measured, not assumed:
   * an earlier draft DID sort defensively, and removing that sort failed
   * nothing at all. That is the tell that the guard was watching the wrong unit.
   *
   * These assertions are still the right guard for the CROSSING (F30): they
   * hold only if the collection's order survives into the controller. Breaking
   * `MarkerList.add` to append instead of insert turns them red — verified.
   */
  it('the order comes from MarkerList, and the collection is the one that owns it', () => {
    const c = getTimelineController();
    addMarkersOutOfOrder();
    // Read the collection directly: it is already ascending despite the
    // creation order, so the controller has nothing left to sort.
    const frames = c.timeline.markers.list().map((m) => m.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(frames).toEqual([30, 60, 90]);
  });

  it.each([[1, 30], [2, 60], [3, 90]])('marker %i seeks to frame %i', (n, frame) => {
    addMarkersOutOfOrder();
    const c = getTimelineController();
    expect(c.goToMarkerIndex(n)).toBe(true);
    expect(Math.round(c.timeline.currentFrame)).toBe(frame);
  });

  it('returns false and does NOT move for an index past the end', () => {
    // Pressing 5 with three markers must do nothing — seeking to 0 would be a
    // destructive surprise mid-edit.
    addMarkersOutOfOrder();
    const c = getTimelineController();
    c.timeline.seek(45);
    expect(c.goToMarkerIndex(5)).toBe(false);
    expect(Math.round(c.timeline.currentFrame)).toBe(45);
  });

  it('returns false with no markers at all, without seeking', () => {
    const c = getTimelineController();
    c.timeline.seek(45);
    expect(c.goToMarkerIndex(1)).toBe(false);
    expect(Math.round(c.timeline.currentFrame)).toBe(45);
  });

  it.each([0, -1, 1.5])('rejects the non-index %p', (n) => {
    addMarkersOutOfOrder();
    expect(getTimelineController().goToMarkerIndex(n)).toBe(false);
  });

  it('counts comp markers', () => {
    addMarkersOutOfOrder();
    expect(getTimelineController().compMarkerCount()).toBe(MARKER_FRAMES.length);
  });
});

// ── The registry layer ─────────────────────────────────────────────

describe('the nine commands are registered', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `timeline.goToMarker${i + 1}`);

  it('POSITIVE CONTROL: buildStaticCommands returns a real command set', () => {
    expect(buildStaticCommands().length).toBeGreaterThan(20);
  });

  it('all nine exist, so each appears in the palette and in Customize', () => {
    const registered = new Set(buildStaticCommands().map((c) => String(c.id)));
    expect(ids.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('each carries the Shift+digit chord matching its own index', () => {
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

  it('no chord is claimed by two ALWAYS-ENABLED commands', () => {
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

  it('POSITIVE CONTROL: the always-on detector actually classifies both ways', () => {
    // Otherwise the check above passes by classifying every command as
    // conditional and comparing nothing.
    const alwaysOn = (c: { enabled?: () => boolean }): boolean =>
      !c.enabled || /\(\)=>true/.test(String(c.enabled).replace(/\s/g, ''));
    const cmds = buildStaticCommands().filter((c) => c.shortcut);
    const on = cmds.filter(alwaysOn).length;
    expect({ someAlwaysOn: on > 0, someConditional: cmds.length - on > 0 })
      .toEqual({ someAlwaysOn: true, someConditional: true });
  });

  it('and the bare digits still belong to 3D view switching', () => {
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
  it('Shift+1 seeks the first marker — the whole chain, end to end', () => {
    addMarkersOutOfOrder();
    wireShortcuts();
    const c = getTimelineController();
    c.timeline.seek(0);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '!', code: 'Digit1', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(Math.round(c.timeline.currentFrame)).toBe(30);
  });

  it('Shift+3 seeks the third marker, not the third one created', () => {
    // Creation order was 90, 30, 60 — so a chain that skipped the sort lands on
    // 60 here and this is the assertion that says so.
    addMarkersOutOfOrder();
    wireShortcuts();
    const c = getTimelineController();
    c.timeline.seek(0);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '#', code: 'Digit3', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(Math.round(c.timeline.currentFrame)).toBe(90);
  });

  it('Shift+5 with three markers does nothing — the command disables itself', () => {
    addMarkersOutOfOrder();
    wireShortcuts();
    const c = getTimelineController();
    c.timeline.seek(45);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '%', code: 'Digit5', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(Math.round(c.timeline.currentFrame)).toBe(45);
  });

  it('a BARE 1 does not seek a marker — it still belongs to the 3D view', () => {
    // The collision check, at the layer where a collision would actually bite.
    addMarkersOutOfOrder();
    wireShortcuts();
    const c = getTimelineController();
    c.timeline.seek(45);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '1', code: 'Digit1', bubbles: true, cancelable: true,
    }));

    expect(Math.round(c.timeline.currentFrame)).toBe(45);
  });
});
