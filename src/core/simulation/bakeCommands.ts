/**
 * `dynamics.bakePhysics` / `dynamics.bakeParticles` — the bake as commands.
 *
 * Registered on IMPORT rather than from the boot sequence, the same shape
 * `smartAnimateCommands` uses: the registry treats `register` as idempotent, so
 * a module that registers when it loads cannot double-register, and the feature
 * needs no edit to `Providers.tsx` or `menuModel.ts` to become reachable. The
 * Inspector sections import this file, which is what makes it run.
 *
 * ── What a command bakes, versus what the button bakes ──────────────────────
 *
 * The BUTTON opens a dialog: range and sample step are genuine choices and a
 * bake is not cheap to undo-and-redo by hand. The COMMAND takes no arguments —
 * a command palette entry that popped a modal would be a worse version of the
 * button — so it bakes the DEFAULTS the dialog opens with: the work area when
 * one is set, otherwise the whole composition, every frame, no simplification.
 * That is the honest reading of "bake this", and every other shape is one
 * dialog away.
 *
 * Both report through a notification rather than silently: a bake changes what
 * is driving a layer, and a user who cannot tell whether it ran will run it
 * twice.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getTimelineController } from '@core/timeline/TimelineController';
import { readNodePhysics } from './physicsBodies';
import { readNodeParticle } from '@core/particles/particleSim';
import {
  bakeParticlesToLayers,
  bakePhysicsToKeyframes,
  DEFAULT_PARTICLE_BAKE_CAP,
  type BakeRangeOptions,
} from './bakeDynamics';

export const BAKE_PHYSICS_COMMAND = asCommandId('dynamics.bakePhysics');
export const BAKE_PARTICLES_COMMAND = asCommandId('dynamics.bakeParticles');

/**
 * The range a bake opens with: the WORK AREA when one is set, else the whole
 * composition.
 *
 * The work area is this app's existing answer to "the part of the timeline I am
 * working on" (AE's B/N), so a bake that ignored it would make the user set the
 * same range twice in two different vocabularies.
 */
export function defaultBakeRange(): BakeRangeOptions {
  const controller = getTimelineController();
  const fps = controller.fps || 30;
  const work = controller.getWorkArea();
  return {
    from: work ? work.start : 0,
    to: work ? work.end : controller.durationSeconds,
    fps,
    everyNFrames: 1,
  };
}

const toast = (level: 'info' | 'success' | 'warning', message: string): void => {
  try {
    useUIStore.getState().notify({ level, message, durationMs: 5000 });
  } catch {
    /* headless — the bake still happened, which is the part that matters */
  }
};

/** Selected layers carrying an ENABLED body. Empty means nothing to bake. */
export function selectedPhysicsLayers(): string[] {
  return useSelectionStore
    .getState()
    .ids.filter((id) => readNodePhysics(defaultSceneGraph.getNode(id)) !== null);
}

/** Selected layers that are particle emitters. */
export function selectedEmitterLayers(): string[] {
  return useSelectionStore.getState().ids.filter((id) => {
    const node = defaultSceneGraph.getNode(id);
    return !!node && readNodeParticle(node) !== null;
  });
}

/** Run the physics bake and report it. Shared by the command and the dialog. */
export function runPhysicsBake(nodeIds: ReadonlyArray<string>, opts: BakeRangeOptions): void {
  const result = bakePhysicsToKeyframes(nodeIds, opts);
  if (!result) {
    toast('warning', 'Nothing to bake: select a layer with an enabled DYNAMIC rigid body.');
    return;
  }
  toast(
    'success',
    `Baked ${result.nodeIds.length} layer${result.nodeIds.length === 1 ? '' : 's'} to `
    + `${result.keyframes} keyframes over ${result.frames} frames. Physics is now off on `
    + `${result.nodeIds.length === 1 ? 'it' : 'them'}.`,
  );
}

/** Run the particle bake and report it — including the cap, which is a refusal
 *  the user has to know about, not a detail. */
export function runParticleBake(
  emitterNodeId: string,
  opts: BakeRangeOptions & { maxParticles?: number },
): void {
  const result = bakeParticlesToLayers(emitterNodeId, opts);
  if (!result) {
    toast('warning', 'Nothing to bake: that layer is not a particle emitter, or the range is empty.');
    return;
  }
  const capped = result.capped
    ? ` ${result.seen} particles were alive in this range and only the first `
      + `${result.layerIds.length} were baked — raise the cap or shorten the range.`
    : '';
  toast(
    result.capped ? 'warning' : 'success',
    `Baked ${result.layerIds.length} particle layers (${result.keyframes} keyframes). `
    + `The emitter is hidden and the layers are parented under a new null.${capped}`,
  );
}

const bakePhysics: Command = {
  id: BAKE_PHYSICS_COMMAND,
  label: 'Bake Physics to Keyframes',
  description: 'Convert the selected rigid bodies\' simulation into editable keyframes and turn physics off',
  enabled: () => selectedPhysicsLayers().length > 0,
  execute: () => {
    const ids = selectedPhysicsLayers();
    if (ids.length === 0) {
      toast('warning', 'Select a layer with a rigid body first.');
      return;
    }
    runPhysicsBake(ids, defaultBakeRange());
  },
};

const bakeParticles: Command = {
  id: BAKE_PARTICLES_COMMAND,
  label: 'Bake Particles to Layers',
  description: 'Convert the selected emitter\'s particles into one keyframed layer each',
  enabled: () => selectedEmitterLayers().length > 0,
  execute: () => {
    const id = selectedEmitterLayers()[0];
    if (!id) {
      toast('warning', 'Select a particle emitter first.');
      return;
    }
    runParticleBake(id, { ...defaultBakeRange(), maxParticles: DEFAULT_PARTICLE_BAKE_CAP });
  },
};

/** Idempotent: re-importing (or an HMR reload) replaces rather than duplicates. */
/** The two commands, for `buildStaticCommands` — the menu test resolves ids there. */
export function buildBakeCommands(): ReadonlyArray<Command> {
  return [bakePhysics, bakeParticles];
}

export function registerBakeCommands(): void {
  const registry = getCommandRegistry();
  registry.register(bakePhysics);
  registry.register(bakeParticles);
}

registerBakeCommands();
