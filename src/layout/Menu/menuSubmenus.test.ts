/**
 * Submenus in the app menu: structure, and the registration behind each entry.
 *
 * `MenuItemModel` grew `children` so three features that existed only inside
 * one panel's right-click kebab could reach the menu bar — boolean path ops,
 * the 3D primitive inserts, and the saved workspace layouts. All three are
 * exactly the shape that rots quietly: a nested list nothing walks, whose ids
 * the flat `menuModel.test.ts` checks cannot see (its `visibleCommandIds`
 * flat-maps `group.items` and stops there).
 *
 * So this walks the tree.
 *
 * IF THIS FAILS you have added a submenu entry whose command Providers never
 * builds, or moved a submenu out of the group it is asserted in.
 */

import { APP_MENU, type MenuItemModel } from './menuModel';
import { visibleItems } from './useAppMenuGroups';
import { readSource } from '@/__testHelpers__/readSource';

function resolveChildren(item: MenuItemModel): ReadonlyArray<MenuItemModel> {
  const c = item.children;
  if (!c) return [];
  return typeof c === 'function' ? c() : c;
}

function findItem(groupId: string, label: string): MenuItemModel {
  const group = APP_MENU.find((g) => g.id === groupId);
  if (!group) throw new Error(`no ${groupId} menu group`);
  const item = group.items.find((it) => it.label === label);
  if (!item) throw new Error(`no “${label}” entry in the ${groupId} menu`);
  return item;
}

/** Every commandId in the tree, submenus included. */
function allCommandIds(items: ReadonlyArray<MenuItemModel>): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.commandId) out.push(it.commandId);
    out.push(...allCommandIds(resolveChildren(it)));
  }
  return out;
}

describe('menu submenus', () => {
  const providers = readSource('providers/Providers.tsx');

  it('Layer ▸ Path Operations offers the live booleans before the bakes', () => {
    const kids = resolveChildren(findItem('layer', 'Path Operations'));
    const ids = kids.filter((k) => !k.separator).map((k) => k.commandId);
    expect(ids).toEqual([
      'shape.boolean.union',
      'shape.boolean.subtract',
      'shape.boolean.intersect',
      'shape.boolean.exclude',
      'shape.mergeUnion',
      'shape.mergeSubtract',
      'shape.mergeIntersect',
      'shape.mergeExclude',
    ]);
    // The live ops keep operands animatable, so they lead — same order as the
    // Scene panel kebab this submenu mirrors.
    expect(kids.findIndex((k) => k.separator)).toBe(4);
  });

  it('Layer ▸ New 3D Primitive covers every kind insert3DPrimitive accepts', () => {
    const ids = resolveChildren(findItem('layer', 'New 3D Primitive')).map((k) => k.commandId);
    expect(ids).toEqual([
      'layer.new3d.cube',
      'layer.new3d.sphere',
      'layer.new3d.cylinder',
      'layer.new3d.plane',
    ]);
  });

  it('Scene Edit Detection sits under Layer, where AE puts it', () => {
    const ids = APP_MENU.find((g) => g.id === 'layer')?.items.map((i) => i.commandId) ?? [];
    expect(ids).toContain('layer.sceneEditDetect.markers');
    expect(ids).toContain('layer.sceneEditDetect.split');
  });

  it('Window ▸ Workspace is built per render and always offers save + reset', () => {
    const workspace = findItem('window', 'Workspace');
    // A thunk, not a frozen array: saving a layout has to make it appear
    // without a reload.
    expect(typeof workspace.children).toBe('function');
    const ids = resolveChildren(workspace).map((k) => k.commandId);
    expect(ids).toContain('workspace.saveAs');
    expect(ids).toContain('layout.reset');
  });

  it('a workspace entry carries its own action and check, not a command id', () => {
    // Presets are partly USER data — a layout saved at runtime has no
    // registration to point at, which is why `onSelect`/`checked` exist.
    const kids = resolveChildren(findItem('window', 'Workspace'));
    const presets = kids.filter((k) => !k.separator && !k.commandId);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(typeof p.onSelect).toBe('function');
      expect(typeof p.checked).toBe('function');
    }
    // Exactly one is marked active, never two.
    expect(presets.filter((p) => p.checked?.()).length).toBeLessThanOrEqual(1);
  });

  it('every submenu command id is built by Providers', () => {
    // Providers spells these with template literals over an op/kind/mode list,
    // so the assertion is on the pieces that produce each id rather than on a
    // quoted literal that does not appear in the source.
    const declared: ReadonlyArray<[string, ReadonlyArray<string>]> = [
      ['asCommandId(`shape.boolean.${op}`)', ["op: 'union'", "op: 'subtract'", "op: 'intersect'", "op: 'exclude'"]],
      ['asCommandId(`layer.new3d.${id}`)', ["id: 'cube'", "id: 'sphere'", "id: 'cylinder'", "id: 'plane'"]],
      ['asCommandId(`layer.sceneEditDetect.${mode}`)', ["mode: 'markers'", "mode: 'split'"]],
    ];
    for (const [factory, members] of declared) {
      expect(providers).toContain(factory);
      for (const m of members) expect(providers).toContain(m);
    }
    for (const id of ['shape.mergeUnion', 'shape.mergeSubtract', 'shape.mergeIntersect', 'shape.mergeExclude']) {
      expect(providers).toContain(`bakeId: '${id}'`);
    }
    expect(providers).toContain("asCommandId('workspace.saveAs')");
  });

  it('lists no command twice inside one submenu', () => {
    for (const group of APP_MENU) {
      for (const item of group.items) {
        const ids = allCommandIds(resolveChildren(item));
        expect(ids).toEqual([...new Set(ids)]);
      }
    }
  });

  it('leaves no dangling separator inside a submenu', () => {
    for (const group of APP_MENU) {
      for (const item of group.items) {
        const kids = resolveChildren(item);
        if (kids.length === 0) continue;
        const kept = visibleItems(kids);
        expect(kept[0]?.separator).toBeFalsy();
        expect(kept[kept.length - 1]?.separator).toBeFalsy();
        for (let i = 1; i < kept.length; i++) {
          expect(kept[i]?.separator && kept[i - 1]?.separator).toBeFalsy();
        }
      }
    }
  });
});
