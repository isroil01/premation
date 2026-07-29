/**
 * One camera per composition, and every camera on a chosen lens.
 *
 * ## The bug this closes
 *
 * All five camera techniques emit their own `create_layer { kind: 'camera' }`,
 * and `readSceneCamera` (src/core/scene/camera3d.ts) returns the FIRST camera it
 * finds in the graph. Casting two of them therefore leaves a second camera layer
 * whose entire animation is ignored — and there is no visual symptom to notice,
 * because the second move simply never happens.
 *
 * Pairwise `neverWith` was the guard, and it covered four of the ten camera
 * pairs. `crash_zoom + whip_pan` and `drift_parallax + handheld_float` were both
 * castable. That is the same failure the pack `forbid` list had: a hand-written
 * list of pairs is correct until someone adds the next technique, and the tenth
 * pair is the one nobody checks.
 *
 * So the guard is now a declared claim (`exclusiveResource`) enforced in one
 * place, and this test asserts the property rather than the pairs.
 */

import { TECHNIQUES, candidates, resourceTakenBy } from './registry';
import { LENSES, type LensName } from './emit';
import { resolvePack } from '@motion/design-system';
import { coerceParams, type EmitContext } from './schema';

const CAMERA_TECHNIQUES = TECHNIQUES.filter((t) => t.category === 'camera');

function contextFor(packId: string): EmitContext {
  return {
    startMs: 0,
    durationMs: 4000,
    frameMs: 1000 / 30,
    width: 1920,
    height: 1080,
    pack: resolvePack(packId),
    targets: {
      headline: ['hl_0'],
      media: ['media_0'],
      background: ['bg_0'],
      mark: ['mark_0'],
      camera: [],
    },
    idPrefix: 'tst',
  };
}

/** Every `create_layer { kind: 'camera' }` a technique emits. */
function cameraCreations(t: (typeof TECHNIQUES)[number]) {
  const ctx = contextFor('apple_keynote');
  const calls = t.emit(ctx, coerceParams(t.params, {}).value, 0);
  return calls.filter((c) => c.name === 'create_layer' && (c.args as { kind?: string }).kind === 'camera');
}

describe('the composition has exactly one camera', () => {
  it('found the camera techniques at all', () => {
    // Guards every assertion below from passing vacuously on an empty list.
    expect(CAMERA_TECHNIQUES.length).toBeGreaterThanOrEqual(5);
  });

  it('every technique that creates a camera claims the camera', () => {
    // The direction that matters: a NEW camera technique added without the
    // claim is exactly the case pairwise `neverWith` kept missing.
    for (const t of TECHNIQUES) {
      if (!cameraCreations(t).length) continue;
      expect(`${t.id} claims: ${t.exclusiveResource ?? 'nothing'}`).toBe(`${t.id} claims: camera`);
    }
  });

  it('no technique creates more than one camera by itself', () => {
    for (const t of CAMERA_TECHNIQUES) {
      expect(`${t.id}: ${cameraCreations(t).length}`).toBe(`${t.id}: 1`);
    }
  });

  it('every camera pair is guarded — including the two `neverWith` missed', () => {
    for (const a of CAMERA_TECHNIQUES) {
      for (const b of CAMERA_TECHNIQUES) {
        if (a.id === b.id) continue;
        expect(`${b.id} after ${a.id}: ${resourceTakenBy(b, [a.id]) ?? 'ALLOWED'}`).toBe(
          `${b.id} after ${a.id}: ${a.id}`,
        );
      }
    }
  });

  it('a second camera technique is never even offered', () => {
    // Enforced at candidate time as well as at validation, so the model does not
    // spend a pick on something that will be rejected.
    const first = CAMERA_TECHNIQUES[0]!;
    const offered = candidates({
      pack: { id: 'apple_keynote', prefer: [], forbid: [] },
      slotDurationMs: 6000,
      energy: 0.5,
      availableRoles: ['headline', 'media', 'background', 'mark', 'camera'],
      alreadyCast: [first.id],
    }).map((c) => c.id);
    expect(offered.filter((id) => CAMERA_TECHNIQUES.some((t) => t.id === id))).toEqual([]);
  });

  it('a non-camera technique is unaffected by the claim', () => {
    // The rule must not become a blanket ban on casting anything after a camera.
    const first = CAMERA_TECHNIQUES[0]!;
    const entrance = TECHNIQUES.find((t) => t.category === 'entrance')!;
    expect(resourceTakenBy(entrance, [first.id])).toBeUndefined();
  });
});

