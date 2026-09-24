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
import { documentMirror } from '@stores/documentMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
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
   * The timeline root.
   *
   * It used to be selected by the exact chord list in `data-shortcut-claim`,
   * on the reasoning that the attribute is load-bearing and cannot quietly
   * disappear. True — but the LIST can grow, and it did the moment the snap
   * switch claimed `s`, which silently unhooked this anchor. Back to
   * `data-tour`, like every other entry here.
   */
  timeline: '[data-tour="timeline"]',
  /** The viewport transport row, by the label it already has. */
  transport: '[role="toolbar"][aria-label="Viewport transport and tools"]',
  /** The timeline's Graph Editor toggle, by the label it already has. */
  graphEditor: '[aria-label="Toggle Graph Editor"]',
  // ── Power tour ──────────────────────────────────────────────────────
  /** The status bar's timeline zoom cluster (Fit lives there). OWNER: StatusBar/TimelineZoom.tsx. */
  timelineZoom: '[data-tour="timeline-zoom"]',
  /** The Presets panel's quick-apply (`+`) affordance. OWNER: Motion/MotionPresetsPanel.tsx. */
  quickApply: '[data-tour="quick-apply"]',
  /** The command-palette trigger in the top bar. OWNER: TopNav / CommandPalette. */
  commandPalette: '[data-tour="command-palette"]',
} as const;

/** Which tour is running. `first-run` is the original; `power` is the second-run one. */
export type TourId = 'first-run' | 'power';
export const POWER_TOUR_ID: TourId = 'power';

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
    const m = documentMirror();
    return m.layerIds().filter((id) => CONTENT_KINDS.has(uiKindOf(m.layer(id)) ?? '')).length;
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

