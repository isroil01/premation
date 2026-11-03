/**
 * The rules for installed plugins' dock tabs (pluginDockRules.ts): titles,
 * dock-by-default then the user's layout, absence settled before a tab goes,
 * and the effect panel's pin.
 */

import type { PluginPanelEntry } from '@core/nativePlugins/pluginContrib';
import {
  dockOnRegister,
  pinStatus,
  pluginPanelMenuTitle,
  pluginPanelTitle,
  settleAbsences,
  type Absence,
} from './pluginDockRules';

const effect = (pluginName: string): PluginPanelEntry => ({
  panelId: 'plugin:x', plugin: 'x', pluginName, panel: { id: '', name: pluginName, page: 'index.html' }, kind: 'effect',
});
const tool = (pluginName: string, name: string): PluginPanelEntry => ({
  panelId: 'plugin:x/p', plugin: 'x', pluginName, panel: { id: 'p', name, page: 'p.html' }, kind: 'tool',
});

describe('titles', () => {
  it('names an effect panel by its panelTitle, with the plugin name unless it already has it', () => {
    expect(pluginPanelTitle(effect('Deep Glow'), { panelTitle: 'Studio' })).toBe('Deep Glow Studio');
    expect(pluginPanelTitle(effect('Atelier'), { panelTitle: 'Atelier Studio' })).toBe('Atelier Studio');
    expect(pluginPanelTitle(effect('Deep Glow'), { panelTitle: '  ' })).toBe('Deep Glow');
    expect(pluginPanelTitle(effect('Deep Glow'))).toBe('Deep Glow');
  });

  it('names a tool panel by its own name on the tab, and says whose it is in a menu', () => {
    expect(pluginPanelTitle(tool('Atelier', 'Palettes'))).toBe('Palettes');
    expect(pluginPanelMenuTitle(tool('Atelier', 'Palettes'))).toBe('Atelier: Palettes');
    expect(pluginPanelMenuTitle(tool('Atelier', 'Atelier Library'))).toBe('Atelier Library');
    expect(pluginPanelMenuTitle(effect('Deep Glow'), { panelTitle: 'Studio' })).toBe('Deep Glow Studio');
  });
});

describe('dockOnRegister', () => {
  it('docks a panel this machine has never seen, and keeps one the layout already has', () => {
    expect(dockOnRegister({ inLayout: false, seen: false })).toBe('keep');
    expect(dockOnRegister({ inLayout: true, seen: true })).toBe('keep');
    expect(dockOnRegister({ inLayout: true, seen: false })).toBe('keep');
  });

  it('leaves a seen panel the user closed closed', () => {
    expect(dockOnRegister({ inLayout: false, seen: true })).toBe('close');
  });
});

describe('settleAbsences', () => {
  const none: ReadonlyMap<string, Absence> = new Map();

  it('waits for a later answer, a moment later, before a panel goes', () => {
    const first = settleAbsences(none, new Set(['a']), new Set(), 5, 1000);
    expect(first.remove).toEqual([]);
    expect(first.pending.get('a')).toEqual({ revision: 5, at: 1000 });
    // The same answer again, or a later one too soon: still waiting.
    expect(settleAbsences(first.pending, new Set(['a']), new Set(), 5, 5000).remove).toEqual([]);
    expect(settleAbsences(first.pending, new Set(['a']), new Set(), 6, 1100, 1200).remove).toEqual([]);
    // A later answer, late enough: settled.
    expect(settleAbsences(first.pending, new Set(['a']), new Set(), 6, 2300, 1200).remove).toEqual(['a']);
  });

  it('forgets a panel that came back in between (an engine restart\'s empty answer)', () => {
    const first = settleAbsences(none, new Set(['a']), new Set(), 5, 1000);
    const back = settleAbsences(first.pending, new Set(), new Set(), 6, 1500);
    expect(back.pending.size).toBe(0);
    expect(back.remove).toEqual([]);
    // Missing again later starts the wait over.
    expect(settleAbsences(back.pending, new Set(['a']), new Set(), 7, 9000).remove).toEqual([]);
  });

  it('settles at once when the engine lists the plugin as not loaded', () => {
    const step = settleAbsences(none, new Set(['a', 'b']), new Set(['b']), 5, 1000);
    expect(step.remove).toEqual(['b']);
    expect([...step.pending.keys()]).toEqual(['a']);
  });
});

describe('pinStatus', () => {
  const pin = { layerId: 'L', effectId: 'E' };
  const base = { pin, docReady: true, layerExists: true, effectsLoaded: true, effectExists: true };

  it('follows the selection without a pin, and shows the pinned effect while it is there', () => {
    expect(pinStatus({ ...base, pin: undefined })).toBe('none');
    expect(pinStatus(base)).toBe('active');
  });

  it('drops a pin whose layer or effect is gone', () => {
    expect(pinStatus({ ...base, layerExists: false, effectExists: false })).toBe('stale');
    expect(pinStatus({ ...base, effectExists: false })).toBe('stale');
  });

  it('keeps the pin while the document or the layer\'s effects are still loading', () => {
    expect(pinStatus({ ...base, docReady: false, layerExists: false, effectExists: false })).toBe('pending');
    expect(pinStatus({ ...base, effectsLoaded: false, effectExists: false })).toBe('pending');
  });
});
