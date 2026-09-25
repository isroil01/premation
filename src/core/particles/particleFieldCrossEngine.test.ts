/**
 * Cross-engine parity of the particle FIELD (plan D2w time/comp).
 *
 * `native/engine/src/scene/particle_port.cpp` ports the particle system — the
 * closed-form emitter (particleSim.ts), the frame-stepping one
 * (statefulParticleSim.ts), the fields (particleField.ts) and the Canvas2D
 * field (particleRender.ts drawParticleField, with plexus.ts drawPlexusLinks).
 * This test draws configs covering every branch onto the recording canvas and
 * stores each Canvas2D program in `native/engine/tests/data/particle_parity.json`;
 * `native/engine/tests/test_particle_parity.cpp` requires the C++ to issue the
 * same program op for op (every position, size, colour string and composite).
 *
 * `GEN_NATIVE_PARTICLES=1 npx jest particleFieldCrossEngine` rewrites the
 * fixture; without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/particle_parity.json');

type Rec = typeof import('@core/rendering/raster/__testHelpers__/recordingCanvas');

interface Case { name: string; cfg: Partial<ParticleConfig>; times: number[]; w: number; h: number; scale: number; fps?: number }

const CASES: Case[] = [
  {
    name: 'ballistic sphere: drag, mid ramps, continuous sub-emit, perspective',
    w: 320, h: 240, scale: 1, times: [0.5, 1],
    cfg: {
      emitterType: 'sphere', emitterWidth: 60, birthRate: 60, lifetime: 1.2, lifetimeRandom: 0.3, speed: 220,
      speedRandom: 0.4, direction: -90, spread: 70, gravityY: 260, drag: 1.4, spin: 90, seed: 3,
      sizeStart: 3, sizeMid: 14, sizeEnd: 0, midAge: 0.35, colorStart: '#fff3b0', colorMid: '#ff8a2a', colorEnd: '#7a1e00',
      opacityStart: 1, opacityMid: 0.9, opacityEnd: 0, shape: 'circle', blend: 'add', perspective: 600, speedZ: 120,
      subEmit: 'continuous', subRate: 6, subLifetime: 0.4, subSpeed: 40, subSizeScale: 0.4,
    },
  },
  {
    name: 'box emitter: squares, stars, death bursts, wind, turbulence wander, trails',
    w: 300, h: 220, scale: 1.5, times: [0.7, 1.6],
    cfg: {
      emitterType: 'box', emitterWidth: 120, emitterHeight: 30, birthRate: 25, lifetime: 0.9, speed: 140, spread: 120,
      gravityY: 120, windX: 40, turbulence: 18, turbulenceSpeed: 1.3, spin: 45, seed: 11, shape: 'square', blend: 'normal',
      trailLength: 4, trailSpacing: 1 / 20, subEmit: 'death', subCount: 5, subSpeed: 90, subLifetime: 0.5,
      colorStart: '#44ccff', colorEnd: '#fff',
    },
  },
  {
    name: 'circle emitter: stars with velocity streaks (shutter)',
    w: 280, h: 200, scale: 2, times: [0.9],
    cfg: {
      emitterType: 'circle', emitterWidth: 80, birthRate: 30, lifetime: 1.4, speed: 200, spread: 360, gravityY: 0,
      shape: 'star', sizeStart: 12, sizeEnd: 6, motionBlur: 0.8, shutterSec: 1 / 60, seed: 5, blend: 'add',
    },
  },
  {
    name: 'lines and plexus with triangles',
    w: 260, h: 260, scale: 1, times: [1.2],
    cfg: {
      emitterType: 'box', emitterWidth: 200, emitterHeight: 200, birthRate: 40, lifetime: 2, speed: 20, spread: 360,
      gravityY: 0, shape: 'line', sizeStart: 8, sizeEnd: 8, seed: 9, blend: 'normal',
      plexusDistance: 70, plexusWidth: 1.5, plexusOpacity: 0.7, plexusColor: '#a0e0ff', plexusTriangles: true, plexusTriangleOpacity: 0.2,
    },
  },
  {
    name: 'sprite shape with no image draws circles; sheet frames by rate',
    w: 200, h: 200, scale: 1, times: [0.8],
    cfg: { birthRate: 20, shape: 'sprite', spriteFrames: 4, spriteFps: 12, seed: 2 },
  },
  {
    name: 'stateful: floor bounce, curl turbulence, collisions, bounce bursts, trails',
    w: 320, h: 260, scale: 1, times: [0.4, 1.1, 2.0], fps: 30,
    cfg: {
      simMode: 'stateful', maxParticles: 120, birthRate: 50, lifetime: 1.6, speed: 160, spread: 60, direction: -80,
      gravityY: 420, bounceFloor: 90, bounceRestitution: 0.6, bounceDamping: 0.99, turbulence: 60, turbulenceScale: 80,
      collide: true, collideRestitution: 0.5, subEmit: 'bounce', subCount: 3, subSpeed: 60, subLifetime: 0.3,
      trailLength: 3, trailSpacing: 1 / 15, drag: 0.4, seed: 21, sizeStart: 8, sizeEnd: 3, motionBlur: 0.5, shutterSec: 1 / 60,
    },
  },
  {
    name: 'stateful: death bursts at a capped pool',
    w: 240, h: 200, scale: 1, times: [1.5], fps: 24,
    cfg: { simMode: 'stateful', maxParticles: 40, birthRate: 30, lifetime: 0.5, subEmit: 'death', subCount: 4, seed: 4, emitterType: 'circle', emitterWidth: 50 },
  },
];

function generate(): unknown[] {
  const out: unknown[] = [];
  for (const c of CASES) {
    for (const time of c.times) {
      jest.isolateModules(() => {
        const rec = require('@core/rendering/raster/__testHelpers__/recordingCanvas') as Rec;
        const { drawParticleField } = require('./particleRender') as typeof import('./particleRender');
        const cfg = { ...DEFAULT_PARTICLE_CONFIG, ...c.cfg } as ParticleConfig;
        const fps = c.fps ?? 30;
        const pxW = Math.max(1, Math.round(c.w * c.scale));
        const pxH = Math.max(1, Math.round(c.h * c.scale));
        const key = `particles:${c.name}`;
        const ops = rec.beginRecording();
        const { ctx } = rec.recordingCanvas(pxW, pxH);
        rec.withRecordingCanvases(() => {
          drawParticleField(ctx as unknown as CanvasRenderingContext2D, cfg, time, c.w, c.h, c.scale, { fps, cacheKey: key });
        });
        out.push({
          name: `${c.name} @ ${time}`,
          pxW, pxH,
          spec: { cfg, time, w: c.w, h: c.h, scale: c.scale, fps, key },
          ops: ops.map((op) => JSON.stringify(op)),
        });
      });
    }
  }
  return out;
}

test('the C++ particle-field parity fixture matches particleRender.ts', () => {
  const cases = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/particles/particleFieldCrossEngine.test.ts (GEN_NATIVE_PARTICLES=1). Do not edit.', cases })}\n`;
  if (process.env.GEN_NATIVE_PARTICLES === '1') {
    writeFileSync(OUT, text);
  } else {
    expect(existsSync(OUT)).toBe(true);
    expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
  }
  // Every case draws something (a vacuous program pins nothing).
  for (const c of cases as Array<{ name: string; ops: string[] }>) expect(c.ops.length).toBeGreaterThan(20);
});
