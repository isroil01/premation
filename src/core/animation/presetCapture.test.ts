/**
 * What a saved preset actually carries.
 *
 * `AnimationPreset` has had `effects` and `expressions` fields since
 * transitions and behaviours landed, and `applyPreset` installs both — but
 * nothing ever WROTE them. A layer with a glow and a wiggle saved as a preset
 * that replayed the movement and dropped the look, silently, with nothing on
 * screen to explain it.
 *
 * That is an asymmetric round trip, which is a defect that hides: the save
 * succeeds, the preset appears in the panel, and it applies without error. Only
 * the result is wrong. So the round trip is what these tests assert — capture
 * what apply can install, and nothing that it cannot.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getNodeEffects, writeNodeEffects } from '@core/effects/effects';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getSettingsManager, setCoreServiceRefs } from '@core/services/coreServices';
import { SettingsManager } from '@core/settings/SettingsManager';
import { listPresets, saveCurrentAsPreset, USER_PRESET_FOLDER } from './animationPresets';
import type { SceneNode } from '@core/types';

const NODE = 'preset_source';

function seedNode(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);

  const node: SceneNode = {
    id: NODE,
    name: 'Source',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${NODE}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100 } },
    ],
  };
  defaultSceneGraph.addNode(node);
}

/** The saved preset by name, or undefined. */
const saved = (name: string) => listPresets().find((p) => p.name === name && !p.builtin);

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  /*
    User presets live in the settings manager, and `readUserPresets` SWALLOWS
    the "services not registered" error and answers []. So without a real
    settings manager here every save would appear to succeed and every read
    would come back empty — the suite would pass by never asserting anything.
    Only the settings ref is registered; nothing here touches the others.
  */
  setCoreServiceRefs({ settings: new SettingsManager() } as never);
});

beforeEach(() => {
  seedNode();
  // EVERY animated prop, not a named few: `defaultAnimation` is a singleton, so
  // the effect-track test's `effect.fx_live_1.intensity` keyframes would
  // otherwise survive into the "nothing at all" case and make it pass a save it
  // should refuse.
  for (const prop of defaultAnimation.animatedProps(NODE)) {
    defaultAnimation.removeExpression(NODE, prop);
    defaultAnimation.setKeyframes(NODE, prop, []);
  }
  writeNodeEffects(NODE, []);
  // A clean settings store per test — user presets live there, and one test's
  // save would otherwise be visible to the next.
  getSettingsManager().set('animationPresets.user', []);
});

describe('saveCurrentAsPreset — what it captures', () => {
  test('keyframes, as it always did', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'x', 1, 200);

    expect(saveCurrentAsPreset(NODE, 'Moves')).toBe(true);
    expect(saved('Moves')?.tracks.some((t) => t.prop === 'x')).toBe(true);
  });

  test('the effect stack — the look, not just the movement', () => {
    writeNodeEffects(NODE, [{ id: 'fx_live_1', type: 'glow', params: { intensity: 40 } }]);

    expect(saveCurrentAsPreset(NODE, 'Glowing')).toBe(true);
    const preset = saved('Glowing');
    expect(preset?.effects).toHaveLength(1);
    expect(preset?.effects?.[0]).toMatchObject({ type: 'glow', params: { intensity: 40 } });
  });

  test('effect ids are renumbered into the PRESET namespace', () => {
    // Saving the live ids would produce a preset whose keyframes address
    // effects that exist only on the machine it was saved on.
    writeNodeEffects(NODE, [
      { id: 'fx_live_1', type: 'glow', params: {} },
      { id: 'fx_live_2', type: 'blur', params: {} },
    ]);
    saveCurrentAsPreset(NODE, 'Two');

    expect(saved('Two')?.effects?.map((e) => e.id)).toEqual(['fx0', 'fx1']);
  });

  test('effect TRACKS are re-pointed to match, or the preset animates nothing', () => {
    writeNodeEffects(NODE, [{ id: 'fx_live_1', type: 'glow', params: {} }]);
    defaultAnimation.setKeyframe(NODE, 'effect.fx_live_1.intensity', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'effect.fx_live_1.intensity', 1, 100);

    saveCurrentAsPreset(NODE, 'Pulse');

    const props = saved('Pulse')?.tracks.map((t) => t.prop) ?? [];
    expect(props).toContain('effect.fx0.intensity');
    expect(props).not.toContain('effect.fx_live_1.intensity');
  });

  test('an enabled expression, as a behaviour', () => {
    defaultAnimation.setKeyframe(NODE, 'opacity', 0, 100);
    defaultAnimation.setExpression(NODE, 'opacity', 'wiggle(2, 20)');

    expect(saveCurrentAsPreset(NODE, 'Wiggly')).toBe(true);
    expect(saved('Wiggly')?.expressions).toEqual([{ prop: 'opacity', expr: 'wiggle(2, 20)' }]);
  });

  test('a DISABLED expression is not captured', () => {
    // It is not driving the property — the keyframes under it are — so carrying
    // it would make the preset behave differently from the layer it came from.
    defaultAnimation.setKeyframe(NODE, 'opacity', 0, 100);
    defaultAnimation.setExpression(NODE, 'opacity', 'wiggle(2, 20)');
    defaultAnimation.setExpressionEnabled(NODE, 'opacity', false);

    saveCurrentAsPreset(NODE, 'Held');
    expect(saved('Held')?.expressions).toBeUndefined();
  });

  test('a layer whose only authored state is an effect is still a preset', () => {
    // AE's presets are frequently exactly that, and the old check refused them
    // as "nothing to save".
    writeNodeEffects(NODE, [{ id: 'fx_live_1', type: 'glow', params: {} }]);
    expect(saveCurrentAsPreset(NODE, 'Just A Glow')).toBe(true);
  });

  test('a layer with nothing at all still fails', () => {
    expect(getNodeEffects(NODE)).toHaveLength(0);
    expect(saveCurrentAsPreset(NODE, 'Empty')).toBe(false);
    expect(saved('Empty')).toBeUndefined();
  });

  test('saves into the user folder, so it is deletable from the panel', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    saveCurrentAsPreset(NODE, 'Filed');
    expect(saved('Filed')?.folder).toBe(USER_PRESET_FOLDER);
  });

  test('re-saving the same name replaces rather than duplicating', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    saveCurrentAsPreset(NODE, 'Once');
    saveCurrentAsPreset(NODE, 'Once');
    expect(listPresets().filter((p) => p.name === 'Once')).toHaveLength(1);
  });
});
