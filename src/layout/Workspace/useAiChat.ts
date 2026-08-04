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
import { AiError, runAgent } from '@core/ai/AgentLoop';
import { type AiTransaction } from '@core/ai/aiTransaction';
import type { PendingImage } from '@core/ai/imageAttachment';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { casterPacks } from '@core/ai/CasterRunner';
import { api, isAuthenticated, type AiConversationSummary } from '@core/api/client';

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
 */
const TOOL_ACTIVITY: Record<string, string> = {
  // ── Read ──
  describe_scene: 'Reading the scene',
  read_tracks: 'Reading the scene',
  evaluate_at: 'Reading the scene',
  get_selection: 'Reading the scene',
  list_capabilities: 'Reading the scene',
  list_presets: 'Reading the scene',
  analyse_audio: 'Reading the scene',

  // ── Structure ──
  create_layer: 'Creating layers',
  delete_layer: 'Removing layers',
  update_layer: 'Editing layers',
  reparent_layer: 'Editing layers',
  update_composition: 'Editing layers',
  create_precomp: 'Nesting a precomp',

  // ── Animation ──
  set_keyframes: 'Animating',
  set_easing: 'Animating',
  remove_keyframes: 'Animating',
  apply_preset: 'Animating',
  text_animator: 'Animating type',
  set_spring: 'Solving spring physics',
  set_time_remap: 'Retiming',
  set_expression: 'Writing expressions',
  set_motion_blur: 'Setting the shutter',

  // ── Look ──
  add_effect: 'Applying effects',
  update_effect: 'Applying effects',
  update_effect_param: 'Tuning effects',
  set_shadow_stack: 'Building depth',
  add_surface_treatment: 'Adding grain and vignette',
  create_gradient: 'Painting the backdrop',
  set_light: 'Lighting the scene',
  apply_layer_style: 'Styling layers',
  recolor_lottie_vector: 'Recolouring vectors',

  // ── Media and masks ──
  create_media: 'Placing media',
  // Named, and named honestly: this one takes seconds and costs credits, so
  // "Working" would leave the user watching a spinner with no idea why.
  generate_image: 'Generating imagery',
  import_svg: 'Drawing vectors',
  create_media_from_attachment: 'Placing media',
  create_mask: 'Masking',

  // ── Shapes and rigs ──
  merge_paths: 'Merging paths',
  set_trim_path: 'Revealing trim-path outlines',
  add_repeater: 'Adding shape repeater burst',
  add_path_operator: 'Morphing vector path distortion',
  create_puppet_rig: 'Rigging puppet pins',
  set_puppet_pin_keyframes: 'Animating the rig',
  create_skeleton_rig: 'Building a skeleton',
  pose_skeleton: 'Posing the skeleton',

  // ── Compose recipes ──
  add_scene: 'Setting up a scene',
  add_transition: 'Adding a transition',
  add_background: 'Painting the background',
  add_title: 'Adding a title',
  add_kinetic_title: 'Animating kinetic type',
  add_emblem: 'Building the emblem',
  add_cards: 'Laying out cards',
  add_lower_third: 'Adding a lower third',
  add_ambient_orbs: 'Adding ambient depth',
  add_light_sweep: 'Adding a light sweep',
  add_camera_move: 'Adding a camera move',
  add_logo_reveal: 'Revealing the logo',
  add_radial_burst: 'Adding shape repeater burst',
  add_path_morph: 'Morphing vector path distortion',
  stagger_in: 'Staggering entrances',
};

