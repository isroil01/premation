/**
 * Essential Properties — two instances of one comp must be able to differ.
 *
 * Overrides have two halves that are easy to build separately and fatal to
 * build alone:
 *
 *   static  — patched onto the clone's components by `expandCompInstances`.
 *   animated— the renderer dropping the overridden props from the clone's
 *             evaluated values, so the ORIGINAL node's track stops outvoting
 *             that patch on every frame.
 *
 * Build only the first and you get a control that works on a static layer and
 * does nothing at all the moment someone keyframes it — no error, no warning,
 * just a value that never appears. This file pins the document side: storage,
 * the static patch, and the set of props (`overriddenPropsFor`, colour channels
 * included) the renderer is told to drop. The drop itself is the engine's.
 */

import { readSource } from '@/__testHelpers__/readSource';
import {
  applyOverridesToComponents,
  overrideKey,
  overriddenPropsFor,
  parseOverrideKey,
  
  
  
  
  
  
  
  
  
} from './compInstanceOverrides';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

beforeEach(() => {
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
    comp_b: { id: 'comp_b', name: 'Lower Third', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
});

describe('override storage', () => {

  it('parses keys whose node id is not itself ambiguous', () => {
    expect(parseOverrideKey('b_shape/x')).toEqual({ origNodeId: 'b_shape', prop: 'x' });
    expect(parseOverrideKey('nested/b_shape/opacity'))
      .toEqual({ origNodeId: 'nested/b_shape', prop: 'opacity' });
    expect(parseOverrideKey('nokey')).toBeNull();
  });
});

describe('pure helpers', () => {
  it('overriddenPropsFor returns null rather than an empty set on the hot path', () => {
    expect(overriddenPropsFor(new Map(), 'n')).toBeNull();
    expect(overriddenPropsFor(new Map([[overrideKey('other', 'x'), 1]]), 'n')).toBeNull();
    expect([...overriddenPropsFor(new Map([[overrideKey('n', 'x'), 1]]), 'n')!]).toEqual(['x']);
  });

  it('applyOverridesToComponents returns the SAME array when nothing applies', () => {
    const comps = [{ id: 't', type: 'Transform', props: { x: 1 } }] as unknown as SceneNode['components'];
    expect(applyOverridesToComponents(comps, new Map(), 'n')).toBe(comps);
    expect(applyOverridesToComponents(comps, new Map([[overrideKey('other', 'x'), 5]]), 'n')).toBe(comps);
  });

  it('ignores a key naming a property outside the overridable set', () => {
    const comps = [{ id: 't', type: 'Transform', props: { x: 1 } }] as unknown as SceneNode['components'];
    expect(applyOverridesToComponents(comps, new Map([[overrideKey('n', 'blendMode'), 5]]), 'n')).toBe(comps);
  });

  it('ignores a value of the WRONG KIND for an overridable property', () => {
    // `fill` IS overridable now, but it is a colour string. A number stored
    // under it — from an older document, or a bad write — must not reach the
    // renderer, which would hand its colour parser a number and draw nothing.
    const comps = [{ id: 't', type: 'Transform', props: { x: 1 } }] as unknown as SceneNode['components'];
    expect(applyOverridesToComponents(comps, new Map([[overrideKey('n', 'fill'), 5]]), 'n')).toBe(comps);
    // …and the converse: a string under a numeric prop, which would reach the
    // transform as NaN and make the layer vanish.
    expect(applyOverridesToComponents(comps, new Map([[overrideKey('n', 'x'), '12']]), 'n')).toBe(comps);
  });
});

describe('the control is reachable', () => {
  // A section that exists but is never rendered is the "composed but
  // unexecuted" failure this repo has shipped before — tests green, feature
  // absent. So assert the mount, not just the module.

  it('CompOverridesSection is mounted on the placed-composition branch', () => {
    const ui = readSource('layout/Inspector/PrecompControl.tsx');
    expect(ui).toMatch(/import \{ CompOverridesSection \}/);
    expect(ui).toMatch(/<CompOverridesSection nodeId=\{nodeId\} \/>/);
    // It must sit in the `kind === 'comp'` branch — the only one that has a
    // referenced comp to override into.
    const compBranch = ui.slice(ui.indexOf("if (kind === 'comp')"));
    expect(compBranch.indexOf('<CompOverridesSection')).toBeGreaterThan(-1);
  });

  it('the section writes the same overrides through the engine (B3), one entry per action', () => {
    const ui = readSource('layout/Inspector/CompOverridesSection.tsx');
    // Set / clear one property, and Reset — `layer/compOverrides` commands sent with `edit`.
    expect(ui).toMatch(/edit\((overridden \? 'Clear Override' : 'Override Property'|'Override Property'|'Clear Override')/);
    expect(ui).toMatch(/edit\('Reset Overrides'/);
    expect(ui).toMatch(/OVERRIDABLE_PROPS/);
    expect(ui).toMatch(/readEssentialProps|mirrorEssentialProps/);
  });

  it('property menu can promote into Essential Properties', () => {
    const menu = readSource('core/inspector/propertyMenu.ts');
    expect(menu).toMatch(/Add to Essential Properties/);
    expect(menu).toMatch(/setEssentialProp/);
  });
});