function paletteOpen(): boolean {
  try {
    // Lazy: the palette store imports the palette's context detector, which
    // this store must not pull in at module scope.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy seam, see layoutStore.ts
    const { useCommandPaletteStore } = require('@stores/commandPaletteStore') as typeof import('@stores/commandPaletteStore');
    return useCommandPaletteStore.getState().open;
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

/**
 * The steps of the tour that is RUNNING.
 *
 * Mutable on purpose, and by contents rather than by reference: the overlay
 * reads `TOUR_STEPS[index]` and `TOUR_STEPS.length` directly, so a second tour
 * has to arrive through the same array or the overlay would need to know
 * there is a second tour. `start(tourId)` swaps the contents in; `skip` and
 * `finish` put the first-run steps back. (The cleaner shape — the overlay
 * reading `useOnboardingStore(s => s.steps)` — is one line in the overlay,
 * which this file does not own; `steps` is exposed on the store for it.)
 */
export const TOUR_STEPS: TourStep[] = [];

export const FIRST_RUN_STEPS: ReadonlyArray<TourStep> = [
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

/**
 * The second-run tour: the shortcuts a person who has finished the first tour
 * is now ready for. Narration mostly — these are things to know, not tasks to
 * pass — with a check on the two that can be observed (playback and the
 * palette), so the tour still moves when the user tries them.
 */
export const POWER_STEPS: ReadonlyArray<TourStep> = [
  {
    id: 'jkl',
    title: 'J, K and L',
    body: 'In the timeline J and K hop between keyframes. In the Source Monitor they are the editor’s shuttle: J plays backwards, L forwards, again for 2× and 4×, K stops. Space still plays the comp.',
    anchor: TOUR_ANCHORS.timeline,
    placement: 'top',
    action: {
      kind: 'click',
      check: () => isPlaying(),
      hint: 'Press Space (or L in the Source Monitor) to play.',
    },
    whenMissing: 'The timeline is closed — reopen it with the bottom panel toggle.',
  },
  {
    id: 'reveal',
    title: 'U shows what moves',
    body: 'Select a layer and press U: every animated property unfolds and everything else stays out of the way. Press U twice quickly (UU) for only the properties you changed from their defaults.',
    anchor: TOUR_ANCHORS.timeline,
    placement: 'top',
    whenMissing: 'The timeline is closed — reopen it with the bottom panel toggle.',
  },
  {
    id: 'fit',
    title: '; fits the view',
    body: 'Semicolon zooms the timeline to the whole composition; Alt+; fits the work area. The zoom cluster in the status bar does the same by mouse.',
    anchor: TOUR_ANCHORS.timelineZoom,
    placement: 'top',
    whenMissing: 'The zoom cluster lives in the status bar under the timeline.',
  },
  {
    id: 'quick-apply',
    title: 'Quick apply with +',
    body: 'Hover a preset and press + (or click its plus) to drop it on the selected layers at the playhead, without leaving the panel. Drag it onto the canvas to aim it at one layer.',
    anchor: TOUR_ANCHORS.quickApply,
    placement: 'left',
    whenMissing: 'Open the Presets panel (Window ▸ Presets) to see quick apply.',
  },
  {
    id: 'palette',
    title: 'Everything, by name',
    body: 'Ctrl/Cmd+Shift+P opens the command palette: every command, panel, preset and doc section, searchable. Type ? for the shortcut list.',
    anchor: TOUR_ANCHORS.commandPalette,
    placement: 'bottom',
    action: {
      kind: 'click',
      check: () => paletteOpen(),
      hint: 'Press Ctrl+Shift+P (Cmd+Shift+P on a Mac).',
    },
    whenMissing: 'The palette also opens from View ▸ Command Palette.',
  },
];

/** The steps a tour id names. */
export function stepsForTour(id: TourId): ReadonlyArray<TourStep> {
  return id === 'power' ? POWER_STEPS : FIRST_RUN_STEPS;
}

/** Swap the running steps in, by contents — see the note on `TOUR_STEPS`. */
function loadSteps(id: TourId): void {
  TOUR_STEPS.splice(0, TOUR_STEPS.length, ...stepsForTour(id));
}

// The first-run steps are the default contents: every reader that imports
// `TOUR_STEPS` before any tour starts sees the tour that auto-starts.
loadSteps('first-run');

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
/**
 * The local edition's start screen sits OVER the editor shell, so a tour that
 * auto-starts on shell mount would spotlight a toolbar the user cannot reach
 * yet (observed 2026-09-03 on a fresh profile: step 1 "Draw something" over
 * the project browser). While it is visible the tour waits; dismissing it
 * re-runs the first-run check.
 */
let startScreenVisible = false;

export function setStartScreenVisible(visible: boolean): void {
  if (startScreenVisible === visible) return;
  startScreenVisible = visible;
  if (visible) {
    // The shell's mount effect runs BEFORE the start screen's (it is the
    // earlier sibling), so a boot-time auto-start may already be up. Retract
    // it — without marking the tour seen, since nobody has seen it — and the
    // dismissal below re-offers it.
    const st = useOnboardingStore.getState();
    if (st.active && st.autoStarted) {
      useOnboardingStore.setState({ active: false, autoStarted: false });
      stopPoll();
    }
    return;
  }
  const store = useOnboardingStore.getState();
  if (editorMounted && !store.active && canAutoStart()) {
    store.start();
    useOnboardingStore.setState({ autoStarted: true });
  } else if (editorMounted && !store.active && viewerEmpty && firstRunEligible()) {
    // Held back only because there is no canvas yet (New Project lands on the
    // "New Composition" cards). Owed for when there is one — see setViewerEmpty.
    owedAfterViewer = true;
  }
}

/**
 * The same problem one step later. A new project opens on the "New Composition"
 * cards, not a canvas — and step 1 is "drag a shape out on the canvas". On a
 * fresh profile (observed 2026-09-21) the tour asked for a drawing with nothing
 * to draw on, and its card sat on top of the very "New Composition" button that
 * would have produced one. While the viewer is empty the tour waits, exactly as
 * it does for the start screen; the first canvas re-runs the first-run check.
 */
let viewerEmpty = false;
/** An auto-start this gate took back, owed to the user once there is a canvas. */
let owedAfterViewer = false;

export function setViewerEmpty(empty: boolean): void {
  if (viewerEmpty === empty) return;
  viewerEmpty = empty;
  const store = useOnboardingStore.getState();
  if (empty) {
    // Retract an auto-start without marking it seen — nobody could act on it.
    if (store.active && store.autoStarted) {
      useOnboardingStore.setState({ active: false, autoStarted: false });
      stopPoll();
      owedAfterViewer = true;
    }
    return;
  }
  // NOT `canAutoStart()`: by now a project is open, which that check reads as
  // "not a first run". This re-offers only what was retracted above.
  const owed = owedAfterViewer;
  owedAfterViewer = false;
  if (owed && editorMounted && !store.active && !startScreenVisible
    && !readFlag(SEEN_KEY) && !readFlag(DISMISSED_KEY)) {
    store.start();
    useOnboardingStore.setState({ autoStarted: true });
  }
}

export function canAutoStart(): boolean {
  return !viewerEmpty && firstRunEligible();
}

/** `canAutoStart` without the canvas gate — is this a first run at all? */
function firstRunEligible(): boolean {
  if (startScreenVisible) return false;
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
  viewerEmpty = false;
  owedAfterViewer = false;
  stopPoll();
  editorMounted = false;
  startScreenVisible = false;
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
  /** Which tour `TOUR_STEPS` currently holds. */
  tourId: TourId;
  /** The running tour's steps — the same array as `TOUR_STEPS`, for readers that prefer the store. */
  steps: ReadonlyArray<TourStep>;
  /** Begin a tour. No id means the first-run tour. */
  start: (tourId?: TourId) => void;
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

/**
 * Skip and finish are the same act with different words. Only the FIRST-RUN
 * tour writes the seen flag: the power tour is asked for by name from Help,
 * and finishing it must neither mark the first-run tour seen for a profile
 * that never took it nor be gated by that flag. Ending either puts the
 * first-run steps back so the auto-start path always finds its own tour.
 */
function endTour(tourId: TourId, set: (patch: Partial<OnboardingStore>) => void): void {
  if (tourId === 'first-run') {
    set({ active: false, done: true });
    writeFlag(SEEN_KEY, true);
  } else {
    set({ active: false, tourId: 'first-run' });
    loadSteps('first-run');
  }
  stopPoll();
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  active: false,
  index: 0,
  done: readFlag(SEEN_KEY),
  autoStarted: false,
  tourId: 'first-run',
  steps: TOUR_STEPS,

  start: (tourId = 'first-run') => {
    captureBaseline();
    loadSteps(tourId);
    set({ active: true, index: 0, autoStarted: !editorMounted && tourId === 'first-run', tourId });
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
    endTour(get().tourId, set);
  },

  finish: () => {
    endTour(get().tourId, set);
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

export const HELP_POWER_TOUR_COMMAND = asCommandId('help.powerTour');

/**
 * The power tour's command. Menu row to add in `menuModel.ts` ▸ Help, under
 * "Take the Tour":
 *
 *   { commandId: 'help.powerTour', label: 'Power-user Tour' }
 */
export function registerPowerTourCommand(): void {
  try {
    getCommandRegistry().register({
      id: HELP_POWER_TOUR_COMMAND,
      label: 'Power-user Tour',
      description: 'JKL, U / UU, ; to fit, quick apply with + and the command palette.',
      icon: 'tour',
      enabled: () => true,
      execute: () => { useOnboardingStore.getState().start(POWER_TOUR_ID); },
    });
  } catch {
    /* no registry yet — the modal host registers it once the editor mounts */
  }
}
