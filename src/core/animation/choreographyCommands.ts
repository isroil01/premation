/**
 * "Animate In / Out" as commands — one per phase, plus one per archetype.
 *
 * A command per archetype rather than a dialog, for the reason the auto-reframe
 * commands give: the whole input is one enum, and a command per value means the
 * feature is reachable by typing "pop" into the palette instead of opening a
 * modal to choose from four things. The plain `Animate In` is the one most
 * people want — it varies the entrance per layer, which is the point.
 *
 * The seed is derived from the SELECTION rather than from a clock. Two
 * different groups of layers get different choreography, but running the same
 * command twice on the same selection gives the same result — a command that
 * reshuffled on every press would be impossible to iterate on, and undo/redo
 * would stop meaning anything.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { animateLayers, CHOREOGRAPHY_ARCHETYPES, type ChoreographyFeel } from './choreography';
import { hash32, type EntranceArchetype } from './entranceArchetypes';

/** The feels, named for people rather than by their timing numbers. */
const FEELS: ReadonlyArray<{ value: ChoreographyFeel; label: string; hint: string }> = [
  { value: 'snappy', label: 'Snappy', hint: 'Short, tight, close together.' },
  { value: 'smooth', label: 'Smooth', hint: 'Longer travel with a soft landing.' },
  { value: 'bouncy', label: 'Bouncy', hint: 'Overshoots and settles.' },
];

/** Human names for the archetypes — the palette shows these, not the ids. */
const ARCHETYPE_LABELS: Record<(typeof CHOREOGRAPHY_ARCHETYPES)[number], string> = {
  rise: 'Rise',
  scale_pop: 'Pop',
  slide_settle: 'Slide',
  mask_wipe: 'Wipe',
  blur_resolve: 'Blur In',
  char_cascade: 'Character Cascade',
};

/**
 * The project's motion feel. Shared with the beat-synced commands so a single
 * choice governs every generated entrance, however it was triggered.
 */
export function currentFeel(): ChoreographyFeel {
  return usePreferenceStore.getState().motionFeel ?? 'smooth';
}

/** Layers the command would act on: the selection, minus anything gone. */
function targets(): string[] {
  return useSelectionStore.getState().ids.filter((id) => defaultSceneGraph.getNode(id) !== undefined);
}

/** Composition seconds under the playhead. */
function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

function run(phase: 'in' | 'out', archetype?: EntranceArchetype): void {
  const nodeIds = targets();
  if (nodeIds.length === 0) return;

  const result = animateLayers({
    nodeIds,
    atCompTime: playhead(),
    phase,
    ...(archetype ? { archetype } : {}),
    feel: currentFeel(),
    // The stagger rhythm is composed in frames, so it needs the real rate.
    fps: useCompositionStore.getState().fps || 30,
    // Selection-derived: stable for a selection, different between selections.
    seed: hash32(phase, ...nodeIds) || 1,
  });
  if (result.layers === 0) return;

  // Name the entrances when they varied. "Animated 5 layers" leaves someone
  // wondering whether the variation was intentional or the app being random;
  // listing them makes a deliberately varied result legible.
  const varied = !archetype && new Set(result.archetypes).size > 1;
  const used = varied
    ? ` — ${result.archetypes.map((a) => ARCHETYPE_LABELS[a as keyof typeof ARCHETYPE_LABELS] ?? a).join(', ')}`
    : '';
  useUIStore.getState().notify({
    level: 'success',
    message:
      `Animated ${result.layers} layer${result.layers === 1 ? '' : 's'} ${phase} `
      + `over ${result.durationSec.toFixed(2)}s (${result.keyframes} keyframes)${used}.`,
    durationMs: 5000,
  });
}

/** Every choreography command, for `buildStaticCommands`. */
export function buildChoreographyCommands(): ReadonlyArray<Command> {
  const phases = [
    { phase: 'in' as const, verb: 'In', hint: 'arrive' },
    { phase: 'out' as const, verb: 'Out', hint: 'leave' },
  ];

  const commands: Command[] = [];
  for (const { phase, verb, hint } of phases) {
    commands.push({
      id: asCommandId(`animation.animate${verb}`),
      label: `Animate ${verb}`,
      description:
        `Stagger the selected layers so they ${hint} one after another, with a `
        + 'different entrance per layer. Writes ordinary keyframes.',
      icon: 'sparkles',
      enabled: () => targets().length > 0,
      execute: () => run(phase),
    });
    for (const archetype of CHOREOGRAPHY_ARCHETYPES) {
      commands.push({
        id: asCommandId(`animation.animate${verb}.${archetype}`),
        label: `Animate ${verb}: ${ARCHETYPE_LABELS[archetype]}`,
        description: `Stagger the selected layers ${hint} using ${ARCHETYPE_LABELS[archetype]} for every one.`,
        icon: 'sparkles',
        enabled: () => targets().length > 0,
        execute: () => run(phase, archetype),
      });
    }
  }

  // Setting the feel is itself a command: it is one enum, which is exactly the
  // case the auto-reframe commands make for a command per value over a dialog.
  // `isChecked` makes the menu read as a radio group rather than three verbs.
  for (const feel of FEELS) {
    commands.push({
      id: asCommandId(`animation.motionFeel.${feel.value}`),
      label: `Motion Feel: ${feel.label}`,
      description: `${feel.hint} Applies to Animate In/Out and the beat-synced commands.`,
      icon: 'sparkles',
      isChecked: () => currentFeel() === feel.value,
      execute: () => {
        usePreferenceStore.getState().set('motionFeel', feel.value);
        useUIStore.getState().notify({
          level: 'success',
          message: `Motion feel: ${feel.label.toLowerCase()}.`,
          durationMs: 2500,
        });
      },
    });
  }
  return commands;
}
