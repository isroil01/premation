/**
 * Chat state for the AI prompt bar.
 *
 * Split out of AiPromptBar because that component is mostly drag/resize
 * bookkeeping, and none of it has anything to do with talking to a model.
 *
 * The model call streams through the backend AI gateway (the user's provider
 * key lives there, encrypted); the agent loop and tools run here where the
 * document lives. Threads are stored server-side and listed ChatGPT-style:
 * every conversation for the current project can be reopened, and "new chat"
 * starts a fresh thread without deleting the old one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiMessage, AiToolCall } from '@motion/ai-tools';
import type { ConceptChoice, ConceptOption, CritiqueAxis } from '@motion/author';
import { AiError, runAgent } from '@core/ai/AgentLoop';
import { engineCompStill } from '@core/engine/engineStill';
import { activeCompIdNow } from '@hooks/useMirror';
import { type AiTransaction } from '@core/ai/aiTransaction';
import type { PendingImage } from '@core/ai/imageAttachment';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { casterPacks } from '@core/ai/CasterRunner';
import { AUTHOR_STAGE_LABELS } from '@core/ai/author/stages';
import { authorModeDefault } from '@core/config/flags';
import { aiPieceHistory } from '@stores/aiPieceHistory';
import { api, isAuthenticated, type AiConversationSummary } from '@core/api/client';
import { aiRunsThroughBackend } from '@core/config/edition';
import {
  appendLocalMessages,
  deleteLocalConversation,
  getLocalConversation,
  listLocalConversations,
} from '@core/ai/localConversations';
import { t } from '@core/i18n';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Renders as a warning rather than an answer. */
  error?: boolean;
  /** Thumbnails of reference images the user attached to this turn. */
  images?: string[];
}

/** How many prior turns to replay. Enough for context, bounded for cost. */
const HISTORY_TURNS = 24;

/**
 * The look packs the caster can be pointed at.
 *
 * Static — `casterPacks()` reads a frozen array — so it is resolved once here
 * rather than on every render of the composer.
 */
const PACKS = casterPacks();

/**
 * How many image-bearing user turns keep their images in the model-facing
 * history. Images are the heaviest thing in the context by far — an old
 * reference the conversation has moved past isn't worth re-sending every turn.
 */
const IMAGE_TURNS_KEPT = 2;

function pruneImageTurns(history: AiMessage[]): AiMessage[] {
  let kept = 0;
  return history
    .slice()
    .reverse()
    .map((m) => {
      if (m.role !== 'user' || !m.images?.length) return m;
      kept++;
      return kept <= IMAGE_TURNS_KEPT ? m : { role: 'user' as const, content: m.content };
    })
    .reverse();
}

/**
 * Tool name → the label shown while it runs.
 *
 * A table rather than a switch, so the mapped names are ENUMERABLE. The switch
 * form drifted in both directions without anything noticing: branches for tools
 * that no longer existed, and no branch at all for tools that did — which showed
 * the user "Working" through the most interesting part of a run.
 * `activityFor.test.ts` now checks both directions against the live registry.
 *
 * A function returning the table (not a module constant): the labels are
 * translated, and `t()` must run when a label is shown, never at module scope.
 * Keys sharing an English label share its translation key.
 */