describe('every camera is on a chosen lens', () => {
  it('sets focalLength explicitly — never the engine default', () => {
    // Focal length is the first decision a camera operator makes and it changes
    // a shot more than the move does. Taking the default meant a contemplative
    // push and a crash zoom were shot on the same lens.
    for (const t of CAMERA_TECHNIQUES) {
      const ctx = contextFor('apple_keynote');
      const calls = t.emit(ctx, coerceParams(t.params, {}).value, 0);
      const camId = (calls.find((c) => c.name === 'create_layer' && (c.args as { kind?: string }).kind === 'camera')
        ?.args as { id?: string })?.id;
      const lensCall = calls.find(
        (c) => c.name === 'update_layer' && (c.args as { nodeId?: string }).nodeId === camId
          && typeof (c.args as { focalLength?: number }).focalLength === 'number',
      );
      expect(`${t.id} sets a lens: ${Boolean(lensCall)}`).toBe(`${t.id} sets a lens: true`);
    }
  });

  it('the lens is a real focal length for the frame, not an arbitrary number', () => {
    const values = Object.values(LENSES);
    for (const t of CAMERA_TECHNIQUES) {
      const ctx = contextFor('apple_keynote');
      const calls = t.emit(ctx, coerceParams(t.params, {}).value, 0);
      const f = calls
        .map((c) => (c.args as { focalLength?: number }).focalLength)
        .find((v): v is number => typeof v === 'number');
      expect(f).toBeDefined();
      const ratio = f! / Math.max(ctx.width, ctx.height);
      // Must match one of the named lenses, within rounding.
      expect(values.some((v) => Math.abs(v - ratio) < 0.01)).toBe(true);
    }
  });

  it('the techniques do not all pick the same lens', () => {
    // A vocabulary nobody varies is a constant with extra steps. A push and a
    // crash zoom are opposite decisions and must not share a focal length.
    const chosen = new Set<number>();
    for (const t of CAMERA_TECHNIQUES) {
      const ctx = contextFor('apple_keynote');
      const f = t
        .emit(ctx, coerceParams(t.params, {}).value, 0)
        .map((c) => (c.args as { focalLength?: number }).focalLength)
        .find((v): v is number => typeof v === 'number');
      if (f !== undefined) chosen.add(f);
    }
    expect(chosen.size).toBeGreaterThanOrEqual(3);
  });

  it('the lens scales with the frame, so the look survives a portrait comp', () => {
    const t = CAMERA_TECHNIQUES[0]!;
    const wide = { ...contextFor('apple_keynote'), width: 1920, height: 1080 };
    const tall = { ...contextFor('apple_keynote'), width: 1080, height: 1920 };
    const focal = (ctx: EmitContext): number | undefined =>
      t.emit(ctx, coerceParams(t.params, {}).value, 0)
        .map((c) => (c.args as { focalLength?: number }).focalLength)
        .find((v): v is number => typeof v === 'number');
    // Same larger dimension, so the same lens — a hardcoded px value would not
    // have this property and would be a different lens on every comp size.
    expect(focal(wide)).toBe(focal(tall));
  });

  it('names every lens in the vocabulary', () => {
    const names: LensName[] = ['wide', 'normal', 'portrait', 'long'];
    for (const n of names) expect(typeof LENSES[n]).toBe('number');
    // Ordered shortest to longest — the table reads as a lens kit.
    expect(LENSES.wide).toBeLessThan(LENSES.normal);
    expect(LENSES.normal).toBeLessThan(LENSES.portrait);
    expect(LENSES.portrait).toBeLessThan(LENSES.long);
  });
});
