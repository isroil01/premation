/**
 * Layer / Solid Settings (AE Ctrl+Shift+Y; Layer ▸ New ▸ Solid).
 */

import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertSolid } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  buildSolidLayer,
  layerSettingsKind,
  readLayerSettings,
  sanitizeLayerSize,
} from './layerSettings';

beforeAll(() => {
  // The inserts reach the command system — boot a minimal one.
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) } as unknown as ConstructorParameters<typeof CommandSystem>[0]));
  seedDefaultScene();
});

function sizeOf(id: string): { w: unknown; h: unknown } {
  const t = defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!;
  return { w: t.props.width, h: t.props.height };
}

describe('Solid Settings', () => {
  it('reads a solid as a solid, with its size and colour', () => {
    insertSolid('#112233');
    const id = useSelectionStore.getState().ids[0]!;
    const read = readLayerSettings(id)!;
    expect(read.kind).toBe('solid');
    expect(read.values.color).toBe('#112233');
    expect(typeof read.values.width).toBe('number');
  });

  // The builder the New Solid insert runs off-document (the dialog's Apply is compositionEdits.ts, engine commands).
  it('New Solid builds the configured solid and selects it', () => {
    const id = buildSolidLayer({ name: 'Matte', width: 100, height: 50, color: '#00ff00' })!;
    expect(id).toBeTruthy();
    expect(useSelectionStore.getState().ids).toEqual([id]);
    const node = defaultSceneGraph.getNode(id)!;
    expect(node.name).toBe('Matte');
    expect(layerSettingsKind(node)).toBe('solid');
    expect(sizeOf(id)).toEqual({ w: 100, h: 50 });
  });

  it('clamps and rounds a typed size into AE’s range', () => {
    expect(sanitizeLayerSize(0)).toBe(1);
    expect(sanitizeLayerSize(99999)).toBe(30000);
    expect(sanitizeLayerSize(12.6)).toBe(13);
    expect(sanitizeLayerSize(Number('abc'))).toBeNull();
  });
});
