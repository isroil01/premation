/**
 * What a double-click on a layer opens — AE's rules and its two "Opening
 * Layers with Double-click" preferences (Alt swaps them; a paint tool always
 * means the Layer panel).
 */

jest.mock('@layout/Assets/FootagePreviewDialog', () => ({ openFootagePreview: jest.fn() }));

import type { Command } from '@motion/engine-api';
import { openFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { useProjectStore } from '@stores/projectStore';
import { useLayerViewerStore } from '@stores/layerViewerStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useUIStore } from '@stores/uiStore';
import { settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { canOpenInLayerPanel, openLayerOnDoubleClick } from './openLayer';

let h: Harness;
let s: Scene;
/** A composition layer showing `s.comp2`. */
let INST = '';

const activeComp = (): string => {
  const st = useProjectStore.getState();
  return st.tabs[st.activeTabId!]!.compositionId;
};
const panel = (): string | null => useLayerViewerStore.getState().nodeId;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  INST = (await h.run({ type: 'createLayer', comp: s.comp, kind: 'precomp', name: 'Lower Third', source: s.comp2, init: [] } as Command) as { layer: string }).layer;
  await settleEdits();
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  actions.setActiveTab(actions.openTab(s.comp, [s.comp], 'Main'));
  useLayerViewerStore.getState().close();
  usePreferenceStore.getState().set('footageLayerOpens', 'layer');
  usePreferenceStore.getState().set('compLayerOpens', 'nested');
  useUIStore.setState({ activeTool: 'select' } as never);
  (openFootagePreview as jest.Mock).mockClear();
});
afterEach(async () => {
  await h.dispose();
});

describe('footage layers', () => {
  it('open in the Layer panel by default', () => {
    expect(openLayerOnDoubleClick(s.V)).toBe(true);
    expect(panel()).toBe(s.V);
    expect(openFootagePreview).not.toHaveBeenCalled();
  });

  it('open their source with "Source Footage", and Alt opens the Layer panel instead', () => {
    usePreferenceStore.getState().set('footageLayerOpens', 'source');
    expect(openLayerOnDoubleClick(s.V)).toBe(true);
    expect(openFootagePreview).toHaveBeenCalledWith(expect.objectContaining({ id: s.footage }));
    expect(panel()).toBeNull();

    expect(openLayerOnDoubleClick(s.V, { alt: true })).toBe(true);
    expect(panel()).toBe(s.V);
  });

  it('always open the Layer panel with a paint tool, and for a solid (no source to show)', () => {
    usePreferenceStore.getState().set('footageLayerOpens', 'source');
    useUIStore.setState({ activeTool: 'paint' } as never);
    openLayerOnDoubleClick(s.V);
    expect(panel()).toBe(s.V);

    useUIStore.setState({ activeTool: 'select' } as never);
    openLayerOnDoubleClick(s.A);
    expect(panel()).toBe(s.A);
    expect(openFootagePreview).not.toHaveBeenCalled();
  });
});

describe('composition layers', () => {
  it('open the nested composition by default', () => {
    expect(openLayerOnDoubleClick(INST)).toBe(true);
    expect(activeComp()).toBe(s.comp2);
    expect(panel()).toBeNull();
  });

  it('open in the Layer panel with Alt', () => {
    expect(openLayerOnDoubleClick(INST, { alt: true })).toBe(true);
    expect(panel()).toBe(INST);
    expect(activeComp()).toBe(s.comp);
  });

  it('follow "Composition Layer Opens: Layer Panel", Alt then opening the comp', () => {
    usePreferenceStore.getState().set('compLayerOpens', 'layer');
    openLayerOnDoubleClick(INST);
    expect(panel()).toBe(INST);
    openLayerOnDoubleClick(INST, { alt: true });
    expect(activeComp()).toBe(s.comp2);
  });
});

describe('layers with no Layer panel', () => {
  it('open nothing for text and shape layers', () => {
    expect(openLayerOnDoubleClick(s.T)).toBe(false);
    expect(openLayerOnDoubleClick(s.B)).toBe(false);
    expect(panel()).toBeNull();
    expect([s.V, s.A, INST, s.T, s.B].map((id) => canOpenInLayerPanel(id))).toEqual([true, true, true, false, false]);
  });
});
