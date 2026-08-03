/**
 * No AI surface is reachable when `aiEnabled()` is false.
 *
 * ── Why this test is the whole fix, and the predicate is not ────────────────
 *
 * Before this existed, `aiEnabled()` was `() => true` and had ZERO runtime
 * callers — every branch that once read it had been rewritten to read
 * `aiRunsThroughBackend()` instead, because at the time the only real difference
 * between the editions was where the key lived. So the obvious change — flip the
 * predicate to `isServerEdition()` — would have hidden precisely nothing, while
 * looking exactly like a fix and passing a typecheck.
 *
 * That is the §2·0 shape this project keeps finding: a value with readers that
 * drifted away from it, and nothing forcing the two back into agreement. This
 * test is the forcing function. It asserts the SURFACES, not the predicate.
 *
 * IF THIS FAILS, you have added an AI entry point that the local edition would
 * show. Gate it the way the existing ones are gated — by absence, not by
 * rendering a disabled state — and add it to the list here.
 */

import { setEdition } from './edition';
import { isPanelAvailable, PANEL_AVAILABILITY } from './panelAvailability';
import { availablePanelDefs, PANEL_DEFS, panelDef } from '@layout/EditorLayout/panelDefs';
import { getWorkspaceManager, BUILTIN_WORKSPACES } from '@core/layout/workspaceManager';

/**
 * Panel ids that constitute an AI surface.
 *
 * A list rather than a substring match on purpose: `assets` contains no AI, but
 * `AssetsPanel` renders AI-generated assets, and a regex over ids would either
 * miss the real surface or flag half the app.
 */
const AI_PANEL_IDS = ['ai'] as const;

describe('the local edition offers no AI surface', () => {
  afterEach(() => setEdition('server'));

  describe('the panel registry', () => {
    it('offers the assistant panel in the server edition', () => {
      // Guards the guard: if the panel stopped existing entirely, every
      // assertion below would pass vacuously and this file would prove nothing.
      setEdition('server');
      const ids = availablePanelDefs().map((p) => p.id);
      for (const id of AI_PANEL_IDS) expect(ids).toContain(id);
    });

    it('withholds it in the local edition', () => {
      setEdition('local');
      const ids = availablePanelDefs().map((p) => p.id);
      for (const id of AI_PANEL_IDS) expect(ids).not.toContain(id);
    });

    it('still RESOLVES it by id, so a persisted layout renders a name not an id', () => {
      // `panelDef` is deliberately unfiltered. A layout saved in a server build
      // and opened in a local one still holds the id; the dock drops it because
      // it is unregistered, but anything that does name it must not print `ai`.
      setEdition('local');
      expect(panelDef('ai')?.title).toBe('AI');
    });
  });

  describe('the workspace presets', () => {
    it('offers AI Focus in the server edition', () => {
      setEdition('server');
      const ids = getWorkspaceManager().listWorkspaces().map((w) => w.id);
      expect(ids).toContain('ai-focus');
    });

    it('withholds a preset that exists FOR a missing panel', () => {
      setEdition('local');
      const ids = getWorkspaceManager().listWorkspaces().map((w) => w.id);
      expect(ids).not.toContain('ai-focus');
    });

    it('strips the missing panel out of every preset that merely mentions it', () => {
      // `default` lists `ai` last in the left sidebar. The preset is still
      // useful without it, so it is kept and stripped rather than withheld.
      setEdition('server');
      expect(BUILTIN_WORKSPACES.find((w) => w.id === 'default')?.panelOrder?.leftSidebar)
        .toContain('ai');

      setEdition('local');
      for (const ws of getWorkspaceManager().listWorkspaces()) {
        const mentioned = [
          ...Object.values(ws.panelOrder ?? {}).flat(),
          ...Object.values(ws.activePanelByRegion ?? {}),
        ];
        for (const id of AI_PANEL_IDS) expect(mentioned).not.toContain(id);
      }
    });
  });

  describe('the availability table', () => {
    it('is read as a predicate, never as a value captured at module scope', () => {
      // The trap this replaced: PANEL_DEFS is evaluated when its module is first
      // imported, which happens through the App import graph — BEFORE main.tsx
      // calls setEdition(). Anything that snapshots availability at module scope
      // captures the 'server' default and never gates. Proven by flipping the
      // edition twice against the SAME imported table.
      setEdition('server');
      expect(isPanelAvailable('ai')).toBe(true);
      setEdition('local');
      expect(isPanelAvailable('ai')).toBe(false);
      setEdition('server');
      expect(isPanelAvailable('ai')).toBe(true);
    });

    it('treats an unlisted panel as available everywhere', () => {
      setEdition('local');
      expect(isPanelAvailable('scene')).toBe(true);
      expect(isPanelAvailable('a-panel-nobody-has-written-yet')).toBe(true);
    });

    it('names only panels that actually exist', () => {
      // A typo'd key here would gate nothing and never be noticed, because the
      // absent-means-available rule makes an unknown id look fine.
      const known = new Set(PANEL_DEFS.map((p) => p.id));
      for (const id of Object.keys(PANEL_AVAILABILITY)) expect(known).toContain(id);
    });
  });
});
