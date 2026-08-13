/**
 * Inspector sections must not vary their hook count between renders.
 *
 * `AppearanceSection` and `TextSection` both did `if (!node) return null;`
 * BEFORE their `useMemo` / `useNodeComponentProp` / `useSelectionStore` calls.
 * React counts hooks per render, so the first pass (node present) ran the full
 * set and the next pass (node deleted, still selected) ran none — "Rendered
 * fewer hooks than expected", which unmounts the tree and takes the editor down.
 *
 * Deleting a selected layer with the inspector open is the ordinary way to hit
 * it, which is why this is a crash and not an edge case.
 *
 * ## The subject list is DERIVED, and that is the point (F25, third instance)
 *
 * This suite used to name its subjects: two of them. `BoneControls` then
 * shipped a hook below its `!node` guard and the suite could not see it,
 * because it was never in the list — eslint caught it instead. Adding the name
 * fixes the instance; enumerating the directory fixes the class.
 *
 * The same shape has now bitten this project three times: `expressionApi.test.ts`
 * with 16 hardcoded names, the eslint globals list, and this. A hardcoded
 * subject set is a guard that silently stops covering whatever is added next,
 * and it reads exactly like a guard that passes.
 *
 * So the subjects come from the filesystem: every `.tsx` in this directory that
 * exports a component taking a `nodeId` prop. A new section is covered the
 * moment it exists, with no edit here.
 *
 * WHAT THE DERIVATION CANNOT COVER, stated so nobody reads it as total:
 *   • sections outside this directory (`EditorLayout/DemoPanels.tsx` hosts
 *     several inline ones);
 *   • components whose props are not literally `nodeId` — a section keyed on
 *     something else is skipped, and `at least the known sections are present`
 *     below is the positive control that the discovery found anything at all.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { render, cleanup } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

/**
 * Every inspector component in this directory that takes a `nodeId`.
 *
 * Read from disk, not imported statically, so the set cannot drift from the
 * directory. `require` rather than `import` because the list is only known at
 * run time.
 */
function discoverSections(): Array<[string, React.ComponentType<{ nodeId: string }>]> {
  const dir = __dirname;
  const out: Array<[string, React.ComponentType<{ nodeId: string }>]> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    const mod = require(path.join(dir, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      if (!/^[A-Z]/.test(name)) continue;
      // The prop name is the contract this suite exercises: a section that does
      // not take a nodeId cannot be rendered with a missing node.
      const src = (value as { toString(): string }).toString();
      if (!/nodeId/.test(src)) continue;
      out.push([`${file.replace(/.tsx$/, "")}.${name}`, value as React.ComponentType<{ nodeId: string }>]);
    }
  }
  return out;
}

const SECTIONS = discoverSections();

const ID = "hooks_probe_layer";

function textNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: "Transform", props: { [SCENE_KIND_PROP]: "text", x: 0, y: 0, width: 200, height: 60, opacity: 100 } },
      { id: `${id}_txt`, type: "Text", props: { content: "Hi", fontSize: 48, fontFamily: "Inter" } },
      { id: `${id}_s`, type: "Style", props: { opacity: 100, fill: "#ffffff" } },
    ],
  } as unknown as SceneNode;
}

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe("the discovery found real subjects", () => {
  it("POSITIVE CONTROL: enumerating the directory is not returning nothing", () => {
    // A discovery that silently found zero components would make every test
    // below vacuous, and `describe.each([])` reports as passing.
    expect(SECTIONS.length).toBeGreaterThan(5);
  });

  it("includes the sections that have actually broken this way", () => {
    // Named here as a floor, not as the list: these three are the ones with a
    // recorded incident. If the discovery stops finding them it has broken.
    const names = SECTIONS.map(([n]) => n);
    for (const want of ["AppearanceSection.AppearanceSection", "TextSection.TextSection", "BoneControls.BoneControls"]) {
      expect({ want, found: names.includes(want) }).toEqual({ want, found: true });
    }
  });
});

describe.each(SECTIONS)('%s survives its node disappearing mid-session', (_name, Section) => {
  it('renders with the node present, then again after it is deleted', () => {
    defaultSceneGraph.addNode(textNode(ID));
    useSelectionStore.setState({ ids: [ID] } as never);

    const view = render(<Section nodeId={ID} />);
    // The node goes away while the panel is still mounted and still pointed at it
    // — exactly what deleting a selected layer does.
    defaultSceneGraph.removeNode(ID);

    // Before the fix this threw "Rendered fewer hooks than expected".
    expect(() => view.rerender(<Section nodeId={ID} />)).not.toThrow();
  });

  it('renders for a node id that never existed', () => {
    useSelectionStore.setState({ ids: [] } as never);
    expect(() => render(<Section nodeId="no_such_node" />)).not.toThrow();
  });

  it('mounting straight onto a missing node, then a real one, is stable', () => {
    // The reverse order: hook count must not change when the node APPEARS either.
    const view = render(<Section nodeId={ID} />);
    defaultSceneGraph.addNode(textNode(ID));
    expect(() => view.rerender(<Section nodeId={ID} />)).not.toThrow();
  });
});
