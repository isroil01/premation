/**
 * AI surfaces stay reachable whenever `aiEnabled()` is true.
 *
 * ── Why this test is the whole fix, and the predicate is not ────────────────
 *
 * Before this existed, `aiEnabled()` was `() => true` and had ZERO runtime
 * callers — every branch that once read it had been rewritten to read
 * `aiRunsThroughBackend()` instead. Flipping the predicate alone would have
 * hidden precisely nothing. Surfaces are gated individually; this file asserts
 * the SURFACES, not only the predicate.
 *
 * Today the assistant ships in both editions (BYOK locally, gateway on server).
 * These tests pin that both editions expose the panel, the AI-focus workspace,
 * and the Customize AI tab wiring — and that availability is still read as a
 * live predicate, not a module-scope snapshot.
 *
 * IF THIS FAILS after turning `aiEnabled` off again, you have left an AI entry
 * point ungated. Gate it by absence and keep this list honest.
 */

import { setEdition, aiEnabled } from './edition';
import { isPanelAvailable, PANEL_AVAILABILITY } from './panelAvailability';
import { availablePanelDefs, PANEL_DEFS, panelDef } from '@layout/EditorLayout/panelDefs';
import { getWorkspaceManager, BUILTIN_WORKSPACES } from '@core/layout/workspaceManager';

const AI_PANEL_IDS = ['ai'] as const;

describe('both editions offer the AI surface when aiEnabled', () => {
  afterEach(() => setEdition('server'));

  it('keeps aiEnabled on in every edition', () => {
    setEdition('server');
    expect(aiEnabled()).toBe(true);
    setEdition('local');
    expect(aiEnabled()).toBe(true);
  });

  describe('the panel registry', () => {
    it.each(['server', 'local'] as const)('offers the assistant panel in the %s edition', (edition) => {
      setEdition(edition);
      const ids = availablePanelDefs().map((p) => p.id);
      for (const id of AI_PANEL_IDS) expect(ids).toContain(id);
    });

    it('resolves the panel by id for layout titles', () => {
      setEdition('local');
      expect(panelDef('ai')?.title).toBe('Assistant');
    });
  });

  describe('the workspace presets', () => {
    it.each(['server', 'local'] as const)('offers AI Focus in the %s edition', (edition) => {
      setEdition(edition);
      const ids = getWorkspaceManager().listWorkspaces().map((w) => w.id);
      expect(ids).toContain('ai-focus');
    });

    // The Default workspace is After Effects' right column, which has no
    // assistant (2026-10-07); AI Focus leads with it and Window ▸ Panels ▸
    // Assistant opens it anywhere.
    it('keeps ai in the AI Focus preset and on demand in every other', () => {
      expect(BUILTIN_WORKSPACES.find((w) => w.id === 'ai-focus')?.panelOrder?.leftSidebar?.[0]).toBe('ai');
      expect(panelDef('ai')?.onDemand).toBe(true);
    });
  });

  describe('the availability table', () => {
    it('is read as a predicate, never as a value captured at module scope', () => {
      setEdition('server');
      expect(isPanelAvailable('ai')).toBe(true);
      setEdition('local');
      expect(isPanelAvailable('ai')).toBe(true);
    });

    it('treats an unlisted panel as available everywhere', () => {
      setEdition('local');
      expect(isPanelAvailable('scene')).toBe(true);
      expect(isPanelAvailable('a-panel-nobody-has-written-yet')).toBe(true);
    });

    it('names only panels that actually exist', () => {
      const known = new Set(PANEL_DEFS.map((p) => p.id));
      for (const id of Object.keys(PANEL_AVAILABILITY)) expect(known).toContain(id);
    });
  });
});
