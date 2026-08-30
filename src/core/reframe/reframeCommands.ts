/**
 * Auto-reframe, as one command per target shape.
 *
 * A dialog was the obvious alternative and is worse here. The only choice to
 * make is the aspect, there are five of them, and a command per shape means the
 * whole feature is reachable by typing "9:16" into the palette — while a dialog
 * would add a modal, a state machine and a progress surface to a command whose
 * entire input is one enum. The repo already does exactly this for multicam
 * angles.
 *
 * Progress goes to a toast rather than a bar. The analysis pass is a real
 * render, so it is not instant on a long comp, and a person who started it
 * needs to know it is running — but it is also not the kind of wait anyone
 * watches, so it does not earn a dialog either.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import {
  ASPECT_PRESETS,
  AutoReframeError,
  autoReframeComposition,
  targetSizeFor,
  type AspectPreset,
} from './autoReframe';

/** The composition a reframe would act on, or undefined. */
function activeComp(): { id: string; width: number; height: number } | undefined {
  const project = useProjectStore.getState();
  const id = project.activeTabId ? project.tabs[project.activeTabId]?.compositionId : undefined;
  const comp = id ? project.comps[id] : undefined;
  return comp ? { id: comp.id, width: comp.width, height: comp.height } : undefined;
}

/**
 * Whether reframing to `preset` would do anything.
 *
 * A composition already at the target aspect has no slack to pan in, so the
 * result would be a copy of itself wrapped in a layer. Disabled rather than
 * allowed-and-pointless: the command's own name promises a reframe.
 */
function worthReframing(preset: AspectPreset): boolean {
  const comp = activeComp();
  if (!comp) return false;
  const current = comp.width / comp.height;
  // A percent of tolerance, so 1920×1080 counts as 16:9 and 1998×1080 does not
  // silently count as something else.
  return Math.abs(current - preset.ratio) / preset.ratio > 0.01;
}

async function reframeTo(preset: AspectPreset): Promise<void> {
  const comp = activeComp();
  if (!comp) return;
  const target = targetSizeFor(comp, preset.ratio);

  const ui = useUIStore.getState();
  ui.notify({
    level: 'info',
    message: `Analysing the composition for a ${preset.label} reframe…`,
    durationMs: 3000,
  });

  try {
    const result = await autoReframeComposition({ sourceCompId: comp.id, target });
    ui.notify({
      level: 'success',
      message:
        `Reframed to ${target.width}×${target.height} — ${result.cuts} shot change(s), `
        + `${result.keyframes} keyframe(s). The original is untouched.`,
      durationMs: 6000,
    });
  } catch (err) {
    useUIStore.getState().notify({
      level: 'error',
      message: err instanceof AutoReframeError ? err.message : `Auto-reframe failed: ${String(err)}`,
      durationMs: 8000,
    });
  }
}

/** Every auto-reframe command, for `buildStaticCommands`. */
export function buildReframeCommands(): ReadonlyArray<Command> {
  return ASPECT_PRESETS.map((preset) => ({
    id: asCommandId(`comp.autoReframe.${preset.id}`),
    label: `Auto-Reframe to ${preset.label}`,
    description: preset.hint,
    icon: 'frame',
    enabled: () => worthReframing(preset),
    execute: () => { void reframeTo(preset); },
  }));
}