/** A human label for the tool the model is running, shown while it works. */
function activityFor(toolName: string): string {
  return TOOL_ACTIVITY[toolName] ?? 'Working';
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
        return 'No API key for this provider yet — add one in Settings → Assistant.';
      case 'auth':
        return 'That provider rejected the stored key. Re-enter it in Settings → Assistant.';
      case 'coming_soon':
        return 'Connect your own API key in Settings → Assistant to use the assistant.';
      case 'upgrade_required':
        return 'Connect your own API key in Settings → Assistant to use the assistant.';
      case 'no_credits':
        return err.message; // the server explains the credit balance
      case 'rate_limit':
        return `Rate limited by the provider.${err.retryAfterMs ? ` Try again in ${Math.ceil(err.retryAfterMs / 1000)}s.` : ' Try again shortly.'}`;
      case 'overloaded':
        return 'The provider is overloaded right now. Try again in a moment.';
      case 'context_length':
        return 'This conversation got too long for the model. Start a new one.';
      case 'cancelled':
        return 'Cancelled — nothing was changed.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'The assistant could not complete that.';
}

export type PipelineStageStatus = 'pending' | 'active' | 'done';

export interface PipelineStage {
  label: string;
  status: PipelineStageStatus;
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

/** Map an onActivity label to its canonical stage index (-1 if not a stage). */
function matchStageIndex(label: string): number {
  const l = label.toLowerCase();
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
  submit: (prompt: string, images?: readonly PendingImage[]) => Promise<void>;
  cancel: () => void;
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

/** What the composer can pin. Every field is optional — unset means "you decide". */
export interface AiDirection {
  lookPackId?: string;
  accent?: string;
  energy?: number;
  totalDurationMs?: number;
  /** How many alternatives to emit and rank. 1 = the previous behaviour. */
  variants: number;
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

  /** Advance the pipeline stage list when an onActivity label matches a stage. */
  const advancePipelineStage = useCallback((label: string) => {
    const l = label.toLowerCase();
    if (l.includes('pipeline failed') || l.includes('direct mode') || l.includes('error')) {
      setPipelineStages(null);
      return false;
    }
    const idx = matchStageIndex(label);
    if (idx === -1) return false;
    setPipelineStages((prev) => {
      const stages: PipelineStage[] = PIPELINE_STAGE_LABELS.map((stLabel, i) => ({
        label: stLabel,
        status: i < idx ? 'done' : i === idx ? 'active' : 'pending',
      }));
      void prev; // suppress unused warning
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
      pendingTxRef.current.rollback();
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
    if (!isAuthenticated()) return;
    try {
      const bound = useCloudProjectStore.getState().projectId;
      setConversations((await api.listConversations(bound ?? undefined, { limit: 50 })).items);
    } catch {
      /* the history list is a convenience — never surface a failure */
    }
  }, []);

  /** Load a stored thread into the panel and the model-facing history. */
  const hydrate = useCallback(async (id: string): Promise<boolean> => {
    try {
      const conv = await api.getConversation(id);
      setMessages(conv.messages.map((m) => ({
        role: m.role,
        text: m.content,
        error: m.isError || undefined,
      })));
      // Failed turns are warnings for the user, not prose the model said —
      // replaying them would pollute its context with error copy.
      history.current = conv.messages
        .filter((m) => !m.isError)
        .map((m) => ({ role: m.role, content: m.content } as AiMessage));
      conversationId.current = id;
      setActiveId(id);
      return true;
    } catch {
      return false;
    }
  }, []);

  // On project switch: show the thread list and reopen the last-used thread.
  useEffect(() => {
    let live = true;
    if (pendingTxRef.current) {
      pendingTxRef.current.rollback();
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

    if (!projectId) return;

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
      if (!bound || !turns.length) return;
      const id = conversationId.current ?? newConversationId();
      try {
        await api.appendMessages(id, {
          messages: turns,
          projectId: bound,
          title: turns[0]?.content.slice(0, 60),
        });
        conversationId.current = id;
        setActiveId(id);
        writeLocal(convKey(bound), id);
        void refreshConversations();
      } catch {
        /* history is a convenience, not the product */
      }
    },
    [refreshConversations],
  );

  const acceptPending = useCallback(() => {
    if (!pendingTxRef.current) return;
    pendingTxRef.current.commit();
    pendingTxRef.current = null;
    setHasPendingTx(false);
    setPendingChanges([]);

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
  }, [persist]);

  const discardPending = useCallback(() => {
    if (!pendingTxRef.current) return;
    pendingTxRef.current.rollback();
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

  const cancel = useCallback(() => abort.current?.abort(), []);

  const newChat = useCallback(() => {
    abort.current?.abort();
    if (pendingTxRef.current) {
      pendingTxRef.current.rollback();
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
    if (bound) writeLocal(convKey(bound), null);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    if (busy) return;
    const ok = await hydrate(id);
    if (ok) {
      const bound = useCloudProjectStore.getState().projectId;
      if (bound) writeLocal(convKey(bound), id);
    }
  }, [busy, hydrate]);

  const removeConversation = useCallback(async (id: string) => {
    try {
      await api.deleteConversation(id);
    } catch {
      /* already gone is as good as deleted */
    }
    if (conversationId.current === id) newChat();
    void refreshConversations();
  }, [newChat, refreshConversations]);

  const submit = useCallback(async (prompt: string, images?: readonly PendingImage[]) => {
    const text = prompt.trim();
    if ((!text && !images?.length) || busy) return;

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
              ? 'That provider is not connected on this account. Pick another one in the model menu below.'
              : 'Connect an AI provider first — Dashboard → Settings → Assistant.',
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
    const boundProjectId = useCloudProjectStore.getState().projectId;

    const attachments = (images ?? []).map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 }));
    const storedText = attachments.length
      ? `[${attachments.length} reference image${attachments.length > 1 ? 's' : ''} attached]\n${text}`
      : text;

    setMessages((m) => [...m, { role: 'user', text, images: images?.map((i) => i.dataUrl) }]);
    setBusy(true);
    setStreaming('');
    setActivity('Reading the scene');
    setPipelineStages(null); // reset from any prior run
    setPlanItems([]);
    setFilmstrip([]);

    const controller = new AbortController();
    abort.current = controller;

    try {
      const ai = useAiProviderStore.getState();
      const result = await runAgent(text || 'Use the attached image as the reference.', {
        provider: ai.provider,
        dialect: ai.dialect(),
        model: ai.model(),
        signal: controller.signal,
        // F7: this was hardcoded `true` while `isManualMode` sat in the effect
        // dependency array and was never read — the toggle was UI with nothing
        // behind it. Manual mode holds the transaction open for Apply/Discard;
        // auto mode commits when the run finishes.
        preview: isManualMode,
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

      const answer = result.text || 'Done.';
      setStreaming('');
      setMessages((m) => [...m, { role: 'assistant', text: answer }]);

      // A filmstrip, not a snapshot. `renderCritiqueEvidence` has built one for
      // the fit critic since the caster landed and the user has never seen it —
      // and one still frame is a poor preview of a moving piece, especially when
      // the thing most likely to be wrong is the timing between frames.
      if (result.changes.length) {
        try {
          const { renderSceneFrames } = await import('@core/ai/renderFeedback');
          const c = useCompositionStore.getState().comp();
          const d = c.durationSeconds;
          const shots = await renderSceneFrames([d * 0.08, d * 0.3, d * 0.55, d * 0.8, Math.max(0, d - 1 / c.fps)]);
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
      setStreaming('');
      setActivity('');
      setBusy(false);
      abort.current = null;
      // Mark all pipeline stages as done once finished
      setPipelineStages((prev) =>
        prev ? prev.map((s) => ({ ...s, status: 'done' as PipelineStageStatus })) : null
      );
      // A run that ended (success or abort) has no in-flight steps left.
      setPlanItems((items) => items.map((it) => (it.status === 'active' ? { ...it, status: 'done' } : it)));
    }
  }, [busy, hasPendingTx, isManualMode, persist]);

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
  };
}

/** Internals exposed so the registry-drift test can read the mapping. */
export const __testables = {
  activityFor,
  MAPPED_TOOL_NAMES: Object.keys(TOOL_ACTIVITY),
  matchStageIndex,
};
