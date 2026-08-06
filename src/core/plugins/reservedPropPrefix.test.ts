/**
 * The `plugin.` property prefix, and the other flat-string key spaces it warned
 * about.
 *
 * The prefix exists because a plugin may declare a prop called `opacity`, and
 * tracks are keyed by a concatenated `(nodeId, propPath)` string — so an
 * unprefixed path would have addressed the LAYER's opacity and silently faded
 * it out while the author animated what they thought was their own property.
 *
 * That bug survived design review. It surfaced only because a test drove the
 * real `AnimationEngine` instead of a stub, which is why every assertion in
 * this file does the same: a mock would agree with whatever the code does, and
 * agreement is precisely what a key-collision test must not accept.
 *
 * So this file does two jobs:
 *
 *   1. Closes the collision from the OTHER side. A native property named
 *      `plugin.something` would address a plugin's track, and the symptom would
 *      appear in a plugin nobody was editing.
 *   2. Audits the app's other concatenated key spaces for the same latent
 *      defect, against the real subsystems.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AnimationEngine } from '@motion/animation';
import { CUSTOM_PROP_PREFIX, customPropPath, isReservedPropPath } from './customLayers';

const SRC = join(__dirname, '..', '..');
const NODE = 'layer-1';

describe('the prefix is reserved from both sides', () => {
  it('recognises a reserved path', () => {
    expect(isReservedPropPath(customPropPath('focal'))).toBe(true);
    expect(isReservedPropPath('opacity')).toBe(false);
    // Near-misses that must NOT be treated as reserved.
    expect(isReservedPropPath('plugins.focal')).toBe(false);
    expect(isReservedPropPath('myplugin.focal')).toBe(false);
  });

  it('is not written by any native property path in the tree', () => {
    /*
      A source sweep, because there is no single canonical list of native
      property names to check against — they are written at their call sites.
      What this catches is the future native prop: someone adds
      `setKeyframe(id, 'plugin.blur', …)` years from now, having never read
      this file, and quietly starts writing into a plugin's track.
    */
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
          files.push(full);
        }
      }
    };
    walk(SRC);
    // Floor: a moved directory would empty the sweep into a vacuous pass.
    expect(files.length).toBeGreaterThan(300);

    const offenders = files.filter((file) => {
      // `customLayers.ts` DEFINES the prefix; everything else quoting it as a
      // literal path is writing into the plugin namespace.
      if (file.endsWith(join('core', 'plugins', 'customLayers.ts'))) return false;
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // `plugin.json` is the manifest FILENAME, not a property path — the one
      // legitimate spelling that shares the prefix. Command ids are built as
      // `plugin.${pid}.${id}` template literals, which the `[a-zA-Z]` after the
      // dot already excludes.
      return /['"`]plugin\.[a-zA-Z]/.test(src.replace(/plugin\.json/g, ''));
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))).toEqual([]);
  });
});

describe('the key spaces that are concatenated strings', () => {
  it('keeps a plugin prop and a native prop of the same name apart', () => {
    // The original defect, asserted against the real engine.
    const engine = new AnimationEngine();
    engine.setKeyframe(NODE, 'opacity', 0, 100);
    engine.setKeyframe(NODE, customPropPath('opacity'), 0, 7);

    expect(engine.sample(NODE, 'opacity', 0)).toBeCloseTo(100, 5);
    expect(engine.sample(NODE, customPropPath('opacity'), 0)).toBeCloseTo(7, 5);
    expect(engine.getTrackKeyframes(NODE, 'opacity')).toHaveLength(1);
  });

  it('gives the two DIFFERENT noise phases, so wiggle does not lock them together', () => {
    /*
      `propSeed` is `stringSeed(`${nodeId}:${prop}`)` — another concatenated key,
      and one whose collision is invisible rather than wrong-looking: two
      properties sharing a seed wiggle in perfect lockstep, which reads as a
      style choice rather than a bug.
    */
    const engine = new AnimationEngine();
    engine.setExpression(NODE, 'opacity', 'wiggle(4, 40)');
    engine.setExpression(NODE, customPropPath('opacity'), 'wiggle(4, 40)');

    const native = engine.sample(NODE, 'opacity', 0.37);
    const custom = engine.sample(NODE, customPropPath('opacity'), 0.37);
    expect(native).not.toBeCloseTo(custom as number, 6);
  });

  it('does not let one property s expression cycle-guard block the other', () => {
    // The visited set is keyed `${nodeId}:${prop}` too. If `plugin.opacity` and
    // `opacity` collided there, evaluating one would report a false cycle on
    // the other — an expression that works alone and fails beside its neighbour.
    const engine = new AnimationEngine();
    engine.setKeyframe(NODE, 'opacity', 0, 50);
    engine.setExpression(NODE, customPropPath('opacity'), 'value + 1');

    expect(engine.sample(NODE, 'opacity', 0)).toBeCloseTo(50, 5);
    expect(typeof engine.sample(NODE, customPropPath('opacity'), 0)).toBe('number');
  });

  it('addresses a plugin prop from another layer s expression by its full path', () => {
    /*
      `layer(name, prop)` passes the prop string straight through to the same
      sampler, so a custom prop is reachable from an expression with no new
      surface — which is what makes the parent-binding shape possible at all.
    */
    const engine = new AnimationEngine();
    engine.setKeyframe('parent-1', customPropPath('focal'), 0, 42);
    engine.setLayerResolver((name) => (name === 'Depth' ? 'parent-1' : null));
    engine.setExpression(NODE, 'x', `layer('Depth', '${CUSTOM_PROP_PREFIX}focal')`);

    expect(engine.sample(NODE, 'x', 0)).toBeCloseTo(42, 5);
  });
});
