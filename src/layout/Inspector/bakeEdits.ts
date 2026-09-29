/**
 * Bake Physics to Keyframes / Bake Particles to Layers — the engine's
 * `physicsBake` / `particleBake` jobs (B4 round 8, kind_dynamics_bake.cpp):
 * the renderer's own solvers sampled over the range, written as ONE history
 * entry. Shared by the Inspector's bake dialogs and the palette commands.
 *
 * Both report through a notification rather than silently: a bake changes what
 * is driving a layer, and a user who cannot tell whether it ran will run it
 * twice.
 */

import { flicksToSeconds, secondsToFlicks } from '@motion/engine-api';
import { requireEngineJob, runEngineJob } from '@core/engine/engineJobs';
import { useUIStore } from '@stores/uiStore';
import { compFps, type MirrorComp } from '@hooks/useMirror';
import { DEFAULT_PARTICLE_BAKE_CAP } from '@core/simulation/bakeDynamics';

/** The range a bake covers: composition seconds (`to` inclusive), sampled every `everyNFrames`th frame. */
export interface BakeRange {
  from: number;
  to: number;
  fps: number;
  everyNFrames?: number;
  /** Douglas-Peucker tolerance in value units (px, degrees); 0 keeps every sample. */
  simplifyTolerance?: number;
}

/** The layer cap a particle bake opens with. */
export { DEFAULT_PARTICLE_BAKE_CAP };

/**
 * The range a bake opens with, from the document mirror: the composition's
 * WORK AREA (which the document states as the whole composition when none is
 * set), every frame. The work area is this app's answer to "the part of the
 * timeline I am working on" (AE's B/N), so a bake that ignored it would make
 * the user set the same range twice.
 */
export function mirrorBakeRange(comp: MirrorComp | undefined): BakeRange {
  const s = comp?.settings;
  const fps = compFps(comp);
  const from = s ? flicksToSeconds(s.workArea.start) : 0;
  const to = s ? flicksToSeconds(s.workArea.start + s.workArea.duration) : 0;
  return { from, to, fps, everyNFrames: 1 };
}

const toast = (level: 'info' | 'success' | 'warning', message: string): void => {
  try {
    useUIStore.getState().notify({ level, message, durationMs: 5000 });
  } catch {
    /* headless — the bake still happened, which is the part that matters */
  }
};

const rangeOf = (r: BakeRange) => ({
  range: { start: secondsToFlicks(Math.max(0, Math.min(r.from, r.to))), duration: secondsToFlicks(Math.abs(r.to - r.from)) },
  ...(r.everyNFrames && r.everyNFrames > 1 ? { everyNFrames: Math.round(r.everyNFrames) } : {}),
  ...(r.simplifyTolerance && r.simplifyTolerance > 0 ? { simplifyTolerance: r.simplifyTolerance } : {}),
});

const failed = (err: unknown): void => {
  toast('warning', `Bake failed: ${err instanceof Error ? err.message : String(err)}`);
};

export interface PhysicsBakeSummary { layers: string[]; frames: number; tracks: number; keyframes: number }

/** Bake the rigid bodies on `layers` and switch their physics off; reports it. */
export async function runPhysicsBake(layers: ReadonlyArray<string>, opts: BakeRange): Promise<PhysicsBakeSummary | null> {
  try {
    const out = requireEngineJob(
      await runEngineJob<PhysicsBakeSummary>({ kind: 'physicsBake', value: { layers: [...layers], ...rangeOf(opts) } }),
      'Bake Physics to Keyframes',
    );
    if (out.status !== 'done' || !out.result) {
      if (out.status === 'failed') failed(new Error(out.error?.message ?? 'the engine could not bake'));
      return null;
    }
    const n = out.result.layers.length;
    toast('success', `Baked ${n} layer${n === 1 ? '' : 's'} to ${out.result.keyframes} keyframes over ${out.result.frames} frames. `
      + `Physics is now off on ${n === 1 ? 'it' : 'them'}.`);
    return out.result;
  } catch (err) {
    failed(err);
    return null;
  }
}

export interface ParticleBakeSummary { containerId: string; layerIds: string[]; seen: number; capped: boolean; keyframes: number }

/** Bake an emitter's particles to one layer each under a new null, the emitter hidden; reports it — the cap included. */
export async function runParticleBake(emitter: string, opts: BakeRange & { maxParticles?: number }): Promise<ParticleBakeSummary | null> {
  try {
    const out = requireEngineJob(
      await runEngineJob<ParticleBakeSummary>({
        kind: 'particleBake',
        value: { layer: emitter, ...rangeOf(opts), maxParticles: Math.max(1, Math.round(opts.maxParticles ?? DEFAULT_PARTICLE_BAKE_CAP)) },
      }),
      'Bake Particles to Layers',
    );
    if (out.status !== 'done' || !out.result) {
      if (out.status === 'failed') failed(new Error(out.error?.message ?? 'the engine could not bake'));
      return null;
    }
    const r = out.result;
    const capped = r.capped
      ? ` ${r.seen} particles were alive in this range and only the first ${r.layerIds.length} were baked — raise the cap or shorten the range.`
      : '';
    toast(r.capped ? 'warning' : 'success', `Baked ${r.layerIds.length} particle layers (${r.keyframes} keyframes). `
      + `The emitter is hidden and the layers are parented under a new null.${capped}`);
    return r;
  } catch (err) {
    failed(err);
    return null;
  }
}
