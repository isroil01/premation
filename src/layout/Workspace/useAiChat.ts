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

/** A human label for the tool the model is running, shown while it works. */
function activityFor(toolName: string): string {
  switch (toolName) {
    case 'describe_scene':
    case 'read_tracks':
    case 'evaluate_at':
    case 'get_selection':
    case 'list_capabilities':
    case 'list_presets':
      return 'Reading the scene';
    case 'create_layer':
      return 'Creating layers';
    case 'delete_layer':
      return 'Removing layers';
    case 'set_keyframes':
    case 'set_easing':
    case 'remove_keyframes':
    case 'apply_preset':
    case 'text_animator':
      return 'Animating';
    case 'add_effect':
    case 'update_effect':
      return 'Applying effects';
    case 'set_expression':
      return 'Writing expressions';
    case 'update_layer':
    case 'reparent_layer':
    case 'update_composition':
      return 'Editing layers';
    // High-level composition steps — describe what's being built, not "Working".
    case 'add_scene':
      return 'Setting up a scene';
    case 'add_transition':
      return 'Adding a transition';
    case 'add_background':
      return 'Painting the background';
    case 'add_title':
      return 'Adding a title';
    case 'add_kinetic_title':
      return 'Animating kinetic type';
    case 'add_emblem':
      return 'Building the emblem';
    case 'add_cards':
      return 'Laying out cards';
    case 'add_lower_third':
      return 'Adding a lower third';
    case 'add_ambient_orbs':
      return 'Adding ambient depth';
    case 'add_light_sweep':
      return 'Adding a light sweep';
    case 'add_camera_move':
      return 'Adding a camera move';
    case 'stagger_in':
      return 'Staggering entrances';
    case 'create_media':
    case 'create_media_from_attachment':
      return 'Placing media';
    case 'create_mask':
      return 'Masking';
    default:
      return 'Working';
  }
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

function describeError(err: unknown): string {
  if (err instanceof AiError) {
    switch (err.code) {
      case 'no_key':
        return 'No API key yet — add one in Customize → AI.';
      case 'auth':
        return 'Sign in and check your API key in Customize → AI.';
      case 'coming_soon':
        return 'Motion AI is still in development — connect your own provider key for now.';
      case 'upgrade_required':
        return 'Motion AI is a Pro feature. Upgrade your plan, or connect your own API key in Settings.';
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

/** Ordered pipeline stage labels — must match PipelineOrchestrator onActivity calls. */
export const PIPELINE_STAGE_LABELS = [
  'Optimizing prompt',
  'Analyzing intent',
  'Directing creative visual',
  'Generating motion spec',
  'Storyboarding scene',
  'Planning scenes in parallel',
  'Planning cameras & animations',
  'Merging global timeline',
  'Authoring tool plan steps',
  'Reviewing production plan',
  'Executing planned production steps',
] as const;

/** Map an onActivity label to its canonical stage index (-1 if not a pipeline stage). */
function matchStageIndex(label: string): number {
  const l = label.toLowerCase();
  if (l.includes('optimizing prompt')) return 0;
  if (l.includes('analyzing intent')) return 1;
  if (l.includes('directing creative')) return 2;
  if (l.includes('generating motion')) return 3;
  if (l.includes('storyboard')) return 4;
  if (l.includes('planning') && l.includes('scene')) return 5;
  if (l.includes('cameras') || l.includes('animations')) return 6;
  if (l.includes('timeline')) return 7;
  if (l.includes('tool plan') || l.includes('authoring')) return 8;
  if (l.includes('reviewing') || l.includes('critique')) return 9;
  if (l.includes('executing')) return 10;
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

  // Subscribe to the raw state, not the ready() getter — zustand only
  // re-renders on state identity, so a computed selector would go stale.
  const provider = useAiProviderStore((s) => s.provider);
  const status = useAiProviderStore((s) => s.status);
  const motion = useAiProviderStore((s) => s.motion);
  const refreshStatus = useAiProviderStore((s) => s.refreshStatus);
  const ready = provider === 'motion' ? !!motion?.present : !!status?.[provider]?.present;

  const projectId = useCloudProjectStore((s) => s.projectId);

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

    // Revert visually by clipping messages list back to omit user query and rejected text
    setMessages((m) => m.slice(0, -2));
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

    const controller = new AbortController();
    abort.current = controller;

    try {
      const ai = useAiProviderStore.getState();
      const result = await runAgent(text || 'Use the attached image as the reference.', {
        provider: ai.provider,
        dialect: ai.dialect(),
        model: ai.model(),
        signal: controller.signal,
        preview: true, // Always run in preview transaction mode so Apply/Discard works
        history: history.current.slice(-HISTORY_TURNS),
        images: attachments.length ? attachments : undefined,
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
  };
}
