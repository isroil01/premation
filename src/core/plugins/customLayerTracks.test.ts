/**
 * Animation on a custom layer, against the real engine.
 *
 * Two properties, and both are about work a user cannot get back.
 *
 * **Keyframes survive a migration.** The uninstall/reinstall round trip was
 * verified in `customLayers.test.ts`; the migration path was not, and it is the
 * more dangerous one — a plugin author ships a bad `onMigrateLayer`, and if the
 * host wipes tracks alongside the values it defaults, every user of that plugin
 * loses their animation. A base value changing is recoverable; a deleted track
 * is not.
 *
 * **A custom prop is an ORDINARY prop.** It is keyed `(nodeId, propPath)` and
 * sampled by the same code that samples `opacity`. Asserted against the real
 * `AnimationEngine` rather than described, because "no special case needed" is
 * a claim about the engine, not about this module.
 */

import { AnimationEngine } from '@motion/animation';
import {
  applyMigration,
  buildCustomLayerComponent,
  customPropPath,
  propNameFromPath,
  readCustomLayer,
  type CustomLayerRecord,
} from './customLayers';
import type { LayerKindContribution } from './layerKindSchema';
import type { SceneNode } from '../types';

const V1: LayerKindContribution = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

const V2: LayerKindContribution = {
  ...V1,
  schemaVersion: 2,
  props: {
    ...V1.props,
    focalMm: { type: 'number', default: 35, min: 8, max: 200 },
  },
};

const PLUGIN = 'studio.acme.lab';
const NODE = 'layer-1';

function nodeWith(component: SceneNode['components'][number]): SceneNode {
  return {
    id: NODE,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [component],
  };
}

/**
 * Apply a migration the way the host will: props only.
 *
 * Written here rather than imported because the host's migration path is
 * B3.1's work — what this asserts is the CONTRACT it has to satisfy, so the
 * test exists before the code that must not break it.
 */
function migrateNode(
  node: SceneNode,
  kind: LayerKindContribution,
  returned: unknown,
): { node: SceneNode; dropped: string[]; quarantine?: unknown } {
  const record = readCustomLayer(node) as CustomLayerRecord;
  const result = applyMigration(kind, returned, record.props);
  const component = node.components[0]!;
  return {
    node: {
      ...node,
      components: [{
        ...component,
        props: { ...component.props, ...result.props, __schemaVersion: kind.schemaVersion },
      }],
    },
    dropped: result.dropped,
    ...(result.quarantine ? { quarantine: result.quarantine } : {}),
  };
}

describe('a custom prop animates like any other', () => {
  it('is sampled by the engine with no special case', () => {
    const engine = new AnimationEngine();
    const path = customPropPath('focal');

    engine.setKeyframe(NODE, path, 0, 20);
    engine.setKeyframe(NODE, path, 1, 80);

    // Interpolated by the same code that interpolates `opacity`. If this
    // needed a branch in the engine, the props are modelled wrong.
    expect(engine.sample(NODE, path, 0)).toBeCloseTo(20, 5);
    expect(engine.sample(NODE, path, 1)).toBeCloseTo(80, 5);
    expect(engine.sample(NODE, path, 0.5)).toBeGreaterThan(20);
    expect(engine.sample(NODE, path, 0.5)).toBeLessThan(80);
  });

  it('cannot collide with a native track of the same name', () => {
    /*
      A plugin is free to declare a prop called `opacity`. Without the prefix
      its track would address the LAYER's opacity — so animating a plugin
      property would silently fade the layer out.
    */
    const engine = new AnimationEngine();
    engine.setKeyframe(NODE, 'opacity', 0, 100);
    engine.setKeyframe(NODE, customPropPath('opacity'), 0, 7);

    expect(engine.sample(NODE, 'opacity', 0)).toBeCloseTo(100, 5);
    expect(engine.sample(NODE, customPropPath('opacity'), 0)).toBeCloseTo(7, 5);
  });

  it('round-trips a path back to its declared name', () => {
    expect(propNameFromPath(customPropPath('focal'))).toBe('focal');
    // A native path is not a custom prop, and must not be read as one.
    expect(propNameFromPath('opacity')).toBeNull();
  });
});

describe('keyframes survive a migration', () => {
  /** A layer with an authored value AND an animation on the same property. */
  function animatedLayer(): { engine: AnimationEngine; node: SceneNode } {
    const engine = new AnimationEngine();
    engine.setKeyframe(NODE, customPropPath('focal'), 0, 20);
    engine.setKeyframe(NODE, customPropPath('focal'), 2, 90);
    const node = nodeWith(buildCustomLayerComponent(PLUGIN, V1, { focal: 72, mode: 'displace' }));
    return { engine, node };
  }

  it('keeps the tracks when the migration succeeds', () => {
    const { engine, node } = animatedLayer();
    const before = engine.getTrackKeyframes(NODE, customPropPath('focal'));

    migrateNode(node, V2, { focalMm: 85 });

    expect(engine.getTrackKeyframes(NODE, customPropPath('focal'))).toEqual(before);
  });

  it('keeps the tracks when the migration FAILS and the value is defaulted', () => {
    /*
      The case that matters. The plugin's `onMigrateLayer` threw; `focal` is
      not mentioned by the new schema's migration, and a prop that fails
      validation lands on its default. If the host cleared the track alongside
      it, a user's animation would be gone because someone else shipped a bug.
    */
    const { engine } = animatedLayer();
    const before = engine.getTrackKeyframes(NODE, customPropPath('focal'));
    expect(before).toHaveLength(2);

    // A migration that returned garbage AND a previous value that no longer
    // validates, so `focal` genuinely falls back to its default.
    const stale = nodeWith(buildCustomLayerComponent(PLUGIN, V1, {}));
    stale.components[0]!.props.focal = 'wide';
    const result = migrateNode(stale, V2, undefined);

    expect(result.node.components[0]!.props.focal).toBe(50);
    expect(result.dropped).toContain('focal');
    // The base value reset. The animation did not.
    expect(engine.getTrackKeyframes(NODE, customPropPath('focal'))).toEqual(before);
    expect(engine.sample(NODE, customPropPath('focal'), 0)).toBeCloseTo(20, 5);
  });

  it('keeps a prop the migration was not about, value and animation together', () => {
    const { engine, node } = animatedLayer();
    const result = migrateNode(node, V2, { focalMm: 85 });

    // Both halves of the same guarantee: the authored 72 stayed, and so did
    // the two keyframes on it.
    expect(result.node.components[0]!.props.focal).toBe(72);
    expect(engine.getTrackKeyframes(NODE, customPropPath('focal'))).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('quarantines the pre-migration values so a reset is recoverable', () => {
    const stale = nodeWith(buildCustomLayerComponent(PLUGIN, V1, {}));
    stale.components[0]!.props.focal = 'wide';
    const result = migrateNode(stale, V2, undefined);

    // Recoverable beats reported. Told only that "some values were reset", a
    // user has nothing to act on.
    expect(result.quarantine).toMatchObject({ schemaVersion: 2 });
    expect((result.quarantine as { props: Record<string, unknown> }).props.focal).toBe('wide');
  });

  it('records the new schema version, so the migration is not run again', () => {
    const { node } = animatedLayer();
    const result = migrateNode(node, V2, { focalMm: 85 });
    expect(result.node.components[0]!.props.__schemaVersion).toBe(2);
  });
});
