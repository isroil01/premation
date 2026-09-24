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
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useSelectionStore } from '@stores/selectionStore';

/** Non-square on purpose — see the rule 3a note in `rigPresets.test.ts`. */
const SIZE = { width: 260, height: 420 };

const PRESET_IDS = Object.keys(RIG_PRESETS) as RigPresetId[];

// The palette entry writes through the engine (`applyRigPresetEdit`): a real
// shape layer of the app's engine, sized SIZE.
let h: Harness & { engine: LocalEngine };
let NODE = '';

beforeEach(async () => {
  h = await setupAppEngine();
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Rig me', init: [] })).layer;
  await h.run({ type: 'setProperties', writes: [
    { prop: { layer: NODE, path: 'layer/width' }, value: { kind: 'scalar', value: SIZE.width } },
    { prop: { layer: NODE, path: 'layer/height' }, value: { kind: 'scalar', value: SIZE.height } },
  ] });
  useSelectionStore.getState().set([NODE]);
});
afterEach(async () => { await h.dispose(); });

const commandFor = (id: RigPresetId) =>
  buildStaticCommands().find((c) => String(c.id) === `rig.preset.${id}`);

async function run(id: RigPresetId): Promise<void> {
  await commandFor(id)!.execute({} as never);
  await engineIdle();
}

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

  it('RUNNING it writes a valid rig onto the selected layer', async () => {
    // The claim that a source-text guard cannot make: the command does the work.
    await run(id);
    const rig = readNodeSkeleton(defaultSceneGraph.getNode(NODE)!)!;
    expect(validateRig(rig)).toEqual([]);
    expect(rig.bones!.length).toBeGreaterThan(0);
    expect(rig.controllers!.length).toBeGreaterThan(0);
  });

  it('and it is exactly ONE undo entry, driven from the palette', async () => {
    // Asserted here as well as in `rigPresets.test.ts` because the entry could
    // reasonably have been written as a loop of per-bone commands.
    const n = historyLabels().length;
    await run(id);
    expect(historyLabels().slice(n)).toEqual([`Auto-Rig ${RIG_PRESET_LABELS[id]}`]);
  });

  it('ONE undo removes the whole rig', async () => {
    await run(id);
    await h.run({ type: 'undo' });
    const rig = readNodeSkeleton(defaultSceneGraph.getNode(NODE)!);
    expect(rig?.bones ?? []).toEqual([]);
    expect(rig?.controllers ?? []).toEqual([]);
  });

  it('sizes the rig from the LAYER, not from a constant', async () => {
    // The entry has to reach `readGeometry`. If it passed the 200×200 fallback
    // instead, a 260×420 layer would get the same rig as any other — so the
    // check is that the rig differs from the fallback-sized one.
    await run(id);
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
