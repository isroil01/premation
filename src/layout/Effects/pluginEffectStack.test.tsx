/**
 * A plugin effect, once added to a layer, has to be VISIBLE on that layer.
 *
 * ── The bug this pins ────────────────────────────────────────────────────────
 *
 * `EffectStack` built its own `Map` from `EFFECT_DEFS` and skipped any effect
 * missing from it (`if (!def) return null`). `EFFECT_DEFS` is the built-in
 * array; a plugin effect is not in it. So adding one from the browser wrote the
 * effect to the layer, bumped the scene revision, re-rendered the stack — and
 * the stack drew nothing for it.
 *
 * From the outside that is indistinguishable from the add having failed, which
 * is exactly how it was reported: "I tried to add the effect and it didn't get
 * added at all." Nothing had failed. The data was correct and one surface
 * refused to draw it.
 *
 * `effects.ts` already documents the rule this broke — "★ Every reader goes
 * through `effectDefFor` rather than through the map" — and lists this precise
 * consequence. The rule was written down and then not followed, which is why
 * this test asserts the BEHAVIOUR rather than the call: a future reader can
 * reintroduce the same bug through a different route, and a test that only
 * spied on `effectDefFor` would not notice.
 */

import { render, screen, cleanup, act } from '@testing-library/react';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { EffectStack } from './EffectStack';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { addEffect, getNodeEffects, effectDefFor } from '@core/effects/effects';
import { registerEffects, unregisterEffects } from '@core/plugins/pluginEffects';

const PLUGIN_ID = 'studio.test.kit';
const EFFECT_TYPE = `${PLUGIN_ID}.spotlight`;
const NODE = 'pluginfx_node';

/** The shape a manifest's `contributes.effects[]` entry has after parsing. */
const CONTRIBUTION = {
  id: 'spotlight',
  label: 'Spotlight',
  params: {
    radius: { type: 'number' as const, label: 'Radius', default: 240, min: 1, max: 4000 },
    strength: { type: 'number' as const, label: 'Strength', default: 1.2, min: 0, max: 4 },
  },
  shader:
    '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {'
    + ' return textureSample(src, samp, uv) * params.strength; }',
};

beforeEach(() => {
  try { defaultSceneGraph.removeNode(NODE); } catch { /* first run */ }
  defaultSceneGraph.addNode({
    id: NODE,
    name: 'Layer',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [],
    visible: true,
    locked: false,
  } as never);
  registerEffects(PLUGIN_ID, 'Test Kit', [CONTRIBUTION] as never);
});

afterEach(async () => {
  cleanup();
  unregisterEffects(PLUGIN_ID);
  try { defaultSceneGraph.removeNode(NODE); } catch { /* already gone */ }
  if (harness) {
    await harness.dispose();
    harness = null;
  }
});

/**
 * Draw the stack of a real LAYER carrying `type` — the panel reads the
 * document mirror (B4), which knows layers the engine built, not a bare node.
 * The effect is the last one on the layer, so its card is the open one.
 */
let harness: (Harness & { engine: LocalEngine }) | null = null;
async function renderStackWith(type: string, beforeRender?: () => void): Promise<void> {
  harness = await setupAppEngine();
  const s = await buildScene(harness);
  await harness.run({ type: 'addEffect', layers: [s.A], effect: type, params: [] });
  beforeRender?.();
  await act(async () => {
    render(<EffectStack nodeId={s.A} />);
    await engineIdle();
  });
}

/**
 * What the stack shows. Plugin effects are labelled with their plugin, so two
 * installed plugins that both ship a "Glow" are told apart in a flat list.
 */
const LABEL = 'Test Kit: Spotlight';

describe('a plugin effect on a layer', () => {
  test('resolves through effectDefFor once its plugin is enabled', () => {
    // Guards the premise of the tests below. If registration itself were broken
    // the render assertions would fail too, and for a different reason.
    expect(effectDefFor(EFFECT_TYPE)?.label).toBe(LABEL);
  });

  test('is written to the layer by addEffect', () => {
    addEffect(NODE, EFFECT_TYPE as never);
    expect(getNodeEffects(NODE).map((e) => e.type)).toEqual([EFFECT_TYPE]);
  });

  test('is DRAWN in the effect stack, not silently skipped', async () => {
    await renderStackWith(EFFECT_TYPE);

    // The regression: the stack rendered the "no effects" hint, or an empty
    // list, while the layer genuinely carried the effect.
    expect(screen.queryByText(/No active effects on this layer/i)).toBeNull();
    expect(screen.getByText(LABEL)).toBeInTheDocument();
  });

  test('its parameters are reachable, not just its name', async () => {
    await renderStackWith(EFFECT_TYPE);

    // A card that renders its title and none of its controls is the same defect
    // one layer down: the effect looks added and cannot be adjusted.
    expect(screen.getByText('Radius')).toBeInTheDocument();
    expect(screen.getByText('Strength')).toBeInTheDocument();
  });

  test('disappears from the stack when its plugin is disabled', async () => {
    await renderStackWith(EFFECT_TYPE, () => unregisterEffects(PLUGIN_ID));
    // Skipping an UNRESOLVABLE effect is correct — that is a disabled or
    // uninstalled plugin, and there is nothing to draw. The bug was doing it to
    // effects that resolve perfectly well.
    expect(screen.queryByText(LABEL)).toBeNull();
  });
});
