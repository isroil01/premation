/**
 * Onboarding tour — the engine behind the first-run walkthrough.
 *
 * ## What changed, and why
 *
 * This used to be five paragraphs of prose in a centred card. It read like a
 * feature list, which is the one thing a first-run tour must not be: nothing in
 * it was anchored to a control, nothing waited for the user to do anything, and
 * every step advanced on a Next button whether or not the reader had understood
 * — or even looked at — the thing being described.
 *
 * So a step here is a POINTER plus, optionally, a TASK:
 *
 *  - `anchor` is a CSS selector for the real control the step is about. The
 *    overlay spotlights it. The convention is `[data-tour="<id>"]`, and
 *    `TOUR_ANCHORS` is the vocabulary of those ids; where an element already
 *    carries a stable, meaningful selector of its own (an `aria-label`, a
 *    `data-shortcut-claim`) that is used instead of adding a second attribute
 *    that says the same thing.
 *  - `action.check()` is the completion test, evaluated against the REAL stores
 *    — the scene graph, the animation engine, the project store. When it turns
 *    true the tour advances by itself. A step with an action cannot be faked by
 *    pressing Next past it; a step without one is pure narration and Next is
 *    the whole interaction.
 *
 * ## Baselines
 *
 * "Set a keyframe" cannot mean "a keyframe exists" — take the tour a second
 * time on a project with animation in it and steps 1, 3 and 4 would all satisfy
 * themselves before the card had finished fading in, which is worse than not
 * having the check at all. `start()` therefore snapshots the counts that matter
 * and the checks are stated RELATIVE to that snapshot: one MORE keyframe than
 * you had, two more, one more layer. The tour then works identically on an
 * empty comp and a finished one.
 *
 * ## Polling
 *
 * The stores this reads are a mix of zustand and plain non-reactive engines
 * (`defaultSceneGraph`, `defaultAnimation`), so there is no single subscription
 * that covers them. A 4 Hz poll runs ONLY while a step with an action is
 * showing, and stops the moment the tour reaches a narration step or ends —
 * `syncPoll` is called from every mutation below and is the only thing that
 * starts or stops the timer.
 */

import { create } from 'zustand';
import type { Placement } from '@hooks/positionPopover';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { tryCoreServices } from '@core/services/coreServices';
import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';

/**
 * The anchor vocabulary.
 *
 * Every `data-tour` attribute in the app is named here, so the set of things
 * the tour is allowed to point at is one list rather than a scatter of string
 * literals. Entries not currently consumed by `TOUR_STEPS` are marked; they are
 * the anchors a step would need if one were added, and they exist so that
 * adding that step is a change to THIS file only.
 */
export const TOUR_ANCHORS = {
  /** TopNav — the shape-tool flyout trigger. */
  shapeTool: '[data-tour="shape-tool"]',
  /** TopNav — the pen-tool flyout trigger. Reserved; no step points at it yet. */
  penTool: '[data-tour="pen-tool"]',
  /** TopNav — the Export button. */
  export: '[data-tour="export"]',
  /** The right-hand inspector column. */
  inspector: '[data-tour="inspector"]',
  /** SceneControls — the 3D camera / gizmo cluster. */
  scene3d: '[data-tour="scene-3d"]',
  /** DemoPanels — the Scene (compositions + layers) panel. Reserved. */
  scenePanel: '[data-tour="scene-panel"]',
  /** DemoPanels — the Assets panel. Reserved. */
  assetsPanel: '[data-tour="assets-panel"]',
  /**
   * The timeline root. Selected by the chords it claims rather than by a new
   * attribute: `Timeline.tsx` already carries this, it is unique in the app,
   * and it is load-bearing (ShortcutManager reads it), so it cannot quietly
   * disappear the way a decorative attribute could.
   */
  timeline: '[data-shortcut-claim="delete backspace Ctrl+a Meta+a"]',
  /** The viewport transport row, by the label it already has. */
  transport: '[role="toolbar"][aria-label="Viewport transport and tools"]',
  /** The timeline's Graph Editor toggle, by the label it already has. */
  graphEditor: '[aria-label="Toggle Graph Editor"]',
} as const;

