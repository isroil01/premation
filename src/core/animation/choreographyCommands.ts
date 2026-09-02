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
import { defaultAnimation } from '@motion/animation';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSelectionStore } from '@stores/selectionStore';
import {
  lastChoreography,
  lastStaggerParams,
  useChoreographyStore,
  type ChoreographyKind,
  type ChoreographyRecord,
} from '@stores/choreographyStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { runAnimEdit } from './animationCommands';
import { easePresetById } from './easePresets';
import {
  captureTracks,
  CHOREOGRAPHY_ARCHETYPES,
  feelDurationSec,
  feelStaggerFrames,
  mergeCaptures,
  nodeTrackRefs,
  planChoreography,
  planStagger,
  restoreTracks,
  shiftLayerTracks,
  staggerLayersFor,
  writeChoreography,
  type CapturedTrack,
  type ChoreoInstall,
  type ChoreographyFeel,
  type StaggerParams,
  type TrackRef,
} from './choreography';
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

/** `staggerOffsets`' own ±30%, named so the panel and the commands share it. */
export const DEFAULT_SWING_PCT = 30;

/** The composition the record is filed under. */
export function activeCompId(): string {
  return useCompositionStore.getState().id;
}

/** The composition centre — what `byDistanceFromCenter` measures from. */
function compCenter(): { x: number; y: number } {
  const comp = useCompositionStore.getState();
  return { x: comp.width / 2, y: comp.height / 2 };
}

const RUN_LABEL: Record<ChoreographyKind, string> = {
  in: 'Animate in',
  out: 'Animate out',
  stagger: 'Stagger animations',
};

export interface ChoreographyRunRequest {
  readonly kind: ChoreographyKind;
  readonly nodeIds: readonly string[];
  readonly params: StaggerParams;
  /** Defaults to `previous`'s anchor, else the playhead. */
  readonly atCompTime?: number;
  /** Force one archetype for every layer (the per-archetype commands). */
  readonly archetype?: EntranceArchetype;
  /**
   * The record to REPLACE. Its capture is restored first, so a re-apply starts
   * from the composition as it was before any of this ran — not from the last
   * result, which is how repeated stagger presses used to compound.
   */
  readonly previous?: ChoreographyRecord;
}

/** Min/max keyframe time across a set of tracks, after the write. */
function writtenRange(
  refs: readonly TrackRef[],
): { start: number; end: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const ref of refs) {
    for (const k of defaultAnimation.getTrackKeyframes(ref.nodeId, ref.prop) ?? []) {
      if (k.t < min) min = k.t;
      if (k.t > max) max = k.t;
    }
  }
  return Number.isFinite(min) ? { start: min, end: max } : null;
}

/**
 * Apply — or re-apply — a choreography, and file what it did.
 *
 * ONE undo entry covers the whole thing, restore included. That is the point:
 * a re-apply that recorded "put the old keyframes back" and "write the new
 * ones" as two entries would need two undos to get back to where you were, and
 * the intermediate state (the composition with no choreography on it) is not a
 * state anybody asked to visit.
 *
 * Returns the record, or null when there was nothing to act on.
 */
