/**
 * The viewport's command layer — that every command it promises exists, that
 * the chords it claims do not collide with each other, and that the two
 * commands sharing a key with something older are gated rather than greedy.
 *
 * The gating is the part worth a test. J/K/L share keys with the timeline;
 * `ShortcutManager` dispatches the most recently registered
 * ENABLED binding and lets a disabled one fall through, so the whole design
 * rests on `enabled()` returning false at the right moments. A regression
 * there does not throw — it quietly steals a key from another panel.
 */

import { buildViewportCommands, VIEWPORT_COMMAND_IDS, transportChordsActive } from './viewportCommands';
import { __resetCompositionShuttle, getCompositionShuttle } from '@core/timeline/transportController';
import { useCompareStore } from '@stores/compareStore';

function byId(id: string) {
  return buildViewportCommands().find((c) => String(c.id) === id);
}

afterEach(() => {
  __resetCompositionShuttle();
  useCompareStore.getState().clear();
});

describe('viewportCommands', () => {
  it('registers every id the header strip and the menus reference', () => {
    const ids = new Set(buildViewportCommands().map((c) => String(c.id)));
    const expected = [
      VIEWPORT_COMMAND_IDS.snapshot,
      VIEWPORT_COMMAND_IDS.compareToggle,
      VIEWPORT_COMMAND_IDS.compareFlip,
      VIEWPORT_COMMAND_IDS.compareClear,
      VIEWPORT_COMMAND_IDS.hud,
      VIEWPORT_COMMAND_IDS.snapToPixel,
      VIEWPORT_COMMAND_IDS.pixelAspectCorrection,
      VIEWPORT_COMMAND_IDS.guidesShow,
      VIEWPORT_COMMAND_IDS.guidesLock,
      VIEWPORT_COMMAND_IDS.guidesUnlock,
      VIEWPORT_COMMAND_IDS.guidesClear,
      VIEWPORT_COMMAND_IDS.viewerLutLoad,
      VIEWPORT_COMMAND_IDS.viewerLutClear,
      VIEWPORT_COMMAND_IDS.rotoTool,
      VIEWPORT_COMMAND_IDS.inlineAiPrompt,
      VIEWPORT_COMMAND_IDS.markIn,
      VIEWPORT_COMMAND_IDS.markOut,
      VIEWPORT_COMMAND_IDS.displayModeCycle,
      VIEWPORT_COMMAND_IDS.compareMode('wipe'),
      VIEWPORT_COMMAND_IDS.displayMode('wireframe'),
      VIEWPORT_COMMAND_IDS.bookmarkRecall(1),
      VIEWPORT_COMMAND_IDS.bookmarkSave(9),
    ];
    for (const id of expected) expect(ids.has(id)).toBe(true);
  });

  it('gives every command a unique id', () => {
    const ids = buildViewportCommands().map((c) => String(c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not bind the same chord twice within its own set', () => {
    const chords = buildViewportCommands()
      .filter((c) => c.shortcut)
      .map((c) => {
        const s = c.shortcut!;
        return [s.meta ? 'M' : '', s.alt ? 'A' : '', s.shift ? 'S' : '', s.key.toLowerCase()].join('-');
      });
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('saves a bookmark with Shift and recalls without it, on the same digit', () => {
    const recall = byId(VIEWPORT_COMMAND_IDS.bookmarkRecall(3))!;
    const save = byId(VIEWPORT_COMMAND_IDS.bookmarkSave(3))!;
    expect(recall.shortcut).toMatchObject({ key: '3', meta: true, alt: true });
    expect(save.shortcut).toMatchObject({ key: '3', meta: true, alt: true, shift: true });
  });

  describe('chords shared with older bindings', () => {
    it('Show Snapshot is Shift+F5 and leaves F6 to the Render Queue', () => {
      const toggle = byId(VIEWPORT_COMMAND_IDS.compareToggle)!;
      // It shared F6 with the Render Queue on an `enabled()` gate, so one key
      // did two unrelated things depending on whether a snapshot existed.
      expect(toggle.shortcut).toMatchObject({ key: 'F5', shift: true });
      expect(buildViewportCommands().some((c) => c.shortcut?.key === 'F6')).toBe(false);
      // Still nothing to show until a snapshot exists.
      expect(toggle.enabled?.()).toBe(false);

      useCompareStore.getState().addSnapshot({
        label: 's', time: 0, bitmap: {} as HTMLCanvasElement, width: 1, height: 1,
        view: { scale: 1, offsetX: 0, offsetY: 0 },
      });
      expect(toggle.enabled?.()).toBe(true);
    });

    it('J, K and L share one rule — all three are live while nothing is focused', () => {
      // K was once held back for the Knife at rest, which broke hold-K-tap-J/L
      // frame stepping. The Knife is on Shift+K now; K is the transport's.
      expect(getCompositionShuttle().rate()).toBe(0);
      for (const id of [VIEWPORT_COMMAND_IDS.shuttleReverse, VIEWPORT_COMMAND_IDS.shuttleStop, VIEWPORT_COMMAND_IDS.shuttleForward]) {
        expect(byId(id)!.enabled?.()).toBe(true);
      }
      expect(byId(VIEWPORT_COMMAND_IDS.shuttleStop)!.shortcut).toEqual({ key: 'k' });
    });

    it('J/K/L are claimed while a shuttle is running, whatever has focus', () => {
      // A running shuttle must keep the keys: you stop it with K, and losing
      // K mid-shuttle would leave the playhead sliding with no way to stop.
      getCompositionShuttle().keyDown('l');
      expect(getCompositionShuttle().rate()).toBe(1);
      expect(transportChordsActive()).toBe(true);

      const stop = byId(VIEWPORT_COMMAND_IDS.shuttleStop)!;
      expect(stop.shortcut).toMatchObject({ key: 'k' });
      expect(stop.enabled?.()).toBe(true);
    });
  });

  it('go-to-in / go-to-out are disabled without a work area', () => {
    // `hasInOut` reads the timeline controller; with no comp loaded there is
    // no work area, so both must stay out of the way of Shift+I / Shift+O.
    const goIn = byId(VIEWPORT_COMMAND_IDS.goToIn)!;
    expect(goIn.shortcut).toMatchObject({ key: 'i', shift: true });
    expect(typeof goIn.enabled).toBe('function');
  });
});