/** What a step is waiting for. Purely descriptive — the overlay picks an icon. */
export type TourActionKind = 'click' | 'tool' | 'create' | 'keyframe';

export interface TourAction {
  kind: TourActionKind;
  /**
   * True once the user has done the thing. Called up to 4×/s while the step is
   * showing; must be cheap and must not mutate anything.
   */
  check: () => boolean;
  /** One line telling the user exactly what to do. */
  hint: string;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the control this step is about. */
  anchor: string;
  /** Where the card sits relative to the anchor. */
  placement: Placement;
  action?: TourAction;
  /**
   * Shown INSTEAD of the spotlight when `anchor` matches nothing — a closed
   * panel, a collapsed sidebar. Says how to bring the thing back.
   */
  whenMissing?: string;
}

// ── Real-store predicates ────────────────────────────────────────────────
// Each is wrapped, because the tour must never be the thing that takes the
// editor down: a scene graph mid-mutation or an engine that has not booted is a
// reason to not advance, not a reason to throw out of a 4 Hz timer.

/** Layers the user could plausibly have just made — not comps, not groups. */
const CONTENT_KINDS = new Set(['shape', 'text', 'image', 'video', 'svg', 'particle']);

function contentLayerCount(): number {
  try {
    return flattenScene(defaultSceneGraph).filter((n) => CONTENT_KINDS.has(readNodeKind(n))).length;
  } catch {
    return 0;
  }
}

function keyframeCount(): number {
  try {
    let total = 0;
    for (const nodeId of defaultAnimation.getAnimatedNodeIds()) {
      for (const track of defaultAnimation.tracksFor(nodeId)) total += track.keyframes.length;
    }
    return total;
  } catch {
    return 0;
  }
}

function isPlaying(): boolean {
  try {
    return Object.values(useProjectStore.getState().tabs).some((t) => t.playing);
  } catch {
    return false;
  }
}

function graphEditorOpen(): boolean {
  try {
    return useUIStore.getState().graphEditorOpen;
  } catch {
    return false;
  }
}

/**
 * Counts as they were when the tour started. See the "Baselines" note above.
 * Module state rather than store state: the checks are plain closures in
 * `TOUR_STEPS`, which is a module constant, so they cannot take the store as an
 * argument without threading it through every call site of `check()`.
 */
let baseline = { layers: 0, keyframes: 0 };

function captureBaseline(): void {
  baseline = { layers: contentLayerCount(), keyframes: keyframeCount() };
}

/** Exported for the test suite, which needs to start from a known baseline. */
export function resetTourBaseline(): void {
  baseline = { layers: 0, keyframes: 0 };
}