function toolActivity(): Record<string, string> {
  const reading = t('workspace.aiActivity.reading', 'Reading the scene');
  const editingLayers = t('workspace.aiActivity.editingLayers', 'Editing layers');
  const animating = t('workspace.aiActivity.animating', 'Animating');
  const applyingEffects = t('workspace.aiActivity.applyingEffects', 'Applying effects');
  const placingMedia = t('workspace.aiActivity.placingMedia', 'Placing media');
  const masking = t('workspace.aiActivity.masking', 'Masking');
  const repeaterBurst = t('workspace.aiActivity.repeaterBurst', 'Adding shape repeater burst');
  const pathDistortion = t('workspace.aiActivity.pathDistortion', 'Morphing vector path distortion');
  return {
    // ── Read ──
    describe_scene: reading,
    read_tracks: reading,
    evaluate_at: reading,
    get_selection: reading,
    list_capabilities: reading,
    list_presets: reading,
    analyse_audio: reading,
    inspect_layers: reading,
    list_fonts: reading,
    get_export_status: reading,

    // ── Structure ──
    create_layer: t('workspace.aiActivity.creatingLayers', 'Creating layers'),
    delete_layer: t('workspace.aiActivity.removingLayers', 'Removing layers'),
    update_layer: editingLayers,
    reparent_layer: editingLayers,
    reorder_layer: t('workspace.aiActivity.arrangingLayers', 'Arranging layers'),
    update_composition: editingLayers,
    create_precomp: t('workspace.aiActivity.nestingPrecomp', 'Nesting a precomp'),

    // ── Animation ──
    set_keyframes: animating,
    set_easing: animating,
    remove_keyframes: animating,
    apply_preset: animating,
    text_animator: t('workspace.aiActivity.animatingType', 'Animating type'),
    set_spring: t('workspace.aiActivity.springPhysics', 'Solving spring physics'),
    set_time_remap: t('workspace.aiActivity.retiming', 'Retiming'),
    set_expression: t('workspace.aiActivity.expressions', 'Writing expressions'),
    set_motion_blur: t('workspace.aiActivity.shutter', 'Setting the shutter'),
    set_layer_timing: t('workspace.aiActivity.timingBeats', 'Timing the beats'),

    // ── Look ──
    add_effect: applyingEffects,
    update_effect: applyingEffects,
    update_effect_param: t('workspace.aiActivity.tuningEffects', 'Tuning effects'),
    set_shadow_stack: t('workspace.aiActivity.buildingDepth', 'Building depth'),
    add_surface_treatment: t('workspace.aiActivity.grainVignette', 'Adding grain and vignette'),
    create_gradient: t('workspace.aiActivity.paintingBackdrop', 'Painting the backdrop'),
    set_light: t('workspace.aiActivity.lighting', 'Lighting the scene'),
    apply_layer_style: t('workspace.aiActivity.styling', 'Styling layers'),
    recolor_lottie_vector: t('workspace.aiActivity.recolouring', 'Recolouring vectors'),

    // ── Media and masks ──
    create_media: placingMedia,
    // Named, and named honestly: this one takes seconds and costs credits, so
    // "Working" would leave the user watching a spinner with no idea why.
    generate_image: t('workspace.aiActivity.generatingImagery', 'Generating imagery'),
    generate_video: t('workspace.aiActivity.generatingVideo', 'Generating video'),
    generate_speech: t('workspace.aiActivity.generatingVoice', 'Generating voice-over'),
    generate_3d_model: t('workspace.aiActivity.generating3d', 'Generating a 3D model'),
    export_video: t('workspace.aiActivity.queueingExport', 'Queueing export'),
    place_behind_subject: t('workspace.aiActivity.placeBehindSubject', 'Placing layers behind the subject'),
    import_svg: t('workspace.aiActivity.drawingVectors', 'Drawing vectors'),
    create_media_from_attachment: placingMedia,
    create_mask: masking,
    update_mask: masking,
    paint_strokes: t('workspace.aiActivity.paintingStrokes', 'Painting strokes'),
    set_audio: t('workspace.aiActivity.mixingAudio', 'Mixing audio'),

    // ── Subjects, tracking, media (2026-11-02) ──
    find_subjects: reading,
    get_job_status: reading,
    get_editor_context: reading,
    describe_asset: reading,
    select_subject: t('workspace.aiActivity.selectingSubject', 'Selecting the subject'),
    refine_subject: t('workspace.aiActivity.refiningSubject', 'Refining the subject edge'),
    follow_subject: t('workspace.aiActivity.followingSubject', 'Tracking the subject through the shot'),
    apply_subject_style: t('workspace.aiActivity.stylingSubject', 'Styling the subject'),
    track_point: t('workspace.aiActivity.trackingPoint', 'Tracking motion'),
    attach_to_track: t('workspace.aiActivity.attachingTrack', 'Attaching to the track'),
    transcribe: t('workspace.aiActivity.transcribing', 'Transcribing speech'),

    // ── Shapes and rigs ──
    merge_paths: t('workspace.aiActivity.mergingPaths', 'Merging paths'),
    set_trim_path: t('workspace.aiActivity.trimPaths', 'Revealing trim-path outlines'),
    add_repeater: repeaterBurst,
    add_path_operator: pathDistortion,
    create_puppet_rig: t('workspace.aiActivity.puppetPins', 'Rigging puppet pins'),
    set_puppet_pin_keyframes: t('workspace.aiActivity.animatingRig', 'Animating the rig'),
    create_skeleton_rig: t('workspace.aiActivity.buildingSkeleton', 'Building a skeleton'),
    pose_skeleton: t('workspace.aiActivity.posingSkeleton', 'Posing the skeleton'),

    // ── Compose recipes ──
    add_scene: t('workspace.aiActivity.settingUpScene', 'Setting up a scene'),
    add_transition: t('workspace.aiActivity.addingTransition', 'Adding a transition'),
    add_background: t('workspace.aiActivity.paintingBackground', 'Painting the background'),
    add_title: t('workspace.aiActivity.addingTitle', 'Adding a title'),
    add_kinetic_title: t('workspace.aiActivity.kineticType', 'Animating kinetic type'),
    add_emblem: t('workspace.aiActivity.buildingEmblem', 'Building the emblem'),
    add_cards: t('workspace.aiActivity.layingOutCards', 'Laying out cards'),
    add_lower_third: t('workspace.aiActivity.addingLowerThird', 'Adding a lower third'),
    add_ambient_orbs: t('workspace.aiActivity.ambientDepth', 'Adding ambient depth'),
    add_light_sweep: t('workspace.aiActivity.lightSweep', 'Adding a light sweep'),
    add_camera_move: t('workspace.aiActivity.cameraMove', 'Adding a camera move'),
    add_logo_reveal: t('workspace.aiActivity.logoReveal', 'Revealing the logo'),
    add_radial_burst: repeaterBurst,
    add_path_morph: pathDistortion,
    stagger_in: t('workspace.aiActivity.staggering', 'Staggering entrances'),
  };
}

/** A human label for the tool the model is running, shown while it works. */
function activityFor(toolName: string): string {
  return toolActivity()[toolName] ?? t('workspace.aiActivity.working', 'Working');
}

/** Maps a cloud project to its most recent AI thread, for the initial load. */
const convKey = (projectId: string): string => `motion_editor_ai_conv:${projectId}`;

function newConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

const readLocal = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeLocal = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

/**
 * Failures that say our picture of the account's key state is out of date, as
 * opposed to a transient provider problem. Anything here triggers a re-read of
 * `/ai/keys`; a rate limit or an overload does not, because nothing about the
 * account changed.
 */
const KEY_STATE_CODES: ReadonlySet<string> = new Set([
  'no_key',
  'auth',
  'coming_soon',
  'upgrade_required',
  'no_credits',
]);