export function runChoreography(req: ChoreographyRunRequest): ChoreographyRecord | null {
  const engine = defaultAnimation;
  const fps = useCompositionStore.getState().fps || 30;
  const atCompTime = req.atCompTime ?? req.previous?.atCompTime ?? playhead();

  const layers = staggerLayersFor(req.nodeIds, atCompTime, engine);
  if (layers.length === 0) return null;

  const params: StaggerParams = { ...req.params, center: req.params.center ?? compCenter() };
  const plan = planStagger(layers, params);
  const offsetFrames = plan.map((p) => p.offsetFrames);
  const curve = params.easeCurve ? easePresetById(params.easeCurve)?.bezier : undefined;

  let captured: CapturedTrack[] = [];
  let refs: TrackRef[] = [];
  let installs: Record<string, ChoreoInstall> = {};
  let archetypes: EntranceArchetype[] = [];
  let keyframes = 0;

  runAnimEdit(req.previous ? `Re-apply ${RUN_LABEL[req.kind].toLowerCase()}` : RUN_LABEL[req.kind], () => {
    // One batch, so the viewport and the render cache see a single change for
    // what is, to the user, a single gesture.
    engine.batch(() => {
      if (req.previous) restoreTracks(req.previous.captured, engine);

      if (req.kind === 'stagger') {
        // Shifts what is already there rather than authoring anything, so the
        // tracks to capture are simply every track these layers animate — read
        // AFTER the restore, which is the state the shift starts from.
        refs = layers.flatMap((l) => nodeTrackRefs(l.nodeId, engine));
        captured = captureTracks(refs, engine);
        keyframes = shiftLayerTracks(
          layers.map((l, i) => ({ nodeId: l.nodeId, deltaSec: (offsetFrames[i] ?? 0) / fps })),
          engine,
        );
      } else {
        const choreo = planChoreography({
          nodeIds: layers.map((l) => l.nodeId),
          atCompTime,
          phase: req.kind,
          feel: params.feel,
          fps,
          seed: params.seed,
          staggerFrames: offsetFrames,
          installs: req.previous?.installs ?? {},
          ...(curve ? { curve } : {}),
          ...(req.archetype ? { archetype: req.archetype } : {}),
          engine,
        });
        refs = choreo.refs;
        // Captured from the RESTORED state, so for a track the previous run
        // already covered this reproduces that same original — which is why
        // merging the two below is consistent rather than a guess.
        captured = captureTracks(refs, engine);
        keyframes = writeChoreography(choreo, engine);
        archetypes = choreo.archetypes;
        installs = choreo.installs;
      }
    });
  });

  const record: ChoreographyRecord = {
    kind: req.kind,
    params,
    nodeIds: layers.map((l) => l.nodeId),
    atCompTime,
    fps,
    // The older capture wins: it is the state before ANY of this ran, and a
    // re-apply must be able to return there however many times it has run.
    captured: req.previous ? mergeCaptures(req.previous.captured, captured) : captured,
    installs: { ...req.previous?.installs, ...installs },
    range: writtenRange(refs),
    offsetFrames,
    archetypes,
    keyframes,
    at: Date.now(),
  };
  useChoreographyStore.getState().record(activeCompId(), record);
  return record;
}

/**
 * Re-run the composition's last choreography with (possibly new) parameters.
 * The layers are the ones it originally touched, not the current selection —
 * "re-apply" means the same gesture again, not a new one on whatever is
 * selected now.
 */
export function reapplyChoreography(params?: StaggerParams): ChoreographyRecord | null {
  const previous = lastChoreography(activeCompId());
  if (!previous) return null;
  return runChoreography({
    kind: previous.kind,
    nodeIds: previous.nodeIds,
    params: params ?? previous.params,
    atCompTime: previous.atCompTime,
    previous,
  });
}

/**
 * Put the composition back to before its last choreography and forget it —
 * the panel's escape hatch when the answer is "none of these".
 */
export function revertChoreography(): boolean {
  const compId = activeCompId();
  const previous = lastChoreography(compId);
  if (!previous) return false;
  runAnimEdit('Remove choreography', () => {
    defaultAnimation.batch(() => restoreTracks(previous.captured, defaultAnimation));
  });
  useChoreographyStore.getState().clear(compId);
  return true;
}

/**
 * The parameters a command-triggered gesture uses.
 *
 * Deliberately NOT the panel's last-used params for Animate In/Out. Those
 * commands have always meant "the project's motion feel, staggered in
 * selection order", and silently inheriting a rhythm someone dialled in on a
 * different board would change what the palette entry does without saying so.
 * The base offset is the feel's own stagger expressed in frames, which
 * reproduces `staggerOffsets` exactly — routing through `planStagger` retimes
 * nothing.
 */
export function commandStaggerParams(
  phase: 'in' | 'out',
  nodeIds: readonly string[],
  fps: number,
): StaggerParams {
  const feel = currentFeel();
  return {
    order: 'timeline',
    // Selection-derived: stable for a selection, different between selections.
    seed: hash32(phase, ...nodeIds) || 1,
    baseOffsetFrames: feelStaggerFrames(feel, fps),
    swingPct: DEFAULT_SWING_PCT,
    feel,
    perLayerOverrides: {},
  };
}

