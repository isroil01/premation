/**
 * Auto-rig is reachable from the Command Palette, and the entry does the thing.
 *
 * ── WHY A SEPARATE FILE FROM `rigPresets.test.ts` (rule 4c) ────────────────
 *
 * `rigPresets.test.ts` proves the GENERATORS are right and that `applyRigPreset`
 * bundles into one undo entry. It calls both directly, so it passes in full on a
 * build where no UI invokes either — the F29 shape, and precisely what a missing
 * palette entry looks like from the inside.
 *
 * The weak version of this guard asserts that the command id appears in some
 * list. That stays green when the id is a typo, when the command is never
 * registered, and when its `execute` does something other than rig the layer. So
 * each claim is checked where it becomes false: the command is in the REGISTERED
 * list, and running it writes a rig the validator accepts.
 *
 * ── THE SUBJECT SET IS DERIVED ────────────────────────────────────────────
 *
 * From `RIG_PRESETS`, not from a list of two names. A preset added without a
 * palette entry is the failure this exists to catch, and a hardcoded pair could
 * not see it — the same shape that let `BoneControls` ship a hook its suite was
 * not looking at (F25).
 */

import { buildStaticCommands } from '@providers/Providers';
import { RIG_PRESETS, RIG_PRESET_LABELS, validateRig, type RigPresetId } from './rigPresets';
import { readNodeSkeleton } from './skeletonCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

const NODE = 'palette_rig_node';
/** Non-square on purpose — see the rule 3a note in `rigPresets.test.ts`. */
const SIZE = { width: 260, height: 420 };

const PRESET_IDS = Object.keys(RIG_PRESETS) as RigPresetId[];

function addNode(): void {
  if (defaultSceneGraph.getNode(NODE)) defaultSceneGraph.removeNode(NODE);
  defaultSceneGraph.addNode({
    id: NODE, name: NODE, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${NODE}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: SIZE.width, height: SIZE.height },
      },
    ],
  } as unknown as SceneNode);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  addNode();
  useSelectionStore.getState().set([NODE]);
});

const commandFor = (id: RigPresetId) =>
  buildStaticCommands().find((c) => String(c.id) === `rig.preset.${id}`);

const historyDepth = (): number => {
  const h = getCommandSystem().getHistory() as unknown as { undoStack?: unknown[] };
  return h.undoStack?.length ?? 0;
};

describe('the discovery found real subjects', () => {
  it('POSITIVE CONTROL: there is more than one preset to be missing an entry', () => {
    // With a single preset, "every preset has an entry" is one assertion wearing
    // a derived label, and `describe.each([])` reports as passing.
    expect(PRESET_IDS.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(PRESET_IDS)('palette entry for preset "%s"', (id) => {
  it('is registered — not merely named somewhere', () => {
    expect(commandFor(id)).toBeDefined();
  });

  it('is labelled with the preset name a user would search for', () => {
    // The palette ranks on `label`; an entry labelled by its id is unfindable.
    expect(commandFor(id)!.label).toContain(RIG_PRESET_LABELS[id]);
  });

  it('is disabled with no selection, enabled with one', () => {
    // A rig has to land on a layer. An always-enabled entry that silently does
    // nothing is the dead-control shape this codebase keeps finding.
    useSelectionStore.getState().clear();
    expect(commandFor(id)!.enabled?.() ?? true).toBe(false);
    useSelectionStore.getState().set([NODE]);
    expect(commandFor(id)!.enabled?.() ?? true).toBe(true);
  });

  it('RUNNING it writes a valid rig onto the selected layer', () => {
    // The claim that a source-text guard cannot make: the command does the work.
    void commandFor(id)!.execute({} as never);
    const rig = readNodeSkeleton(defaultSceneGraph.getNode(NODE)!)!;
    expect(validateRig(rig)).toEqual([]);
    expect(rig.bones!.length).toBeGreaterThan(0);
    expect(rig.controllers!.length).toBeGreaterThan(0);
  });

  it('and it is exactly ONE undo entry, driven from the palette', () => {
    // Asserted here as well as in `rigPresets.test.ts` because the entry could
    // reasonably have been written as a loop of per-bone commands.
    const d0 = historyDepth();
    void commandFor(id)!.execute({} as never);
    expect(historyDepth()).toBe(d0 + 1);
  });

  it('ONE undo removes the whole rig', () => {
    void commandFor(id)!.execute({} as never);
    getCommandSystem().getHistory().undo();
    const rig = readNodeSkeleton(defaultSceneGraph.getNode(NODE)!);
    expect(rig?.bones ?? []).toEqual([]);
    expect(rig?.controllers ?? []).toEqual([]);
  });

  it('sizes the rig from the LAYER, not from a constant', () => {
    // The entry has to reach `readGeometry`. If it passed the 200×200 fallback
    // instead, a 260×420 layer would get the same rig as any other — so the
    // check is that the rig differs from the fallback-sized one.
    void commandFor(id)!.execute({} as never);
    const applied = readNodeSkeleton(defaultSceneGraph.getNode(NODE)!)!;
    const fallback = RIG_PRESETS[id]({ width: 200, height: 200 });
    expect(applied.bones).not.toEqual(fallback.bones);
    expect(applied.bones).toEqual(RIG_PRESETS[id](SIZE).bones);
  });
});

describe('every preset has an entry — the gap this file exists to catch', () => {
  it('no preset is missing from the palette', () => {
    const registered = new Set(buildStaticCommands().map((c) => String(c.id)));
    const missing = PRESET_IDS.filter((id) => !registered.has(`rig.preset.${id}`));
    expect(missing).toEqual([]);
  });

  it('and no palette entry points at a preset that does not exist', () => {
    // The other direction: a renamed preset leaving a dead entry behind.
    const orphans = buildStaticCommands()
      .map((c) => String(c.id))
      .filter((id) => id.startsWith('rig.preset.'))
      .filter((id) => !PRESET_IDS.includes(id.slice('rig.preset.'.length) as RigPresetId));
    expect(orphans).toEqual([]);
  });
});
