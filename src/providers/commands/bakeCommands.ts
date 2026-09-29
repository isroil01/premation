/**
 * `dynamics.bakePhysics` / `dynamics.bakeParticles` — the bakes as palette
 * commands (B4 round 8: the engine's `physicsBake` / `particleBake` jobs,
 * layout/Inspector/bakeEdits.ts).
 *
 * The BUTTON (the Inspector sections' bake dialog) asks for a range and a
 * sample step. The COMMAND takes no arguments — a palette entry that popped a
 * modal would be a worse version of the button — so it bakes the DEFAULTS the
 * dialog opens with: the work area, every frame, no simplification.
 *
 * What is selected is read from the document mirror: a layer's `layer/physics`
 * field (an enabled body) and a layer's kind (an emitter). The engine re-checks
 * (only enabled DYNAMIC bodies bake) and says so when there is nothing to bake.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { jsonField } from '@core/mirror/layerFields';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { DEFAULT_PARTICLE_BAKE_CAP, mirrorBakeRange, runParticleBake, runPhysicsBake } from '@layout/Inspector/bakeEdits';

export const BAKE_PHYSICS_COMMAND = asCommandId('dynamics.bakePhysics');
export const BAKE_PARTICLES_COMMAND = asCommandId('dynamics.bakeParticles');

const warn = (message: string): void => {
  try {
    useUIStore.getState().notify({ level: 'warning', message, durationMs: 5000 });
  } catch {
    /* headless */
  }
};

/** Selected layers carrying an ENABLED body (the mirror's `layer/physics`). */
export function selectedPhysicsLayers(): string[] {
  const m = documentMirror();
  return useSelectionStore.getState().ids.filter((id) => jsonField<{ enabled?: boolean }>(m, id, 'layer/physics')?.enabled === true);
}

/** Selected layers that are particle emitters. */
export function selectedEmitterLayers(): string[] {
  const m = documentMirror();
  return useSelectionStore.getState().ids.filter((id) => m.layer(id)?.kind === 'particle');
}

const defaultRange = () => {
  const m = documentMirror();
  const id = activeCompIdNow();
  return mirrorBakeRange(id ? m.comp(id) : undefined);
};

export function buildBakeCommands(): ReadonlyArray<Command> {
  return [
    {
      id: BAKE_PHYSICS_COMMAND,
      label: 'Bake Physics to Keyframes',
      description: 'Convert the selected rigid bodies\' simulation into editable keyframes and turn physics off',
      enabled: () => selectedPhysicsLayers().length > 0,
      execute: () => {
        const ids = selectedPhysicsLayers();
        if (ids.length === 0) {
          warn('Select a layer with a rigid body first.');
          return;
        }
        void runPhysicsBake(ids, defaultRange());
      },
    },
    {
      id: BAKE_PARTICLES_COMMAND,
      label: 'Bake Particles to Layers',
      description: 'Convert the selected emitter\'s particles into one keyframed layer each',
      enabled: () => selectedEmitterLayers().length > 0,
      execute: () => {
        const id = selectedEmitterLayers()[0];
        if (!id) {
          warn('Select a particle emitter first.');
          return;
        }
        void runParticleBake(id, { ...defaultRange(), maxParticles: DEFAULT_PARTICLE_BAKE_CAP });
      },
    },
  ];
}