function run(phase: 'in' | 'out', archetype?: EntranceArchetype): void {
  const nodeIds = targets();
  if (nodeIds.length === 0) return;

  // The stagger rhythm is composed in frames, so it needs the real rate.
  const fps = useCompositionStore.getState().fps || 30;
  const record = runChoreography({
    kind: phase,
    nodeIds,
    params: commandStaggerParams(phase, nodeIds, fps),
    atCompTime: playhead(),
    ...(archetype ? { archetype } : {}),
  });
  if (!record) return;

  // Name the entrances when they varied. "Animated 5 layers" leaves someone
  // wondering whether the variation was intentional or the app being random;
  // listing them makes a deliberately varied result legible.
  const varied = !archetype && new Set(record.archetypes).size > 1;
  const used = varied
    ? ` — ${record.archetypes.map((a) => ARCHETYPE_LABELS[a as keyof typeof ARCHETYPE_LABELS] ?? a).join(', ')}`
    : '';
  const layers = record.nodeIds.length;
  const durationSec = (Math.max(0, ...record.offsetFrames) / record.fps) + feelDurationSec(record.params.feel);
  useUIStore.getState().notify({
    level: 'success',
    message:
      `Animated ${layers} layer${layers === 1 ? '' : 's'} ${phase} `
      + `over ${durationSec.toFixed(2)}s (${record.keyframes} keyframes)${used}.`,
    durationMs: 5000,
  });
}

/**
 * What "Stagger Animations (0.3s)" meant before it had parameters.
 *
 * Kept as the fallback so the menu row's label stays true on a fresh session:
 * the entry has no dialog, and the first press has to do what it says on it.
 * After that the panel's numbers win, which is the whole point of the rework.
 */
const LEGACY_STAGGER_SEC = 0.3;

/** Layers a re-stagger can move: selected, and actually animated. */
export function staggerTargets(): string[] {
  return targets().filter((id) => defaultAnimation.tracksFor(id).length > 0);
}

/** The stagger the menu entry applies: last-used params, or the legacy 0.3s. */
export function currentStaggerParams(fps: number): StaggerParams {
  const stored = lastStaggerParams();
  if (stored) return stored;
  const feel = currentFeel();
  return {
    order: 'timeline',
    seed: 1,
    baseOffsetFrames: Math.max(1, Math.round(LEGACY_STAGGER_SEC * (fps || 30))),
    // A metronome, as the old command was. Swing is opt-in from the panel:
    // a menu row labelled with one number should produce that one number.
    swingPct: 0,
    feel,
    perLayerOverrides: {},
  };
}

function runStagger(): void {
  const nodeIds = staggerTargets();
  if (nodeIds.length < 2) {
    useUIStore.getState().notify({
      level: 'warning',
      message: 'Select 2+ animated layers first',
      durationMs: 3000,
    });
    return;
  }
  const fps = useCompositionStore.getState().fps || 30;
  const record = runChoreography({ kind: 'stagger', nodeIds, params: currentStaggerParams(fps) });
  if (!record) return;
  const spread = Math.max(0, ...record.offsetFrames);
  useUIStore.getState().notify({
    level: 'success',
    message:
      `Staggered ${record.nodeIds.length} layers over ${(spread / record.fps).toFixed(2)}s `
      + '— edit the rhythm in Animate selection.',
    durationMs: 4000,
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

  /**
   * The Stagger Animations row, re-pointed at the parametric planner.
   *
   * Same id, deliberately: `Providers.tsx` registers one under this id and the
   * Animation menu, the TopNav and the command palette all resolve it by name.
   * Registration is idempotent-with-replacement and `buildChoreographyCommands`
   * runs after `buildBuiltinCommands`, so this is the one that survives — the
   * menu row keeps working and now applies whatever the panel last set, with
   * the old 0.3s as the fallback for a session that has set nothing.
   */
  commands.push({
    id: asCommandId('animation.sequenceLayers'),
    label: 'Stagger Animations',
    description:
      'Offset the selected layers’ existing keyframes into a rhythm, using the '
      + 'last stagger settings. Order, spacing and swing live in Animate selection.',
    icon: 'layers',
    enabled: () => staggerTargets().length >= 2,
    execute: () => runStagger(),
  });

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
