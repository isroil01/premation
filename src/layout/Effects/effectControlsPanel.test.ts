/**
 * Effect Controls is a real left-sidebar panel, not a comment that never
 * registered.
 *
 * For a long stretch the Window menu and F3 targeted `effectControls`, an id
 * that did not exist, so they were patched to open the right-sidebar Effects
 * *library* instead. That is the panel you add FROM. The stack you edit then
 * lived at the top of that same library, which is the inconvenience this
 * split exists to end. These assertions pin the wiring so the next rename
 * cannot silently point F3 at the browser again.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PANEL_DEFS } from '@layout/EditorLayout/panelDefs';
import { BUILTIN_WORKSPACES } from '@core/layout/workspaceManager';

const SRC = join(__dirname, '..', '..');

describe('Effect Controls panel wiring', () => {
  it('is registered on the left sidebar, not the right inspector', () => {
    const def = PANEL_DEFS.find((p) => p.id === 'effectControls');
    expect(def).toBeDefined();
    expect(def!.region).toBe('leftSidebar');
    expect(def!.title).toBe('Effect Controls');
    expect(def!.closable).toBe(false);
  });

  it('the Effects library stays on the right', () => {
    const def = PANEL_DEFS.find((p) => p.id === 'effects');
    expect(def).toBeDefined();
    expect(def!.region).toBe('rightInspector');
  });

  it('F3 and the Window menu open effectControls, not effects', () => {
    const providers = readFileSync(join(SRC, 'providers/Providers.tsx'), 'utf8');
    const menu = readFileSync(join(SRC, 'layout/Menu/menuModel.ts'), 'utf8');
    expect(providers).toMatch(/openPanel\('effectControls'\)/);
    expect(providers).not.toMatch(/view\.effectControls[\s\S]{0,400}openPanel\('effects'\)/);
    expect(menu).toMatch(/commandId: 'view\.effectControls'/);
  });

  it('the renderer map actually mounts the panel', () => {
    const demo = readFileSync(join(SRC, 'layout/EditorLayout/DemoPanels.tsx'), 'utf8');
    expect(demo).toMatch(/effectControls:\s*\(\)\s*=>\s*<EffectControlsPanel/);
  });

  it('the right Effects panel no longer hosts the applied stack', () => {
    const src = readFileSync(join(SRC, 'layout/Effects/EffectsPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/<EffectStack\b/);
    expect(src).not.toMatch(/Active Layer Effects/);
  });

  it('the left Effect Controls panel does not list presets to apply', () => {
    const src = readFileSync(join(SRC, 'layout/Effects/EffectControlsPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/listEffectPresets/);
    expect(src).not.toMatch(/Soft Glow/);
    expect(src).not.toMatch(/addChip/);
  });

  it('the right Effects panel is where presets are applied', () => {
    const src = readFileSync(join(SRC, 'layout/Effects/EffectsPanel.tsx'), 'utf8');
    expect(src).toMatch(/listEffectPresets/);
    expect(src).toMatch(/Effect Presets/);
    expect(src).toMatch(/applyEffectPreset/);
  });

  it('Color & VFX opens Effect Controls on the left', () => {
    const ws = BUILTIN_WORKSPACES.find((w) => w.id === 'color-grading');
    expect(ws?.panelOrder?.leftSidebar).toContain('effectControls');
    expect(ws?.activePanelByRegion?.leftSidebar).toBe('effectControls');
  });
});