export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  {
    id: 'add-shape',
    title: 'Draw something',
    body: 'Pick a shape and drag it out on the canvas. Q cycles rectangle, ellipse and polygon; G does the same for the pen tools next door.',
    anchor: TOUR_ANCHORS.shapeTool,
    placement: 'bottom-start',
    action: {
      kind: 'create',
      check: () => contentLayerCount() > baseline.layers,
      hint: 'Draw a shape on the canvas to continue.',
    },
    whenMissing: 'The toolbar is hidden — reopen it from View, then come back.',
  },
  {
    id: 'inspector',
    title: 'Everything about that layer',
    body: 'The inspector is the layer, in full: transform, fills, effects, 3D. Every number here is a scrubbable slider AND a field that does maths — drag it, or click and type 960/2.',
    anchor: TOUR_ANCHORS.inspector,
    placement: 'left',
    whenMissing: 'The inspector is collapsed — reopen it with the right-hand panel toggle.',
  },
  {
    id: 'set-keyframe',
    title: 'Set a keyframe',
    body: 'A stopwatch turns a property into an animation. Click the one beside Position in the timeline and the current value becomes your first keyframe.',
    anchor: TOUR_ANCHORS.timeline,
    placement: 'top',
    action: {
      kind: 'keyframe',
      check: () => keyframeCount() >= baseline.keyframes + 1,
      hint: 'Click any property stopwatch to record a keyframe.',
    },
    whenMissing: 'The timeline is closed — reopen it with the bottom panel toggle.',
  },
  {
    id: 'second-keyframe',
    title: 'Now make it move',
    body: 'Drag the playhead somewhere later, then change the value. A second keyframe lands automatically, and the two of them are the animation.',
    anchor: TOUR_ANCHORS.timeline,
    placement: 'top',
    action: {
      kind: 'keyframe',
      check: () => keyframeCount() >= baseline.keyframes + 2,
      hint: 'Move the playhead, then change the value you just keyed.',
    },
    whenMissing: 'The timeline is closed — reopen it with the bottom panel toggle.',
  },
  {
    id: 'play',
    title: 'Play it',
    body: 'Spacebar, or the button in the middle of the transport. The first pass renders and caches; the second is real time.',
    anchor: TOUR_ANCHORS.transport,
    placement: 'top',
    action: {
      kind: 'click',
      check: () => isPlaying(),
      hint: 'Press Space, or hit Play.',
    },
    whenMissing: 'The transport lives under the viewport — reopen the viewport to see it.',
  },
  {
    id: 'graph-editor',
    title: 'Shape how it moves',
    body: 'Easing is the difference between "it moved" and "it feels right". The easing pills set a curve in one click; the graph editor lets you draw the curve yourself, with real bezier handles and numeric velocity.',
    anchor: TOUR_ANCHORS.graphEditor,
    placement: 'top',
    action: {
      kind: 'click',
      check: () => graphEditorOpen(),
      hint: 'Open the graph editor (Shift+F3) to see the curve.',
    },
    whenMissing: 'The timeline is closed — reopen it to reach the graph editor.',
  },
  {
    id: 'three-d',
    title: '3D, when you want it',
    body: 'Flip a layer to 3D and it gains Z, orientation and a place in a lit scene. This cluster is how you fly around it: orbit, pan and dolly, the gizmo mode, and which axes it aligns to.',
    anchor: TOUR_ANCHORS.scene3d,
    placement: 'bottom',
    whenMissing: 'The 3D cluster sits in the toolbar — reopen it from View.',
  },
  {
    id: 'export',
    title: 'Get it out',
    body: 'Export writes video, image sequences, GIF and Lottie, and queues long renders in the background so you can keep working. That is the tour — everything else is discoverable from the command palette.',
    anchor: TOUR_ANCHORS.export,
    placement: 'bottom-end',
    whenMissing: 'Export also lives in the File menu.',
  },
];

// ── Persistence ──────────────────────────────────────────────────────────
//
// `SEEN_KEY` is the key `Providers` already writes on `onDone` and reads to
// decide whether to auto-start, so it stays exactly as it was; this module just
// stops depending on somebody else remembering to write it.

const SEEN_KEY = 'onboarding.seen';
const DISMISSED_KEY = 'onboarding.dontShowAgain';
/** Used only when the core has not booted — tests, pre-boot routes. */
const LS_PREFIX = 'motion-editor.';

function readFlag(key: string): boolean {
  const settings = tryCoreServices()?.settings;
  if (settings) return settings.get<boolean>(key, false) === true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_PREFIX + key) === 'true';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  const settings = tryCoreServices()?.settings;
  if (settings) {
    settings.set(key, value);
    return;
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_PREFIX + key, String(value));
  } catch {
    /* private mode / quota — the tour re-offering itself is not worth throwing over */
  }
}

/**
 * Is this the first run, with nothing to lose?
 *
 * Three conditions, and the third is the one that is easy to forget: somebody
 * who has a project open is mid-task, and a tour that spotlights the shape tool
 * over their work is an interruption rather than a welcome. "No project" means
 * both no current project AND an empty recents list — a returning user who
 * dismissed the start screen still has history, and should not be treated as
 * new because they happened to close a file.
 */
export function canAutoStart(): boolean {
  if (readFlag(SEEN_KEY) || readFlag(DISMISSED_KEY)) return false;
  const core = tryCoreServices();
  if (!core) return true;
  try {
    if (core.project.getState().current) return false;
    if (core.recent.list().length > 0) return false;
  } catch {
    return false;
  }
  return true;
}

// ── The 4 Hz poll ────────────────────────────────────────────────────────

/** 250 ms. Fast enough to feel immediate, slow enough to be free. */
export const TOUR_POLL_MS = 250;

