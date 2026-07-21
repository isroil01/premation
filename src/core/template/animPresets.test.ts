/**
 * Animated presets — the drop-in library:
 *  • registry resolves ids;
 *  • inserting adds ONE animated element under the active comp (no scene wipe)
 *    and selects it;
 *  • text presets add a Text layer, object presets a Style'd shape;
 *  • every preset inserts without throwing.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { ANIM_PRESETS, insertAnimPreset, getAnimPreset } from './animPresets';
import { buildTitleCard } from './templates/titleCard';

describe('animated presets', () => {
  beforeEach(() => {
    buildTitleCard(); // establishes an active composition to insert into
  });

  it('registry resolves ids', () => {
    expect(getAnimPreset('cascade-rise')).toBeTruthy();
    expect(getAnimPreset('nope')).toBeNull();
  });

  it('insert adds exactly one element under the active comp and selects it', () => {
    const before = defaultSceneGraph.size;
    const id = insertAnimPreset('cascade-rise', 100, 100);
    expect(id).toBeTruthy();
    expect(defaultSceneGraph.size).toBe(before + 1);
    expect(useSelectionStore.getState().ids).toEqual([id]);
  });

  it('text presets add a Text layer, object presets a shape', () => {
    const textId = insertAnimPreset('elastic-pop')!;
    expect(defaultSceneGraph.getNode(textId)!.components.some((c) => c.type === 'Text')).toBe(true);
    const objId = insertAnimPreset('bounce-dot')!;
    expect(defaultSceneGraph.getNode(objId)!.components.some((c) => c.type === 'Style')).toBe(true);
  });

  it('per-glyph presets attach a native text animator to the layer', () => {
    const id = insertAnimPreset('cascade-rise')!;
    const node = defaultSceneGraph.getNode(id)!;
    const text = node.components.find((c) => c.type === 'Text')!;
    const animators = (text.props as Record<string, unknown>).__animators as Array<Record<string, unknown>>;
    expect(Array.isArray(animators)).toBe(true);
    expect(animators).toHaveLength(1);
    expect(animators[0]!.y).toBe(110);
    expect(animators[0]!.basedOn).toBe('characters');
  });

  it('every preset inserts without throwing', () => {
    for (const p of ANIM_PRESETS) {
      expect(insertAnimPreset(p.id)).toBeTruthy();
    }
  });
});
