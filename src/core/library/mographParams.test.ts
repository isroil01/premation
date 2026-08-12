/**
 * Editable blanks on an inserted motion-graphics element.
 *
 * The derivation is the contract here: nothing declares a per-item manifest, so
 * if the walk stops matching how the catalog builds its nodes, every item
 * silently loses its fields at once. These assertions run over the REAL
 * catalog for that reason.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { writeTemplateField } from '@core/template/templateFields';
import type { SceneNode } from '@core/types';

import { MOGRAPH_ITEMS, insertMographItem } from './mographLibrary';
import {
  findMographRoot, mographIdOf, readMographFields, partLabel, MOGRAPH_ID_PROP,
} from './mographParams';

function reset(): void {
  usePreferenceStore.getState().set('editorReduceMotion', true);
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition 1', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useSelectionStore.getState().set([]);
}

describe('partLabel', () => {
  beforeEach(reset);

  it('reads the authored suffix, not the generated prefix', () => {
    expect(partLabel('mg_3_kf9a', 'mg_3_kf9a_role')).toBe('Role');
    expect(partLabel('mg_3_kf9a', 'mg_3_kf9a_sub_title')).toBe('Sub Title');
  });
});

describe('an inserted element is recognisable and editable', () => {
  beforeEach(reset);

  it('stamps the catalog id on the group', () => {
    const id = insertMographItem('mg-lower-line')!;
    expect(mographIdOf(id)).toBe('mg-lower-line');
    const meta = defaultSceneGraph.getNode(id)!.components[0]!;
    expect((meta.props as Record<string, unknown>)[MOGRAPH_ID_PROP]).toBe('mg-lower-line');
  });

  it('finds the element from a CHILD selection — where a canvas click lands', () => {
    const root = insertMographItem('mg-lower-line')!;
    const child = defaultSceneGraph.getNode(root)!.children[0] as unknown as string;
    const childId = typeof child === 'string' ? child : (child as { id: string }).id;
    expect(findMographRoot(childId)).toBe(root);
    // And an unrelated layer resolves to nothing rather than the nearest group.
    expect(findMographRoot('comp_root')).toBeNull();
  });

  it('names the built parts instead of leaving raw ids in the Layers panel', () => {
    const root = insertMographItem('mg-lower-line')!;
    const names = (defaultSceneGraph.getNode(root)!.children as unknown as string[])
      .map((c) => defaultSceneGraph.getNode(typeof c === 'string' ? c : (c as { id: string }).id)!.name);
    expect(names).toContain('Name');
    expect(names).toContain('Role');
    for (const n of names) expect(n).not.toMatch(/^mg_\d+_/);
  });

  it('editing a text field survives a read-back through the scene', () => {
    const root = insertMographItem('mg-lower-line')!;
    const field = readMographFields(root).find((f) => f.kind === 'text' && f.label === 'Name')!;
    expect(field.default).toBe('Name Surname');
    expect(writeTemplateField(field, 'Ada Lovelace')).toBe(true);

    const node = defaultSceneGraph.getNode(field.target.nodeId)!;
    const text = node.components.find((c) => c.type === 'Text')!;
    expect((text.props as Record<string, unknown>).content).toBe('Ada Lovelace');
  });

  it('editing a colour field survives a read-back through the scene', () => {
    const root = insertMographItem('mg-lower-line')!;
    const field = readMographFields(root).find((f) => f.kind === 'color')!;
    expect(writeTemplateField(field, '#ff0066')).toBe(true);

    const node = defaultSceneGraph.getNode(field.target.nodeId)!;
    const comp = node.components.find((c) => c.type === field.target.componentType)!;
    expect((comp.props as Record<string, unknown>).fill).toBe('#ff0066');
  });
});

describe('every catalog item exposes something to edit', () => {
  beforeEach(reset);

  it.each(MOGRAPH_ITEMS.map((i) => [i.id] as const))('%s derives at least one field', (id) => {
    const root = insertMographItem(id)!;
    const fields = readMographFields(root);
    expect(fields.length).toBeGreaterThan(0);
    // Every field must point at a node that still exists and carries the
    // component it claims — a stale target is an input that writes nowhere.
    for (const f of fields) {
      const node = defaultSceneGraph.getNode(f.target.nodeId);
      expect(node).toBeTruthy();
      expect(node!.components.some((c) => c.type === f.target.componentType)).toBe(true);
    }
  });

  it('skips text that a data track regenerates every frame', () => {
    // The number counter rewrites `text.source` from hold keyframes, so a typed
    // value would be overwritten on the next evaluation. Offering the box would
    // be offering an edit that silently does nothing.
    const root = insertMographItem('mg-data-counter')!;
    const dataDriven = (defaultSceneGraph.getNode(root)!.children as unknown as string[])
      .map((c) => (typeof c === 'string' ? c : (c as { id: string }).id))
      .filter((cid) => defaultAnimation.isDataAnimated(cid, 'text.source'));
    expect(dataDriven.length).toBeGreaterThan(0);

    const textTargets = readMographFields(root).filter((f) => f.kind === 'text').map((f) => f.target.nodeId);
    for (const cid of dataDriven) expect(textTargets).not.toContain(cid);
  });
});