let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPoll(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function activeAction(): TourAction | undefined {
  const s = useOnboardingStore.getState();
  if (!s.active) return undefined;
  return TOUR_STEPS[s.index]?.action;
}

/** Start or stop the timer so it runs exactly while an actionable step shows. */
function syncPoll(): void {
  if (!activeAction()) {
    stopPoll();
    return;
  }
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    const action = activeAction();
    if (!action) {
      stopPoll();
      return;
    }
    let done = false;
    try {
      done = action.check();
    } catch {
      done = false;
    }
    if (done) useOnboardingStore.getState().next();
  }, TOUR_POLL_MS);
}

/**
 * Has the editor shell mounted?
 *
 * This is how an AUTO start is told apart from a deliberate one, and the
 * ordering is not a guess: `Providers` runs its boot effect (which is where its
 * first-run `start()` lives) before it flips `ready` and renders the overlay at
 * all. So any `start()` seen while this is false came from boot, and any
 * `start()` after it came from a person — the Help menu, the palette, the start
 * screen. Only the first kind is subject to `canAutoStart()`.
 */
let editorMounted = false;

/** Test seam — jsdom keeps module state between cases in one file. */
export function resetOnboardingRuntime(): void {
  stopPoll();
  editorMounted = false;
  resetTourBaseline();
}

interface OnboardingStore {
  /** The tour is running. */
  active: boolean;
  /** Index into `TOUR_STEPS`. */
  index: number;
  /** The tour has been completed or skipped at least once (persisted). */
  done: boolean;
  /** This run was begun by boot rather than by a person. */
  autoStarted: boolean;
  start: () => void;
  next: () => void;
  back: () => void;
  skip: () => void;
  /** Reached the end. Same persistence as `skip`, different word for it. */
  finish: () => void;
  /** The "don't show again" opt-out, persisted immediately. */
  setDontShowAgain: (value: boolean) => void;
  /**
   * Called once by the overlay when the editor shell mounts. Retracts an
   * auto-start that should not have happened, and performs one that should
   * have but did not.
   */
  onEditorMounted: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  active: false,
  index: 0,
  done: readFlag(SEEN_KEY),
  autoStarted: false,

  start: () => {
    captureBaseline();
    set({ active: true, index: 0, autoStarted: !editorMounted });
    syncPoll();
  },

  next: () => {
    const { index } = get();
    if (index >= TOUR_STEPS.length - 1) {
      get().finish();
      return;
    }
    set({ index: index + 1 });
    syncPoll();
  },

  back: () => {
    set({ index: Math.max(0, get().index - 1) });
    syncPoll();
  },

  skip: () => {
    set({ active: false, done: true });
    writeFlag(SEEN_KEY, true);
    stopPoll();
  },

  finish: () => {
    set({ active: false, done: true });
    writeFlag(SEEN_KEY, true);
    stopPoll();
  },

  setDontShowAgain: (value) => {
    writeFlag(DISMISSED_KEY, value);
    if (value) writeFlag(SEEN_KEY, true);
    set({ done: value || get().done });
  },

  onEditorMounted: () => {
    const wasMounted = editorMounted;
    editorMounted = true;
    if (wasMounted) return;
    const { active, autoStarted } = get();
    if (active && autoStarted && !canAutoStart()) {
      // Retract, but do NOT mark it seen: the tour was never shown, so the
      // user has not declined it and it should still be offered next time the
      // first-run conditions actually hold.
      set({ active: false, autoStarted: false });
      stopPoll();
      return;
    }
    if (!active && canAutoStart()) {
      get().start();
      set({ autoStarted: true });
    }
  },
}));

/**
 * Register the command.
 *
 * Deliberately the SAME id the Help menu already points at (`help.tour`, the
 * row in `menuModel.ts`), and registration replaces by id, so this and the
 * copy in `Providers` are interchangeable rather than in conflict — no new menu
 * row is needed, and deleting the one in `Providers` costs nothing.
 */
export function registerTourCommand(): void {
  try {
    getCommandRegistry().register({
      id: asCommandId('help.tour'),
      label: 'Take the Tour',
      icon: 'tour',
      enabled: () => true,
      execute: () => { useOnboardingStore.getState().start(); },
    });
  } catch {
    /* no registry yet (a pre-boot route) — Providers registers it during boot */
  }
}

registerTourCommand();
