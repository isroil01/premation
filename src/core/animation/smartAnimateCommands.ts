/**
 * Smart Animate as a command: one per possible target composition.
 *
 * A command per target rather than a dialog, the same argument the auto-reframe
 * commands make: the entire input is "which other board", so a command per
 * value means the feature is reachable by typing the target's name into the
 * palette instead of opening a modal to pick from a list.
 *
 * The target list is not fixed, and `buildStaticCommands` runs once at boot —
 * so a board created later would have no command to animate to it. Rather than
 * ship that, `installSmartAnimateCommandSync` subscribes to the project's
 * compositions and re-registers the set whenever they change. The registry
 * treats `register` as idempotent (same id replaces) and has `unregister`, so
 * keeping it in step is a diff rather than a rebuild.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { smartAnimateBetween } from './smartAnimateApply';
import { PHYSICS } from './motionCurves';

/** How long a transition runs, per motion feel. */
const DURATION: Record<string, number> = { snappy: 0.45, smooth: 0.8, bouncy: 0.7 };

function activeCompId(): string | undefined {
  const project = useProjectStore.getState();
  return project.activeTabId ? project.tabs[project.activeTabId]?.compositionId : undefined;
}

/** Compositions that could be a target: everything except the active one. */
export function transitionTargets(): Array<{ id: string; name: string }> {
  const project = useProjectStore.getState();
  const current = activeCompId();
  return Object.values(project.comps)
    .filter((c) => c.id !== current && !c.pristine)
    .map((c) => ({ id: c.id, name: c.name }));
}

function run(toCompId: string): void {
  const from = activeCompId();
  if (!from) return;
  const project = useProjectStore.getState();
  const fromName = project.comps[from]?.name ?? 'A';
  const toName = project.comps[toCompId]?.name ?? 'B';

  const feel = usePreferenceStore.getState().motionFeel ?? 'smooth';
  const result = smartAnimateBetween(from, toCompId, {
    startTime: 0,
    durationSec: DURATION[feel] ?? 0.8,
    curve: feel === 'bouncy' ? PHYSICS.overshoot : PHYSICS.softOut,
    name: `${fromName} → ${toName}`,
  });

  if (!result) {
    useUIStore.getState().notify({
      level: 'warning',
      message: 'Could not build the transition — one of the compositions is missing.',
      durationMs: 5000,
    });
    return;
  }

  // The counts are the explanation. A transition where nothing matched is a
  // cross-fade, and the user needs to know that came from the layer NAMES not
  // lining up rather than from the feature being broken.
  const parts = [`${result.matched} matched`];
  if (result.departing > 0) parts.push(`${result.departing} leaving`);
  if (result.arriving > 0) parts.push(`${result.arriving} arriving`);
  useUIStore.getState().notify({
    level: result.matched === 0 ? 'warning' : 'success',
    message:
      `“${fromName} → ${toName}”: ${parts.join(', ')}, ${result.keyframes} keyframes.`
      + (result.matched === 0
        ? ' Nothing matched — layers pair up by name, so give the elements the same names in both boards.'
        : ''),
    durationMs: 7000,
  });
}

/** Every Smart Animate command, for `buildStaticCommands`. */
export function buildSmartAnimateCommands(): ReadonlyArray<Command> {
  return transitionTargets().map((target) => ({
    id: asCommandId(`comp.smartAnimate.${target.id}`),
    label: `Smart Animate to “${target.name}”`,
    description:
      'Build a transition composition from this board to that one: matching layers move, '
      + 'the rest fade. Layers pair up by name.',
    icon: 'sparkles',
    enabled: () => activeCompId() !== undefined,
    execute: () => run(target.id),
  }));
}

/** Command ids currently registered by this module. */
let registered = new Set<string>();

/**
 * Bring the registry in line with the compositions that exist now.
 *
 * Exported for the installer below and for tests; safe to call repeatedly.
 */
export function syncSmartAnimateCommands(): void {
  const commands = buildSmartAnimateCommands();
  const wanted = new Set(commands.map((c) => String(c.id)));
  const registry = getCommandRegistry();

  for (const id of registered) {
    if (!wanted.has(id)) registry.unregister(asCommandId(id));
  }
  for (const command of commands) registry.register(command);
  registered = wanted;
}

/**
 * Keep the Smart Animate commands in step with the project's compositions.
 *
 * Called once at boot. Returns the unsubscribe, which nothing currently needs
 * — the subscription lives as long as the app — but which makes the function
 * testable and keeps it from being a leak by construction.
 */
export function installSmartAnimateCommandSync(): () => void {
  let lastKey = '';
  return useProjectStore.subscribe((state) => {
    // Keyed on the comps and the active one: a rename changes a label, a new
    // comp changes the set, and switching comps changes which one is excluded.
    const key = `${Object.keys(state.comps).sort().join(',')}|${state.activeTabId ?? ''}`
      + `|${Object.values(state.comps).map((c) => c.name).join(',')}`;
    if (key === lastKey) return;
    lastKey = key;
    syncSmartAnimateCommands();
  });
}