function describeError(err: unknown): string {
  if (err instanceof AiError) {
    switch (err.code) {
      case 'no_key':
        // Dashboard → Settings → Assistant. It is deliberately not a dialog —
        // see the note in CustomizeDialog.tsx — so name the page it is on.
        return t('workspace.aiChat.errorNoKey', 'No API key for this provider yet — add one in Settings → Assistant.');
      case 'auth':
        return t('workspace.aiChat.errorAuth', 'That provider rejected the stored key. Re-enter it in Settings → Assistant.');
      case 'coming_soon':
        return t('workspace.aiChat.errorConnectKey', 'Connect your own API key in Settings → Assistant to use the assistant.');
      case 'upgrade_required':
        return t('workspace.aiChat.errorConnectKey', 'Connect your own API key in Settings → Assistant to use the assistant.');
      case 'no_credits':
        return err.message; // the server explains the credit balance
      case 'rate_limit':
        return err.retryAfterMs
          ? t('workspace.aiChat.errorRateLimitRetry', 'Rate limited by the provider. Try again in {seconds}s.', { seconds: Math.ceil(err.retryAfterMs / 1000) })
          : t('workspace.aiChat.errorRateLimit', 'Rate limited by the provider. Try again shortly.');
      case 'overloaded':
        return t('workspace.aiChat.errorOverloaded', 'The provider is overloaded right now. Try again in a moment.');
      case 'context_length':
        return t('workspace.aiChat.errorContextLength', 'This conversation got too long for the model. Start a new one.');
      case 'cancelled':
        return t('workspace.aiChat.errorCancelled', 'Cancelled — nothing was changed.');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t('workspace.aiChat.errorGeneric', 'The assistant could not complete that.');
}

export type PipelineStageStatus = 'pending' | 'active' | 'done';

export interface PipelineStage {
  label: string;
  status: PipelineStageStatus;
  /** performance.now() when the stage went active; the ledger ticks its time from it. */
  startedAt?: number;
  /** How long a done stage took, ms. */
  ms?: number;
}

/** One concrete build step (a tool call) shown as a live checklist item. */
export interface PlanItem {
  id: string;
  label: string;
  status: 'active' | 'done' | 'error';
}

/**
 * Ordered stage labels for the generative run's progress checklist.
 *
 * These MUST match the `onActivity` strings the run actually emits, and for a
 * long time they did not: the list still described the ten-stage client
 * PipelineOrchestrator (intent → creative → spec → storyboard → …) that Phase
 * 3.4 deleted. Every `matchStageIndex` lookup returned -1, so the checklist
 * never appeared — a dead panel the user was told existed.
 *
 * The caster's run is shorter because most of what those stages produced is now
 * emitted by code rather than asked of a model.
 *
 * Source of truth: `core/ai/CasterRunner.ts` — keep the two in step.
 */
export const PIPELINE_STAGE_LABELS = [
  'Writing the creative brief',
  'Casting layouts',
  'Casting motion',
  'Building the composition',
  'Reviewing the result',
] as const;

/**
 * The checklist per generative mode. Author mode is a different run with
 * different stages (source of truth: `core/ai/author/stages.ts`, emitted by
 * `AuthorRunner.ts`); showing the caster's list over it would be the same
 * promise-about-a-pipeline-that-is-not-running this table once was.
 */
export const PIPELINE_STAGE_LABELS_BY_MODE: Readonly<Record<'library' | 'author', readonly string[]>> = {
  library: PIPELINE_STAGE_LABELS,
  author: AUTHOR_STAGE_LABELS,
};

/** The four stages of the run card's rail (AiChatPanel): the detailed stage lists fold into these. */
export type RailStage = 'Plan' | 'Build' | 'Review' | 'Revise';
export interface RailStep {
  label: RailStage;
  status: PipelineStageStatus;
}

/** Which rail stage each detailed stage belongs to, per mode. */
const RAIL_OF: Readonly<Record<'library' | 'author', readonly RailStage[]>> = {
  // Writing the creative brief, casting layouts, casting motion, building, reviewing.
  library: ['Plan', 'Plan', 'Plan', 'Build', 'Review'],
  // Proposing concepts, designing, writing beats, building, reviewing, revising.
  author: ['Plan', 'Plan', 'Plan', 'Build', 'Review', 'Revise'],
};

/**
 * The rail from the detailed stages: a rail stage is done when every stage
 * in it is done, active when any is, else pending. Library mode has no
 * Revise stage, so its rail is three steps.
 */
export function railStages(stages: readonly PipelineStage[] | null, mode: 'library' | 'author'): RailStep[] {
  const map = RAIL_OF[mode];
  const order: RailStage[] = mode === 'author' ? ['Plan', 'Build', 'Review', 'Revise'] : ['Plan', 'Build', 'Review'];
  return order.map((label) => {
    const mine = (stages ?? []).filter((_, i) => map[i] === label);
    const status: PipelineStageStatus = !mine.length
      ? 'pending'
      : mine.every((s) => s.status === 'done')
        ? 'done'
        : mine.some((s) => s.status === 'active' || s.status === 'done')
          ? 'active'
          : 'pending';
    return { label, status };
  });
}

/** How many cells the live filmstrip of a run in progress has. */
export const LIVE_FRAME_CELLS = 6;
/** How often a cell of the live filmstrip is re-rendered while a run builds, ms. */
const LIVE_FRAME_EVERY_MS = 2500;

/** Map an onActivity label to its canonical stage index (-1 if not a stage). */
function matchStageIndex(label: string, mode: 'library' | 'author' = 'library'): number {
  const l = label.toLowerCase();
  if (mode === 'author') {
    return AUTHOR_STAGE_LABELS.findIndex((s) => l.startsWith(s.toLowerCase()));
  }
  if (l.includes('creative brief')) return 0;
  if (l.includes('casting layout')) return 1;
  if (l.includes('casting motion')) return 2;
  if (l.includes('building the composition')) return 3;
  if (l.includes('reviewing the result')) return 4;
  return -1;
}


export interface UseAiChat {
  messages: ChatMessage[];
  busy: boolean;
  /** Non-empty while the assistant is mid-sentence. */
  streaming: string;
  /** What the assistant is doing right now, e.g. "Reading the scene…". */
  activity: string;
  /** Pipeline stage list — populated only during generative pipeline runs. */
  pipelineStages: PipelineStage[] | null;
  /** Live checklist of build steps (tool calls) for the current/last run. */
  planItems: PlanItem[];
  ready: boolean;
  /** Stored threads for this project, newest activity first. */
  conversations: AiConversationSummary[];
  activeConversationId: string | null;
  submit: (prompt: string, images?: readonly PendingImage[], opts?: SubmitOptions) => Promise<void>;
  cancel: () => void;
  /** The generative mode of the run in flight (or the last one). */
  runMode: 'library' | 'author';
  /** The run card's four-stage rail, folded from `pipelineStages`. */
  rail: RailStep[];
  /** performance.now() when the run in flight started; null between runs. */
  runStartedAt: number | null;
  /** The name of the piece being built (the chosen concept), once known. */
  runTitle: string | null;
  /** Frames of the piece as it is built (object URLs, LIVE_FRAME_CELLS cells; '' = not yet). */
  liveFrames: string[];
  /**
   * The concept stage, waiting on the user: the three candidates and which
   * round of "three more" this is. Null when no choice is pending.
   */
  concepts: { concepts: ConceptOption[]; round: number } | null;
  /** Answer the concept stage (a pick, "three more" or "surprise me"). */
  pickConcept: (choice: ConceptChoice) => void;
  /** The last run's critique scores (1–10 per axis), when the critic gave them. */
  resultScores: Record<CritiqueAxis, number> | null;
  /** The concept the last run built, when it ran a concept stage. */
  resultConcept: ConceptOption | null;
  /** Discard the pending result and build the same brief on a different concept. */
  anotherTake: () => void;
  /** What Apply last committed: how many changes, for the line under the result. */
  lastApplied: { changes: number; title: string | null } | null;
  /** Start a fresh thread. The old one stays in the history list. */
  newChat: () => void;
  /** Reopen a stored thread. */
  openConversation: (id: string) => Promise<void>;
  /** Delete a stored thread; clears the panel if it was the open one. */
  removeConversation: (id: string) => Promise<void>;

  // V3 Architecture states
  isManualMode: boolean;
  toggleManualMode: (val: boolean) => void;
  hasPendingTx: boolean;
  pendingChanges: string[];
  acceptPending: () => void;
  discardPending: () => void;

  /**
   * Direction the user has set for generative runs.
   *
   * `casterPacks()` was exported for a UI to render from the day the caster
   * landed and nothing ever called it, so every run guessed a look the user may
   * already have decided.
   */
  direction: AiDirection;
  setDirection: (patch: Partial<AiDirection>) => void;
  /** The look packs the caster can be pointed at. */
  packs: readonly { id: string; displayName: string; intent: string }[];
  /** Frames sampled across the last result, for the preview strip. */
  filmstrip: string[];
}

export interface SubmitOptions {
  /** Concept names the concept stage must not offer again ("Another take"). */
  avoidConcepts?: readonly string[];
}

/** What the composer can pin. Every field is optional — unset means "you decide". */
export interface AiDirection {
  lookPackId?: string;
  accent?: string;
  energy?: number;
  totalDurationMs?: number;
  /** How many alternatives to emit and rank. 1 = the previous behaviour. */
  variants: number;
  /**
   * Author (the model writes the composition) or Library (the caster picks
   * templates). Unset = `authorModeDefault()`.
   */
  mode?: 'library' | 'author';
}

export function useAiChat(): UseAiChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [activity, setActivity] = useState('');
  const [pipelineStages, setPipelineStages] = useState<PipelineStage[] | null>(null);
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [conversations, setConversations] = useState<AiConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  /**
   * The mode of the run in flight. An author run that fails falls back to the
   * caster, whose labels then match the library list — so a label is tried
   * against the run's own mode first and the library's second.
   */
  const runModeRef = useRef<'library' | 'author'>('library');

  /** Advance the pipeline stage list when an onActivity label matches a stage. */
  const advancePipelineStage = useCallback((label: string) => {
    const l = label.toLowerCase();
    if (l.includes('pipeline failed') || l.includes('direct mode') || l.includes('error')) {
      setPipelineStages(null);
      return false;
    }
    let mode = runModeRef.current;
    let idx = matchStageIndex(label, mode);
    if (idx === -1 && mode === 'author') {
      idx = matchStageIndex(label, 'library');
      if (idx !== -1) mode = 'library';
    }
    if (idx === -1) return false;
    setPipelineStages((prev) => {
      // Each stage keeps its clock: a stage that was active ends now (its
      // duration is kept), the one going active starts now, a stage already
      // active stays on its own start.
      const now = performance.now();
      const stages: PipelineStage[] = PIPELINE_STAGE_LABELS_BY_MODE[mode].map((stLabel, i) => {
        const was = prev?.[i];
        const status: PipelineStageStatus = i < idx ? 'done' : i === idx ? 'active' : 'pending';
        const stage: PipelineStage = { label: stLabel, status };
        if (status === 'done') {
          const ms = was?.status === 'done' ? was.ms : was?.status === 'active' && was.startedAt !== undefined ? now - was.startedAt : undefined;
          if (ms !== undefined) stage.ms = ms;
        } else if (status === 'active') {
          stage.startedAt = was?.status === 'active' && was.startedAt !== undefined ? was.startedAt : now;
        }
        return stage;
      });
      return stages;
    });
    return true;
  }, []);

  // V3 state declarations
  /**
   * Composer direction. Defaults to nothing pinned and ONE variant.
   *
   * One, not three, because every extra variant is another full emit + three
   * linter passes, and a user who has not asked to compare directions should not
   * pay for the comparison. The control is opt-in.
   */
  const [direction, setDirectionState] = useState<AiDirection>({ variants: 1 });
  /**
   * The live direction, for `submit` to read.
   *
   * `submit` is a `useCallback` whose deps deliberately do not list everything
   * it reads — recreating it on every slider tick would churn the composer's
   * handler identity through a drag. The consequence was that `direction` was
   * captured at whatever it had been the last time the deps DID change, so a
   * user who picked a look pack, set an energy or chose a brand colour got the
   * PREVIOUS direction on the next run, and on a first-ever setting got none at
   * all.
   *
   * Since overriding what the model would guess is the composer's entire
   * purpose, that meant nearly every run fell through to "let the AI choose" —
   * a large part of why pieces looked alike whatever was selected.
   *
   * A ref rather than a wider dep array: the value is read once, at submit time,
   * and nothing renders from it here.
   */
  const directionRef = useRef<AiDirection>(direction);
  const setDirection = useCallback((patch: Partial<AiDirection>) => {
    setDirectionState((d) => {
      const next = { ...d, ...patch };
      // Assigned inside the updater rather than in an effect, so a click that
      // pins the pack and an Enter in the same tick cannot race a queued effect.
      directionRef.current = next;
      return next;
    });
  }, []);

  /** Frames sampled across the last result. Cleared when a new run starts. */
  const [filmstrip, setFilmstrip] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<'library' | 'author'>(() => authorModeDefault());
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runTitle, setRunTitle] = useState<string | null>(null);
  const [liveFrames, setLiveFrames] = useState<string[]>([]);
  const [concepts, setConcepts] = useState<{ concepts: ConceptOption[]; round: number } | null>(null);
  const [resultScores, setResultScores] = useState<Record<CritiqueAxis, number> | null>(null);
  const [resultConcept, setResultConcept] = useState<ConceptOption | null>(null);
  const [lastApplied, setLastApplied] = useState<{ changes: number; title: string | null } | null>(null);
  /** The concept gate's resolver while the stage waits on the user. */
  const conceptResolveRef = useRef<((c: ConceptChoice) => void) | null>(null);
  /** The last brief sent, for "Another take". */
  const lastSubmitRef = useRef<{ text: string; images?: readonly PendingImage[] } | null>(null);
  /** Object URLs of the live frames, revoked when the strip resets. */
  const liveUrlsRef = useRef<string[]>([]);
  const resetLiveFrames = useCallback(() => {
    for (const u of liveUrlsRef.current) if (u) URL.revokeObjectURL(u);
    liveUrlsRef.current = [];
    setLiveFrames([]);
  }, []);

  const [isManualMode, setIsManualMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('motion_editor_ai_manual_mode') === 'true';
    } catch {
      return false;
    }
  });
  const [hasPendingTx, setHasPendingTx] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<string[]>([]);
  const pendingTxRef = useRef<AiTransaction | null>(null);
  const pendingProseRef = useRef<{ user: string; assistant: string } | null>(null);

  /** The model-facing transcript, which is not the same as what's displayed. */
  const history = useRef<AiMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  /** The persisted thread; null when nothing has been said yet. */
  const conversationId = useRef<string | null>(null);

  // Subscribe to the raw state, not the ready getter — zustand only
  // re-renders on state identity, so a computed selector would go stale.
  const provider = useAiProviderStore((s) => s.provider);
  const status = useAiProviderStore((s) => s.status);
  const motion = useAiProviderStore((s) => s.motion);
  const refreshStatus = useAiProviderStore((s) => s.refreshStatus);
  const ready = provider === 'motion' ? !!motion?.present : !!status?.[provider]?.present;

  const projectId = useCloudProjectStore((s) => s.projectId);

  /**
   * Ask the gateway which providers this account can run.
   *
   * Cheap and idempotent (the store single-flights it), and it has to happen
   * here as well as after sign-in: the editor can be reached with a session
   * restored before this panel ever mounted, or with a key added on another
   * device since.
   */
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // Abandon an in-flight run if the panel unmounts.
  useEffect(() => () => {
    abort.current?.abort();
    if (pendingTxRef.current) {
      void pendingTxRef.current.rollback();
      pendingTxRef.current = null;
    }
  }, []);

  const toggleManualMode = useCallback((val: boolean) => {
    setIsManualMode(val);
    try {
      localStorage.setItem('motion_editor_ai_manual_mode', String(val));
    } catch {}
  }, []);

  const refreshConversations = useCallback(async () => {
    const bound = useCloudProjectStore.getState().projectId;
    const useCloud = aiRunsThroughBackend() && isAuthenticated() && !!bound;
    if (useCloud) {
      try {
        setConversations((await api.listConversations(bound ?? undefined, { limit: 50 })).items);
      } catch {
        /* the history list is a convenience — never surface a failure */
      }
      return;
    }
    const local = listLocalConversations(bound ?? 'local');
    setConversations(
      local.map((c) => ({
        id: c.id,
        title: c.title ?? c.messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? t('workspace.aiChat.untitled', 'Chat'),
        projectId: bound ?? 'local',
        createdAt: new Date(c.updatedAt).toISOString(),
        updatedAt: new Date(c.updatedAt).toISOString(),
      })),
    );
  }, []);

  /** Load a stored thread into the panel and the model-facing history. */
  const hydrate = useCallback(async (id: string): Promise<boolean> => {
    const bound = useCloudProjectStore.getState().projectId;
    const useCloud = aiRunsThroughBackend() && isAuthenticated() && !!bound;
    if (useCloud) {
      try {
        const conv = await api.getConversation(id);
        setMessages(conv.messages.map((m) => ({
          role: m.role,
          text: m.content,
          error: m.isError || undefined,
        })));
        history.current = conv.messages
          .filter((m) => !m.isError)
          .map((m) => ({ role: m.role, content: m.content } as AiMessage));
        conversationId.current = id;
        setActiveId(id);
        return true;
      } catch {
        return false;
      }
    }

    const conv = getLocalConversation(id);
    if (!conv) return false;
    setMessages(conv.messages.map((m) => ({
      role: m.role,
      text: m.content,
      error: m.isError || undefined,
    })));
    history.current = conv.messages
      .filter((m) => !m.isError)
      .map((m) => ({ role: m.role, content: m.content } as AiMessage));
    conversationId.current = id;
    setActiveId(id);
    return true;
  }, []);

  // On project switch: show the thread list and reopen the last-used thread.
  useEffect(() => {
    let live = true;
    if (pendingTxRef.current) {
      void pendingTxRef.current.rollback();
      pendingTxRef.current = null;
    }
    setHasPendingTx(false);
    setPendingChanges([]);
    pendingProseRef.current = null;

    history.current = [];
    setMessages([]);
    setConversations([]);
    conversationId.current = null;
    setActiveId(null);

    if (!projectId) {
      void refreshConversations();
      const stored = readLocal(convKey('local'));
      if (stored) void hydrate(stored);
      return;
    }

    void refreshConversations();

    const stored = readLocal(convKey(projectId));
    if (!stored) return;
    void (async () => {
      const ok = await hydrate(stored);
      if (!live) return;
      if (!ok) {
        // The thread is gone (deleted, or belongs to another account). Drop
        // the pointer and start fresh rather than retrying forever.
        conversationId.current = null;
        setActiveId(null);
        writeLocal(convKey(projectId), null);
      }
    })();

    return () => { live = false; };
  }, [projectId, hydrate, refreshConversations]);

  /**
   * Save a completed exchange. Best-effort: the edit already landed in the
   * user's document, so a storage hiccup must never surface as a failure.
   */
  const persist = useCallback(
    async (turns: { role: 'user' | 'assistant'; content: string; isError?: boolean }[]) => {
      const bound = useCloudProjectStore.getState().projectId;
      if (!turns.length) return;
      const id = conversationId.current ?? newConversationId();
      const useCloud = aiRunsThroughBackend() && isAuthenticated() && !!bound;

      if (!useCloud) {
        const projectKey = bound ?? 'local';
        appendLocalMessages(id, projectKey, turns, turns[0]?.content.slice(0, 60));
        conversationId.current = id;
        setActiveId(id);
        writeLocal(convKey(projectKey), id);
        void refreshConversations();
        return;
      }

      try {
        await api.appendMessages(id, {
          messages: turns,
          projectId: bound,
          title: turns[0]?.content.slice(0, 60),
        });
        conversationId.current = id;
        setActiveId(id);
        writeLocal(convKey(bound!), id);
        void refreshConversations();
      } catch {
        /* history is a convenience, not the product */
      }
    },
    [refreshConversations],
  );

  const acceptPending = useCallback(() => {
    if (!pendingTxRef.current) return;
    void pendingTxRef.current.commit();
    pendingTxRef.current = null;
    setHasPendingTx(false);
    setPendingChanges((c) => {
      setLastApplied({ changes: c.length, title: resultConcept?.name ?? null });
      return [];
    });

    if (pendingProseRef.current) {
      const { user, assistant } = pendingProseRef.current;
      history.current = pruneImageTurns([
        ...history.current,
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ]);
      void persist([
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ]);
      pendingProseRef.current = null;
    }
  }, [persist, resultConcept]);

  const discardPending = useCallback(() => {
    if (!pendingTxRef.current) return;
    void pendingTxRef.current.rollback();
    pendingTxRef.current = null;
    setHasPendingTx(false);
    setPendingChanges([]);
    pendingProseRef.current = null;

    // F16: clip by IDENTITY, not by count.
    //
    // `slice(0, -2)` assumed the last two entries were exactly this turn's user
    // message and its rejected answer. They are not, reliably: a turn that
    // errored before answering leaves one, and a turn that attached images or
    // emitted a notice leaves three — so discarding ate an unrelated earlier
    // message, or left the rejected one on screen.
    //
    // The turn is bounded by the LAST user message, which is unambiguous.
    setMessages((m) => {
      for (let i = m.length - 1; i >= 0; i--) {
        if (m[i]!.role === 'user') return m.slice(0, i);
      }
      return m;
    });
  }, []);

  const cancel = useCallback(() => {
    // A concept stage waiting on the user is part of the run: cancelling
    // the run answers it so the runner can unwind.
    conceptResolveRef.current?.({ kind: 'surprise' });
    conceptResolveRef.current = null;
    setConcepts(null);
    abort.current?.abort();
  }, []);

  const pickConcept = useCallback((choice: ConceptChoice) => {
    const resolve = conceptResolveRef.current;
    conceptResolveRef.current = null;
    setConcepts(null);
    resolve?.(choice);
  }, []);

  const newChat = useCallback(() => {
    abort.current?.abort();
    conceptResolveRef.current?.({ kind: 'surprise' });
    conceptResolveRef.current = null;
    setConcepts(null);
    setLastApplied(null);
    setResultScores(null);
    setResultConcept(null);
    resetLiveFrames();
    if (pendingTxRef.current) {
      void pendingTxRef.current.rollback();
      pendingTxRef.current = null;
    }
    setHasPendingTx(false);
    setPendingChanges([]);
    pendingProseRef.current = null;

    history.current = [];
    setMessages([]);
    setStreaming('');
    setActivity('');
    conversationId.current = null;
    setActiveId(null);
    const bound = useCloudProjectStore.getState().projectId;
    writeLocal(convKey(bound ?? 'local'), null);
  }, [resetLiveFrames]);

  const openConversation = useCallback(async (id: string) => {
    if (busy) return;
    const ok = await hydrate(id);
    if (ok) {
      const bound = useCloudProjectStore.getState().projectId;
      writeLocal(convKey(bound ?? 'local'), id);
    }
  }, [busy, hydrate]);

  const removeConversation = useCallback(async (id: string) => {
    const bound = useCloudProjectStore.getState().projectId;
    const useCloud = aiRunsThroughBackend() && isAuthenticated() && !!bound;
    if (useCloud) {
      try {
        await api.deleteConversation(id);
      } catch {
        /* already gone is as good as deleted */
      }
    } else {
      deleteLocalConversation(id);
    }
    if (conversationId.current === id) newChat();
    void refreshConversations();
  }, [newChat, refreshConversations]);

  const submit = useCallback(async (prompt: string, images?: readonly PendingImage[], opts: SubmitOptions = {}) => {
    const text = prompt.trim();
    if ((!text && !images?.length) || busy) return;
    lastSubmitRef.current = { text, ...(images?.length ? { images } : {}) };

    if (hasPendingTx) {
      acceptPending();
    }

    /**
     * Confirm the gate before spending a turn on it.
     *
     * `ready` can be optimistic — it is seeded from the cross-launch cache so
     * the composer is live on the first frame — so a stale "no key" must not
     * block a working setup, and a stale "has key" must not produce a confusing
     * provider error. One forced refresh settles it. If a provider IS connected
     * but not the selected one, `refreshStatus` re-points the selection, which
     * is the case that used to strand people who had a key the whole time.
     */
    if (!useAiProviderStore.getState().ready()) {
      // Held busy across the round trip, or a second Enter during it starts a
      // second run — the `busy` guard above is the only thing stopping that.
      setBusy(true);
      try {
        await useAiProviderStore.getState().refreshStatus({ force: true });
      } finally {
        setBusy(false);
      }
      if (!useAiProviderStore.getState().ready()) {
        setMessages((m) => [
          ...m,
          { role: 'user', text, images: images?.map((i) => i.dataUrl) },
          {
            role: 'assistant',
            text: useAiProviderStore.getState().anyReady()
              ? t('workspace.aiChat.providerNotConnected', 'That provider is not connected on this account. Pick another one in the model menu below.')
              : t('workspace.aiChat.connectProvider', 'Connect an AI provider first — Dashboard → Settings → Assistant.'),
            error: true,
          },
        ]);
        return;
      }
    }

    // Both read live, not from this callback's closure. `projectId` came from a
    // zustand subscription that is not in the dep array, so the id sent to the
    // backend was whatever it had been when `submit` was last rebuilt — which
    // defeated project and conversation memory on exactly the runs after a
    // project switch.
    const pinned = directionRef.current;
    const runMode = pinned.mode ?? authorModeDefault();
    runModeRef.current = runMode;
    setRunMode(runMode);
    const boundProjectId = useCloudProjectStore.getState().projectId;

    const attachments = (images ?? []).map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 }));
    const storedText = attachments.length
      ? `[${attachments.length} reference image${attachments.length > 1 ? 's' : ''} attached]\n${text}`
      : text;

    setMessages((m) => [...m, { role: 'user', text, images: images?.map((i) => i.dataUrl) }]);
    setBusy(true);
    setStreaming('');
    setActivity(t('workspace.aiActivity.reading', 'Reading the scene'));
    setPipelineStages(null); // reset from any prior run
    setPlanItems([]);
    setFilmstrip([]);
    setRunStartedAt(performance.now());
    setRunTitle(null);
    setResultScores(null);
    setResultConcept(null);
    setLastApplied(null);
    resetLiveFrames();

    const controller = new AbortController();
    abort.current = controller;

    // The live filmstrip: once the build has started writing layers, one cell
    // of the strip is re-rendered every few seconds (round-robin over the
    // piece's duration), so a tool-heavy run shows what it is making rather
    // than a spinner. Stills come from the engine (engineCompStill); a cell
    // that cannot render stays as it was.
    let liveCell = 0;
    let liveBusy = false;
    let liveStarted = false;
    const liveTimer = window.setInterval(() => {
      if (!liveStarted || liveBusy || controller.signal.aborted) return;
      const comp = activeCompIdNow();
      if (!comp) return;
      const c = activeCompSettingsNow();
      const d = settingsDurationSeconds(c, DEFAULT_COMPOSITION.durationSeconds);
      const cell = liveCell;
      liveCell = (liveCell + 1) % LIVE_FRAME_CELLS;
      liveBusy = true;
      void engineCompStill(comp, (d * (cell + 0.5)) / LIVE_FRAME_CELLS, 320)
        .then((blob) => {
          if (!blob || controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          const old = liveUrlsRef.current[cell];
          if (old) URL.revokeObjectURL(old);
          liveUrlsRef.current[cell] = url;
          setLiveFrames(Array.from({ length: LIVE_FRAME_CELLS }, (_, i) => liveUrlsRef.current[i] ?? ''));
        })
        .catch(() => { /* a cell that did not render keeps its last frame */ })
        .finally(() => { liveBusy = false; });
    }, LIVE_FRAME_EVERY_MS);

    try {
      const ai = useAiProviderStore.getState();
      const result = await runAgent(text || 'Use the attached image as the reference.', {
        // The concept stage (author mode): the panel shows the three candidates
        // and this promise waits for the user's answer.
        chooseConcept: (list, round) => new Promise<ConceptChoice>((resolve) => {
          conceptResolveRef.current = resolve;
          setConcepts({ concepts: list, round });
          setActivity(t('workspace.aiActivity.waitingForPick', 'Waiting for your pick'));
        }),
        ...(opts.avoidConcepts?.length ? { avoidConcepts: opts.avoidConcepts } : {}),
        provider: ai.provider,
        dialect: ai.dialect(),
        model: ai.model(),
        signal: controller.signal,
        // F7: this was hardcoded `true` while `isManualMode` sat in the effect
        // dependency array and was never read — the toggle was UI with nothing
        // behind it. Manual mode holds the transaction open for Apply/Discard;
        // auto mode commits when the run finishes.
        preview: isManualMode,
        // What the AI made last, so the next piece is not its twin (variety.ts).
        pieceHistory: aiPieceHistory,
        // Only the fields the user actually pinned. Sending `energy: undefined`
        // and sending nothing are the same to the caster, but building the
        // object conditionally keeps "unset" meaning "the model decides".
        // Read through the ref, never the closed-over `direction` — see
        // `directionRef`. Reading the state here is what silently discarded the
        // composer's whole direction bar on the run that followed a change.
        ...(pinned.lookPackId || pinned.accent || pinned.energy !== undefined || pinned.totalDurationMs
          ? {
              direction: {
                ...(pinned.lookPackId ? { lookPackId: pinned.lookPackId } : {}),
                ...(pinned.accent ? { accent: pinned.accent } : {}),
                ...(pinned.energy !== undefined ? { energy: pinned.energy } : {}),
                ...(pinned.totalDurationMs ? { totalDurationMs: pinned.totalDurationMs } : {}),
              },
            }
          : {}),
        ...(pinned.variants > 1 ? { variants: pinned.variants } : {}),
        mode: runMode,
        history: history.current.slice(-HISTORY_TURNS),
        images: attachments.length ? attachments : undefined,
        // Both ids were already live in this hook and neither was ever passed
        // on, so the backend's project and conversation memory keyed on
        // `undefined` and every run started from nothing. This is what lets run
        // #10 be better than run #1.
        ...(boundProjectId ? { projectId: boundProjectId } : {}),
        ...(conversationId.current ? { conversationId: conversationId.current } : {}),
        events: {
          // Stream the answer as it arrives, so the panel isn't dead air while
          // the model plans and works.
          onText: (delta: string) => setStreaming((s) => s + delta),
          // Name the tool the model is running right now, and append it to the
          // live plan checklist so the user watches steps complete one by one.
          onToolStart: (call: AiToolCall) => {
            const label = activityFor(call.name);
            setActivity(label);
            liveStarted = true;
            setPlanItems((items) => [...items, { id: call.id, label, status: 'active' }]);
          },
          onToolEnd: (call: AiToolCall, ok: boolean) => {
            setPlanItems((items) =>
              items.map((it) => (it.id === call.id ? { ...it, status: ok ? 'done' : 'error' } : it)),
            );
          },
          // Free-form status — also drives the pipeline stage tracker.
          onActivity: (label: string) => {
            setActivity(label);
            advancePipelineStage(label);
          },
        },
      });

      const answer = result.text || t('workspace.aiChat.done', 'Done.');
      setStreaming('');
      setMessages((m) => [...m, { role: 'assistant', text: answer }]);
      setResultScores(result.scores ?? null);
      setResultConcept(result.concept ?? null);
      if (result.concept) setRunTitle(result.concept.name);

      // A filmstrip, not a snapshot. `renderCritiqueEvidence` has built one for
      // the fit critic since the caster landed and the user has never seen it —
      // and one still frame is a poor preview of a moving piece, especially when
      // the thing most likely to be wrong is the timing between frames.
      if (result.changes.length) {
        try {
          const { renderSceneFrames } = await import('@core/ai/renderFeedback');
          const c = activeCompSettingsNow();
          const d = settingsDurationSeconds(c, DEFAULT_COMPOSITION.durationSeconds);
          const fps = settingsFps(c, DEFAULT_COMPOSITION.fps);
          const shots = await renderSceneFrames([d * 0.08, d * 0.3, d * 0.55, d * 0.8, Math.max(0, d - 1 / fps)]);
          setFilmstrip(shots.map((img) => `data:${img.mediaType};base64,${img.dataBase64}`));
        } catch {
          // A preview that could not render is not a failed run.
          setFilmstrip([]);
        }
      }

      if (result.tx) {
        // Hold open transaction for review: Apply commits it, Discard rolls it back.
        pendingTxRef.current = result.tx;
        pendingProseRef.current = { user: storedText, assistant: answer };
        setPendingChanges(result.changes);
        setHasPendingTx(true);
      } else {
        history.current = pruneImageTurns([
          ...history.current,
          { role: 'user', content: text, ...(attachments.length ? { images: attachments } : {}) },
          ...result.messages,
        ]);
        void persist([
          { role: 'user', content: storedText },
          { role: 'assistant', content: answer },
        ]);
      }
    } catch (err) {
      const reason = describeError(err);
      setMessages((m) => [...m, { role: 'assistant', text: reason, error: true }]);
      // The gateway just contradicted what we believe about this account's keys
      // — a key removed on another device, a plan that changed, credits spent.
      // Re-read it, which also re-points the selection at a provider that still
      // works, so the NEXT prompt succeeds instead of failing the same way.
      if (err instanceof AiError && KEY_STATE_CODES.has(err.code)) {
        void useAiProviderStore.getState().refreshStatus({ force: true });
      }
      void persist([
        { role: 'user', content: storedText },
        { role: 'assistant', content: reason, isError: true },
      ]);
    } finally {
      window.clearInterval(liveTimer);
      conceptResolveRef.current = null;
      setConcepts(null);
      setRunStartedAt(null);
      setStreaming('');
      setActivity('');
      setBusy(false);
      abort.current = null;
      // Mark all pipeline stages as done once finished
      setPipelineStages((prev) => {
        if (!prev) return null;
        const now = performance.now();
        return prev.map((s) => {
          const done: PipelineStage = { label: s.label, status: 'done' };
          const ms = s.status === 'done' ? s.ms : s.status === 'active' && s.startedAt !== undefined ? now - s.startedAt : undefined;
          if (ms !== undefined) done.ms = ms;
          return done;
        });
      });
      // A run that ended (success or abort) has no in-flight steps left.
      setPlanItems((items) => items.map((it) => (it.status === 'active' ? { ...it, status: 'done' } : it)));
    }
  }, [busy, hasPendingTx, isManualMode, persist, resetLiveFrames]);

  /** The same brief again, on a concept other than the one just built. */
  const anotherTake = useCallback(() => {
    const last = lastSubmitRef.current;
    if (!last || busy) return;
    const avoid = resultConcept ? [resultConcept.name] : [];
    if (pendingTxRef.current) discardPending();
    void submit(last.text, last.images, avoid.length ? { avoidConcepts: avoid } : {});
  }, [busy, resultConcept, discardPending, submit]);

  const rail = railStages(pipelineStages, runMode);

  return {
    messages,
    busy,
    streaming,
    activity,
    pipelineStages,
    planItems,
    ready,
    conversations,
    activeConversationId: activeId,
    submit,
    cancel,
    newChat,
    openConversation,
    removeConversation,

    isManualMode,
    toggleManualMode,
    hasPendingTx,
    pendingChanges,
    acceptPending,
    discardPending,

    direction,
    setDirection,
    packs: PACKS,
    filmstrip,

    runMode,
    rail,
    runStartedAt,
    runTitle,
    liveFrames,
    concepts,
    pickConcept,
    resultScores,
    resultConcept,
    anotherTake,
    lastApplied,
  };
}

/** Internals exposed so the registry-drift test can read the mapping. */
export const __testables = {
  activityFor,
  // A getter: building the table runs `t()`, which must not happen at module scope.
  get MAPPED_TOOL_NAMES(): string[] { return Object.keys(toolActivity()); },
  matchStageIndex,
};
