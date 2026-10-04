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
 *   • sections outside this directory. This used to name `DemoPanels.tsx`,
 *     which hosted several sections as inline JSX inside its push chain and so
 *     had no component for this suite to find. They are components in
 *     `inspectorSectionParts.tsx` now, in this directory, and covered — but a
 *     section written anywhere else still would not be;
 *   • components whose props are not literally `nodeId` — a section keyed on
 *     something else is skipped, and `at least the known sections are present`
 *     below is the positive control that the discovery found anything at all.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { useSelectionStore } from '@stores/selectionStore';

/**
 * Every inspector component in this directory that takes a `nodeId`.
 *
 * Read from disk, not imported statically, so the set cannot drift from the
 * directory. `require` rather than `import` because the list is only known at
 * run time.
 */
/**
 * The plain function behind a component export, or null if it is not one.
 *
 * `React.memo(Fn)` and `React.forwardRef(Fn)` are objects wrapping a
 * function, so `typeof x === "function"` answers "no" for a perfectly real
 * component. Discovery suites that ask the naive question shrink silently the
 * day a section is memoized — which is the one failure mode a discovery suite
 * must not have.
 */
function unwrapComponent(value: unknown): ((...args: never[]) => unknown) | null {
  if (typeof value === "function") return value as (...args: never[]) => unknown;
  const inner = (value as { type?: unknown; render?: unknown } | null)?.type
    ?? (value as { render?: unknown } | null)?.render;
  return typeof inner === "function" ? (inner as (...args: never[]) => unknown) : null;
}

function discoverSections(): Array<[string, React.ComponentType<{ nodeId: string }>]> {
  const dir = __dirname;
  const out: Array<[string, React.ComponentType<{ nodeId: string }>]> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    const mod = require(path.join(dir, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      // A memoized section is an OBJECT, not a function. Unwrapping it here is
      // load-bearing: a plain typeof check silently drops every section that
      // gains `React.memo`, and a discovery suite that quietly stops seeing its
      // subjects still passes. The wrapper is what gets rendered; the inner
      // function is what gets read.
      const inner = unwrapComponent(value);
      if (!inner) continue;
      if (!/^[A-Z]/.test(name)) continue;
      // The prop name is the contract this suite exercises: a section that does
      // not take a nodeId cannot be rendered with a missing node.
      const src = inner.toString();
      if (!/nodeId/.test(src)) continue;
      out.push([`${file.replace(/.tsx$/, "")}.${name}`, value as React.ComponentType<{ nodeId: string }>]);
    }
  }
  return out;
}

const SECTIONS = discoverSections();

afterEach(() => {
  cleanup();
});

describe("the discovery found real subjects", () => {
  it("POSITIVE CONTROL: enumerating the directory is not returning nothing", () => {
    // A discovery that silently found zero components would make every test
    // below vacuous, and `describe.each([])` reports as passing.
    expect(SECTIONS.length).toBeGreaterThan(5);
  });

  it("includes the sections that have actually broken this way", () => {
    // Named here as a floor, not as the list: these are the ones with a
    // recorded incident. If the discovery stops finding them it has broken.
    //
    // `TextSection` was a third. It is deleted — `CharacterPanel` had
    // superseded it and nothing mounted it — and its name is not replaced
    // here: `CharacterPanel` takes no `nodeId`, so it is not a subject of this
    // suite at all, and naming it would be a floor that quietly matches
    // nothing. Two named sections still hold the discovery honest.
    const names = SECTIONS.map(([n]) => n);
    for (const want of ["AppearanceSection.AppearanceSection", "BoneControls.BoneControls"]) {
      expect({ want, found: names.includes(want) }).toEqual({ want, found: true });
    }
  });
});

/**
 * Props beyond `nodeId` that a subject needs before it can render at all.
 *
 * `MultiPropertyRow` is a ROW, not a section: it describes ONE property, so
 * without a `prop` it has nothing to resolve and throws for a reason that has
 * nothing to do with a missing node. Supplying the prop keeps it IN this
 * suite — it is the component every multi-selection row goes through, and
 * "the selected layer was deleted" is exactly the situation it has to
 * survive — rather than exempting it and losing the coverage.
 */
const EXTRA_PROPS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "MultiPropertyRow.MultiPropertyRow": { prop: "opacity" },
  // Same argument, several props: the two-field row needs its members.
  "MultiPropertyPairRow.MultiPropertyPairRow": {
    label: "Position",
    props: [{ prop: "x", prefix: "X" }, { prop: "y", prefix: "Y" }],
  },
  // The stopwatch + navigator control every non-PropertyRow row shares. Same
  // argument as MultiPropertyRow: it governs named tracks, so it needs them.
  "AnimToggle.AnimToggle": { tracks: ["opacity"], label: "Opacity", animated: false, onToggle: () => {} },
};

describe.each(SECTIONS)('%s survives its node disappearing mid-session', (_name, Section) => {
  /** `nodeId` plus whatever else this subject needs — see EXTRA_PROPS. */
  const propsFor = (nodeId: string): { nodeId: string } =>
    ({ nodeId, ...(EXTRA_PROPS[_name] ?? {}) });

  it('renders for a node id that never existed', () => {
    useSelectionStore.setState({ ids: [] } as never);
    expect(() => render(<Section {...propsFor('no_such_node')} />)).not.toThrow();
  });
});
