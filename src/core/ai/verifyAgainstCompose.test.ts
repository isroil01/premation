/**
 * The verifier, run against output from the REAL compose tools.
 *
 * This is the test that would have caught the five false positives in
 * docs/ai-audit.md. `verify.test.ts` checks the checks against hand-built
 * fixtures — useful, but a fixture only proves the verifier does what I assumed
 * the compose tools do. This drives the actual registry against the actual
 * scene graph and asserts the verifier stays quiet, so the two cannot drift
 * apart without a red test.
 *
 * The rule it encodes: **the technique library is the ground truth.** If a
 * check fires on a scene the compose tools built, the check is wrong until
 * proven otherwise — a verifier that fights the library sends the model off to
 * "fix" vetted timing.
 */

import { ToolRegistry } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import { verifyScene } from './verify';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

function bootCommandSystem(): void {
  const services: any = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
}

function resetDocument(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  });
  getCommandSystem().getHistory().clear();
}

let registry: ToolRegistry;

beforeAll(() => {
  bootCommandSystem();
  registry = new ToolRegistry();
  for (const t of buildAiTools()) registry.register(t);
});

beforeEach(resetDocument);

/** Run a list of compose calls, failing loudly if any is rejected. */
async function compose(calls: Array<[string, Record<string, unknown>]>): Promise<ReturnType<typeof createToolContext>> {
  const ctx = createToolContext(new AbortController().signal);
  for (const [name, args] of calls) {
    const res = await registry.execute(name, args, ctx);
    // A rejected call means the scenario is wrong, not that the scene is bad —
    // surface it rather than silently verifying an empty composition. This is
    // how the audit's first run discovered 13 bad argument guesses (and one
    // real defect) instead of reporting a clean pass over nothing.
    if (!res.ok) throw new Error(`${name} rejected: ${res.content}`);
  }
  return ctx;
}

describe('the verifier stays quiet on real compose-tool output', () => {
  it('a staggered card row', async () => {
    // Cards stagger at ~0.10s offsets. The naive verifier called this
    // "simultaneous".
    const ctx = await compose([
      ['add_background', {}],
      ['add_title', { text: 'Three reasons teams choose us' }],
      ['add_cards', { count: 3 }],
    ]);
    expect(verifyScene(ctx)).toEqual([]);
  });

  it('a light sweep — the layer that starts at x = -480 by design', async () => {
    // False positive #1, twice over. The sweep is offscreen at t=0 and travels
    // across; only a time-sampled bounds check gets this right.
    const ctx = await compose([
      ['add_background', {}],
      ['add_title', { text: 'Cadence' }],
      ['add_light_sweep', {}],
    ]);
    expect(verifyScene(ctx)).toEqual([]);
  });

  it('ambient orbs — single-keyframe constants, not entrances', async () => {
    // False positive #2, twice over.
    const ctx = await compose([
      ['add_background', {}],
      ['add_ambient_orbs', {}],
      ['add_title', { text: 'Premium' }],
    ]);
    expect(verifyScene(ctx)).toEqual([]);
  });

  it('every entrance archetype, including blur_resolve', async () => {
    // False positive #3: blur_resolve pairs opacity with an effect param.
    // Covering all six means a new archetype that trips a check fails here.
    for (const entrance of ['rise', 'scale_pop', 'blur_resolve', 'slide_settle', 'mask_wipe', 'char_cascade']) {
      resetDocument();
      const ctx = await compose([
        ['add_background', {}],
        ['add_title', { text: 'Cadence', entrance }],
      ]);
      expect({ entrance, findings: verifyScene(ctx) }).toEqual({ entrance, findings: [] });
    }
  });

  it('a multi-scene piece with a transition and a camera move', async () => {
    // Closest thing here to the audit's run-1 output: three scenes tiling the
    // duration, 19 layers, a transition and a camera move.
    const ctx = await compose([
      // add_scene indexes from 1, not 0 — my first guess said 0 and the
      // registry rejected it. That rejection is the harness working: a schema
      // this strict is why the audit's deterministic layer had zero defects.
      // 15s of scenes needs a 15s composition. Leaving it at the 10s default
      // put scene 3 past the end — which the verifier correctly caught. Kept as
      // a note because it is the exact class of defect these checks exist for.
      ['update_composition', { durationSeconds: 15 }],
      ['define_style', { accent: '#c8a862' }],
      ['add_scene', { index: 1, startSec: 0, durationSec: 5 }],
      ['add_scene', { index: 2, startSec: 5, durationSec: 5 }],
      ['add_scene', { index: 3, startSec: 10, durationSec: 5 }],
      ['add_background', {}],
      ['add_title', { text: 'Cadence', scene: 1 }],
      ['add_cards', { count: 3, scene: 2 }],
      ['add_emblem', { scene: 3 }],
      ['add_transition', { atSec: 5 }],
      ['add_camera_move', {}],
    ]);
    expect(verifyScene(ctx)).toEqual([]);
  });
});
