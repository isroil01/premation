/**
 * Camera techniques, held to the two preconditions a camera actually has.
 *
 * Both failures this file exists to catch are INVISIBLE in a normal review: the
 * emitted calls are all well-formed, the camera layer really is animating, and
 * the render is simply unaffected. Nothing errors.
 *
 *  1. **The subject must be in the camera's space.** The renderer projects a
 *     layer through the scene camera only when its 3D switch is on; everything
 *     else composites flat and is byte-identical whatever the camera does.
 *     `crash_zoom`, `whip_pan` and `handheld_float` shipped without it and could
 *     not move a pixel.
 *  2. **Every call must be accepted by the tool it names.** `emitCamera` set its
 *     lens with `update_layer { focalLength }`, and `update_layer` had no such
 *     property and `additionalProperties: false` — so all six techniques had
 *     their lens silently rejected and ran on the engine default. A slow push
 *     (long lens) and a crash zoom (wide) rendered identically.
 */

import { ALL_TOOL_DEFS, validate } from '@motion/ai-tools';
import { resolvePack } from '@motion/design-system';
import { TECHNIQUES } from './registry';
import type { EmitContext, TechniqueDef } from './schema';

const DEFS = new Map(ALL_TOOL_DEFS.map((d) => [d.name, d]));
const CAMERA_TECHNIQUES = TECHNIQUES.filter((t) => t.category === 'camera');

function contextFor(): EmitContext {
  return {
    startMs: 0,
    durationMs: 6000,
    frameMs: 1000 / 30,
    width: 1920,
    height: 1080,
    pack: resolvePack('apple_keynote') as never,
    targets: {
      headline: ['h0'],
      subhead: ['s0'],
      support: ['sp0'],
      media: ['m0'],
      background: ['bg0'],
      mark: ['k0'],
      stat: ['st0'],
      cta: ['c0'],
      rule: ['r0'],
    },
    idPrefix: 't',
  };
}

function emitOf(t: TechniqueDef) {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t.params ?? {})) params[k] = (v as { default: unknown }).default;
  return t.emit(contextFor(), params as never, 1);
}

describe('camera techniques', () => {
  it('there are camera techniques to check', () => {
    // Guards the whole file: a filter that silently matched nothing would make
    // every assertion below vacuously true.
    expect(CAMERA_TECHNIQUES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(CAMERA_TECHNIQUES.map((t) => [t.id, t] as const))(
    '%s puts its subject in the camera space',
    (_id, t) => {
      const calls = emitOf(t);
      const madeThreeD = calls
        .filter((c) => c.name === 'update_layer' && c.args.threeD === true)
        .map((c) => String(c.args.nodeId));
      // The camera layer itself does not count — it is the viewpoint, not the
      // subject. A technique that only switched the camera to 3D would pass a
      // naive check and still render nothing.
      const subjects = madeThreeD.filter((id) => !/cam/i.test(id));
      expect(`${t.id}: ${subjects.length} subject(s) in camera space`).not.toBe(
        `${t.id}: 0 subject(s) in camera space`,
      );
    },
  );

  it.each(CAMERA_TECHNIQUES.map((t) => [t.id, t] as const))(
    '%s emits only calls its tools accept',
    (_id, t) => {
      const rejected: string[] = [];
      for (const c of emitOf(t)) {
        const def = DEFS.get(c.name);
        if (!def) { rejected.push(`${c.name}: no such tool`); continue; }
        const r = validate(def.inputSchema as never, c.args);
        if (!r.ok) rejected.push(`${c.name}: ${r.errors.join(' | ')}`);
      }
      expect(`${t.id}: ${rejected.join(' ;; ')}`).toBe(`${t.id}: `);
    },
  );

  it('chooses a real lens, and not the same one every time', () => {
    // Focal length is the first decision a camera operator makes. If every
    // technique resolved to one value the lens vocabulary would be decorative.
    const focals = new Set<number>();
    for (const t of CAMERA_TECHNIQUES) {
      for (const c of emitOf(t)) {
        if (c.name === 'update_layer' && typeof c.args.focalLength === 'number') {
          focals.add(c.args.focalLength);
        }
      }
    }
    expect(focals.size).toBeGreaterThan(1);
  });

  it('creates exactly one camera per technique', () => {
    // `exclusiveResource: 'camera'` stops two techniques both claiming it; this
    // is the other half — one technique must not create two.
    for (const t of CAMERA_TECHNIQUES) {
      const cameras = emitOf(t).filter((c) => c.name === 'create_layer' && c.args.kind === 'camera');
      expect(`${t.id}: ${cameras.length}`).toBe(`${t.id}: 1`);
    }
  });
});
