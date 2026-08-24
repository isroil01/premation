/**
 * AiChatPanel — the AI assistant, docked as a left-sidebar tab.
 *
 * Layout (top → bottom): header (new chat / history), scrolling thread
 * (messages, live plan checklist, result preview with Apply/Decline), and a
 * composer pinned at the bottom with the prompt textarea and a provider/model
 * picker row — the ChatGPT/Claude-style arrangement.
 *
 * All chat state lives in AiChatContext (hoisted above the dock tree), so
 * switching sidebar tabs mid-run neither cancels the run nor rolls back a
 * pending preview transaction.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { Icon } from '@components/Icon';
import { useAiProviderStore } from '@stores/aiProviderStore';

import type { GatewayProviderId, AiProviderId } from '@core/api/client';
import { processImageFile, type PendingImage } from '@core/ai/imageAttachment';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAiChatContext } from './AiChatContext';
import { openAiSettings } from '@layout/Settings/CustomizeDialog';
import styles from './AiChatPanel.module.css';

/** BYOK providers offered in the picker, in display order. */
const PROVIDER_OPTIONS: { id: GatewayProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
];

/** Fixed preview snapshot size (16:9), independent of sidebar width. */
const PREVIEW_W = 240;
const PREVIEW_H = 135;

const MAX_IMAGES = 3;

function renderProviderIcon(provider: GatewayProviderId): JSX.Element {
  switch (provider) {
    case 'gemini':
      // Google Gemini spark — the four curved lobes, brand blue→purple gradient.
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" style={{ flex: 'none' }}>
          <defs>
            <linearGradient id="ai-gemini-grad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#4796E3" />
              <stop offset="55%" stopColor="#9177C7" />
              <stop offset="100%" stopColor="#D3667C" />
            </linearGradient>
          </defs>
          <path
            fill="url(#ai-gemini-grad)"
            d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12"
          />
        </svg>
      );
    case 'anthropic':
      // Anthropic wordmark "A" — the official slanted double-stroke glyph, coral.
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ flex: 'none', color: '#d97757' }}>
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </svg>
      );
    case 'openai':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ flex: 'none', color: '#10a37f' }}>
          <path d="M22.28 9.82a5.984 5.984 0 0 0-.52-4.91 6.046 6.046 0 0 0-6.51-2.9 6.065 6.065 0 0 0-4.73-2.01 6.015 6.015 0 0 0-5.76 4.19 6.05 6.05 0 0 0-4.3 2.92 5.986 5.986 0 0 0 .74 6.55 5.984 5.984 0 0 0 .52 4.91 6.046 6.046 0 0 0 6.51 2.9 6.06 6.06 0 0 0 4.73 2.01 6.014 6.014 0 0 0 5.76-4.19 6.05 6.05 0 0 0 4.3-2.92 5.985 5.985 0 0 0-.74-6.55Zm-9.52 11.66a4.47 4.47 0 0 1-2.61-.84c.03-.02.09-.05.13-.08l3.41-1.97a.78.78 0 0 0 .39-.68v-4.8l1.44.83a.74.74 0 0 0 .38.1v4.06a4.502 4.502 0 0 1-3.14 3.38Zm-7.39-3.26a4.48 4.48 0 0 1-.58-2.67c.03.02.08.05.13.08l3.41 1.97a.78.78 0 0 0 .78 0l4.16-2.4v1.67a.77.77 0 0 0 .19.55l-3.52 2.03a4.505 4.505 0 0 1-4.57-.23Zm-1.46-8.03a4.48 4.48 0 0 1 2.03-1.83v4.11a.76.76 0 0 0 .39.67l4.16 2.4-1.44.83a.78.78 0 0 0-.39.68v4.06a4.5 4.5 0 0 1-4.75-1.49 4.46 4.46 0 0 1 0-9.43Zm14.62 3.26-4.16-2.4 1.44-.83a.78.78 0 0 0 .39-.68V5.48a4.5 4.5 0 0 1 4.75 1.49 4.46 4.46 0 0 1 0 9.43 4.48 4.48 0 0 1-2.03 1.83V14.1a.76.76 0 0 0-.39-.67Zm1.46-4.77c-.03-.02-.08-.05-.13-.08l-3.41-1.97a.78.78 0 0 0-.78 0l-4.16 2.4V7.59a.77.77 0 0 0-.19-.55l3.52-2.03a4.505 4.505 0 0 1 4.57.23 4.48 4.48 0 0 1 .58 2.67Zm-8.49-5.18a4.47 4.47 0 0 1 2.61.84c-.03.02-.09.05-.13.08l-3.41 1.97a.78.78 0 0 0-.39.68v4.8l-1.44-.83a.74.74 0 0 0-.38-.1V4.93a4.502 4.502 0 0 1 3.14-3.38Zm-1.5 6.27 2.5-1.44 2.5 1.44v2.89l-2.5 1.44-2.5-1.44V9.52Z" />
        </svg>
      );
    case 'motion':
    default:
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ flex: 'none', color: '#2988ff' }}>
          <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
        </svg>
      );
  }
}

/**
 * Model id → display name.
 *
 * Ordered LONGEST-PREFIX-FIRST, because these are substring tests: `claude-opus-5`
 * must be checked before any shorter `claude-opus` prefix, and `gpt-4o-mini`
 * before `gpt-4o`. The list had no entry at all for `claude-opus-5` — the default
 * model — so the most common case fell through and displayed its raw id, while
 * three retired 1.5/3.5 models it can no longer reach still had labels.
 *
 * The ids come from the backend's capability matrix (with `MODEL_SUGGESTIONS` as
 * the offline fallback); a label for a model the server cannot route to is a
 * label nobody can see.
 */
const MODEL_LABELS: readonly [match: string, label: string][] = [
  ['claude-opus-5', 'Claude Opus 5'],
  ['claude-opus-4-8', 'Claude Opus 4.8'],
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gpt-4o-mini', 'GPT-4o mini'],
  ['gpt-4o', 'GPT-4o'],
  ['o4-mini', 'o4-mini'],
];

function getModelLabel(val: string): string {
  if (val === 'motion') return 'Motion AI';
  const [, m] = val.split(':');
  if (!m) return 'Select model';
  for (const [match, label] of MODEL_LABELS) {
    if (m.includes(match)) return label;
  }
  // The raw id, which is at least honest — a model this app offers should have
  // an entry above, and seeing the id is how that omission gets noticed.
  return m;
}

export function AiChatPanel(): JSX.Element {
  const {
    messages,
    busy,
    streaming,
    activity,
    pipelineStages,
    planItems,
    ready,
    conversations,
    activeConversationId,
    submit,
    cancel,
    newChat,
    openConversation,
    removeConversation,
    hasPendingTx,
    pendingChanges,
    acceptPending,
    discardPending,
    isManualMode,
    toggleManualMode,
    direction,
    setDirection,
    packs,
    filmstrip,
  } = useAiChatContext();

  const [value, setValue] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [canvasSnapshot, setCanvasSnapshot] = useState<string | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Provider + model selection (bottom of the composer, like other AI apps).
  const aiProvider = useAiProviderStore((s) => s.provider);
  const setAiProvider = useAiProviderStore((s) => s.setProvider);
  const aiModels = useAiProviderStore((s) => s.models);
  const setAiModel = useAiProviderStore((s) => s.setModel);
  const aiStatus = useAiProviderStore((s) => s.status);
  const aiMotion = useAiProviderStore((s) => s.motion);
  // False until a live /ai/keys answer has landed this session. Used to keep the
  // "connect a provider" banner off the screen while the answer is still in
  // flight — telling someone to set up a key and then withdrawing it a moment
  // later is how the setup prompt came to feel like it never went away.
  const aiVerified = useAiProviderStore((s) => s.verified);
  // The backend's capability matrix when it has answered, MODEL_SUGGESTIONS
  // until then — see the store. Never the constant directly.
  const modelsFor = useAiProviderStore((s) => s.modelsFor);

  const providerReady = (id: GatewayProviderId): boolean =>
    id === 'motion' ? !!aiMotion?.present : !!aiStatus?.[id as AiProviderId]?.present;

  /** Whether the account has ANY usable provider, not just the selected one. */
  const anyProviderReady =
    !!aiMotion?.present || PROVIDER_OPTIONS.some((p) => providerReady(p.id));

  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  /** Which direction chip has its popover open, if any. */
  const [openChip, setOpenChip] = useState<'look' | 'shape' | 'variants' | null>(null);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const modePickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
      if (modePickerRef.current && !modePickerRef.current.contains(e.target as Node)) {
        setModeDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const dropdownValue =
    aiProvider === 'motion'
      ? 'motion'
      : `${aiProvider}:${aiModels[aiProvider] || modelsFor(aiProvider)[0] || ''}`;

  const onChangeModel = (val: string): void => {
    if (val === 'motion') {
      setAiProvider('motion');
      return;
    }
    const [p, m] = val.split(':');
    if (p && m) {
      setAiProvider(p as GatewayProviderId);
      setAiModel(p as AiProviderId, m);
    }
  };

  // Auto-scroll the thread as content streams in.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, planItems, pipelineStages, hasPendingTx]);

  // Capture a canvas snapshot when a preview transaction opens.
  useEffect(() => {
    if (!hasPendingTx) {
      setCanvasSnapshot(null);
      setIsPlayingPreview(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        const cvs = document.querySelector('canvas');
        if (cvs) setCanvasSnapshot(cvs.toDataURL('image/png'));
      } catch {
        /* cross-origin/empty canvas — show the card without a snapshot */
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [hasPendingTx]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const img = await processImageFile(f);
      if (img) setPendingImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, img]));
    }
  }, []);

  const send = useCallback(() => {
    if (busy) return;
    const text = value.trim();
    if (!text && !pendingImages.length) return;
    setValue('');
    const imgs = pendingImages;
    setPendingImages([]);
    void submit(text, imgs.length ? imgs : undefined);
  }, [busy, value, pendingImages, submit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const togglePlayPreview = (): void => {
    try {
      const tc = getTimelineController();
      if (tc.isPlaying) {
        tc.pause();
        setIsPlayingPreview(false);
      } else {
        tc.goToStart();
        tc.play();
        setIsPlayingPreview(true);
      }
    } catch {
      /* timeline not booted yet */
    }
  };

  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  };

  const showPlan = (busy || hasPendingTx) && planItems.length > 0;

  return (
    <div className={styles.root}>
      {/* ── Header: title + new chat + history ─────────────────────── */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <Icon name="sparkles" size="sm" /> Assistant
        </span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            title="New chat"
            onClick={() => {
              setShowHistory(false);
              newChat();
            }}
          >
            <Icon name="plus" size="md" />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${showHistory ? styles.iconButtonActive : ''}`}
            title="Chat history"
            onClick={() => setShowHistory((v) => !v)}
          >
            <Icon name="history" size="md" />
          </button>
        </div>
      </div>

      {showHistory ? (
        /* ── History list ─────────────────────────────────────────── */
        <div className={styles.history}>
          {conversations.length === 0 && <div className={styles.emptyNote}>No conversations yet.</div>}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`${styles.historyRow} ${c.id === activeConversationId ? styles.historyRowActive : ''}`}
              onClick={() => {
                setShowHistory(false);
                void openConversation(c.id);
              }}
            >
              <span className={styles.historyTitle}>{c.title || 'Untitled chat'}</span>
              <span className={styles.historyTime}>{formatTime(c.updatedAt)}</span>
              <button
                type="button"
                className={styles.iconButton}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeConversation(c.id);
                }}
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        /* ── Thread ───────────────────────────────────────────────── */
        <div className={styles.thread} ref={threadRef}>
          {/* No "coming soon" banner: when this panel mounts, the assistant is
              available. Key connection is the only setup gate — see keyBanner. */}
          {/* Only once the gateway / vault has actually answered. Before that we do not
              know, and guessing "no key" is what made this read as a setup
              prompt that ignored the keys the user had already saved. */}
          {!ready && aiVerified && (
            <div className={styles.keyBanner}>
              {anyProviderReady ? (
                <>Pick a connected provider in the model menu below to start.</>
              ) : (
                <>
                  Connect an AI provider to start.{' '}
                  {/* Was `#/dashboard?tab=settings` — a route the local edition
                      never registers, so this bounced off the router's
                      catch-all back to the editor and the OSS build had no way
                      to enter a key at all. Opens the in-editor tab now, which
                      exists in both editions. */}
                  <button type="button" className={styles.keyBannerLink} onClick={() => openAiSettings()}>
                    Open AI settings →
                  </button>
                </>
              )}
            </div>
          )}
          {messages.length === 0 && ready && (
            <div>
              <div className={styles.betaNotice}>
                <Icon name="sparkles" size="md" />
                <span>
                  <strong>The AI assistant is still experimental.</strong> Right now it can
                  handle simple actions reliably, but not complex, multi-step scenes yet. Feel
                  free to try it — just expect the occasional miss while it improves.
                </span>
              </div>
              <div className={styles.emptyNote}>
                Describe the motion video you want — I plan it, build it, review it, and show you a
                preview to apply or decline.
              </div>
              <div className={styles.presetContainer}>
                <div className={styles.presetTitle}>Quick Motion Presets</div>
                <div className={styles.presetGrid}>
                  {[
                    {
                      name: '🚀 SaaS Explainer',
                      desc: '3-scene SaaS promo with indigo cards & floating orbs',
                      prompt: 'Create a 3-scene SaaS promo video in saas style with indigo cards, floating ambient orbs, and clean kinetic text.',
                    },
                    {
                      name: '🍎 Apple Minimal Reveal',
                      desc: 'Product reveal with background depth & camera sweeps',
                      prompt: 'Create an elegant Apple-style product reveal in premium style with deep background depth, subtle camera sweeps, and crisp typography.',
                    },
                    {
                      name: '⚡ Cyberpunk Kinetic',
                      desc: 'High-energy cyberpunk promo with neon glow & snappy motion',
                      prompt: 'Create a high-energy cyberpunk promo in cyberpunk style with neon accent glow, word-by-word kinetic text, and snappy motion physics.',
                    },
                    {
                      name: '🎬 Broadcast Lower Third',
                      desc: 'Broadcast lower third with accent bar & slide-in title',
                      prompt: 'Create a professional broadcast lower third with an accent bar and slide-in text for NextGen Motion.',
                    },
                    {
                      name: '✨ Trim-Path Logo Reveal',
                      desc: 'AE-style stroke trim-path outline reveal & glowing emblem',
                      prompt: 'Build a trim-path stroke outline logo reveal for NextGen AI with glowing emblem pop and title entrance in cyberpunk style.',
                    },
                    {
                      name: '💥 Radial Repeater Burst',
                      desc: '12-copy radial repeater burst accent (HUD / particle ring)',
                      prompt: 'Add a 12-copy radial repeater burst accent at the center of the frame in saas style.',
                    },
                    {
                      name: '🌀 Organic Path Morph',
                      desc: 'Liquid shape distortion with pucker/bloat morphing',
                      prompt: 'Add an organic liquid pucker-bloat shape path morph with rotation in saas style.',
                    },
                  ].map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={styles.presetChip}
                      onClick={() => void submit(p.prompt)}
                    >
                      <span className={styles.presetChipName}>{p.name}</span>
                      <span className={styles.presetChipDesc}>{p.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className={styles.userMsg}>
                {m.images?.map((src, j) => (
                  <img key={j} src={src} className={styles.msgThumb} alt="" />
                ))}
                {m.text}
              </div>
            ) : (
              <div key={i} className={`${styles.assistantMsg} ${m.error ? styles.errorMsg : ''}`}>
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            ),
          )}

          {/* Director pipeline stages (generative prompts). */}
          {busy && pipelineStages && (
            <div className={styles.planCard}>
              <div className={styles.planTitle}>Production plan</div>
              {pipelineStages.map((s, i) => (
                <div key={i} className={styles.planRow} data-status={s.status}>
                  <span className={styles.planMark}>
                    {s.status === 'done' ? <Icon name="check" size="sm" /> : s.status === 'active' ? <span className={styles.spinner} /> : ''}
                  </span>
                  {s.label}
                </div>
              ))}
            </div>
          )}

          {/* Concrete build steps — each flips to ✓ as the tool completes. */}
          {showPlan && (
            <div className={styles.planCard}>
              <div className={styles.planTitle}>Build steps</div>
              {planItems.map((it) => (
                <div key={it.id} className={styles.planRow} data-status={it.status}>
                  <span className={styles.planMark}>
                    {it.status === 'done' ? (
                      <Icon name="check" size="sm" />
                    ) : it.status === 'error' ? (
                      <Icon name="close" size="sm" />
                    ) : (
                      <span className={styles.spinner} />
                    )}
                  </span>
                  {it.label}
                </div>
              ))}
            </div>
          )}

          {busy && streaming && (
            <div className={styles.assistantMsg}>
              <ReactMarkdown>{streaming}</ReactMarkdown>
            </div>
          )}
          {/* Always show a live "working" line while busy and no prose is
              streaming — so a tool-heavy turn (which emits no text) never looks
              frozen. The pipeline/build cards above show the detail. */}
          {busy && !streaming && (
            <div className={styles.activityRow}>
              <span className={styles.spinner} />
              <span className={styles.activityText}>{activity || 'Working'}…</span>
            </div>
          )}

          {/* Result preview: Apply commits the transaction, Decline rolls it back. */}
          {hasPendingTx && (
            <div className={styles.previewCard}>
              <div className={styles.previewHeader}>Result preview</div>
              <div className={styles.previewFrame} style={{ width: PREVIEW_W, height: PREVIEW_H }}>
                {canvasSnapshot ? (
                  <img src={canvasSnapshot} alt="Result preview" />
                ) : (
                  <div className={styles.previewEmpty}>Preview on canvas</div>
                )}
                <button
                  type="button"
                  className={styles.previewPlay}
                  title={isPlayingPreview ? 'Pause' : 'Play preview'}
                  onClick={togglePlayPreview}
                >
                  <Icon name={isPlayingPreview ? 'pause' : 'play'} size="md" />
                </button>
              </div>
              {filmstrip.length > 1 && (
                <div className={styles.filmstrip}>
                  {filmstrip.map((src, i) => (
                    <img key={i} src={src} alt={`Frame ${i + 1}`} />
                  ))}
                </div>
              )}
              {pendingChanges.length > 0 && (
                <div className={styles.previewChanges}>
                  {pendingChanges.length} change{pendingChanges.length > 1 ? 's' : ''} pending
                </div>
              )}
              <div className={styles.previewActions}>
                <button type="button" className={styles.applyButton} onClick={acceptPending}>
                  <Icon name="check" size="sm" /> Apply
                </button>
                <button type="button" className={styles.declineButton} onClick={discardPending}>
                  <Icon name="close" size="sm" /> Decline
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Composer (Pill Container matching screenshot) ────────── */}
      {!showHistory && (
        <div className={styles.composer}>
          {/* Direction. Every control is optional and unset by default - the
              caster has always been able to take a pack, an accent, an energy and
              a duration, and nothing in the product could supply them, so the
              model guessed all four on every run. */}
          <div className={styles.directionBar}>
            <div
              className={`${styles.directionChip} ${direction.lookPackId ? styles.directionChipSet : ''}`}
              title="Look pack - fixes palette, type, shape language, pacing and motion vocabulary"
              onClick={() => setOpenChip((c) => (c === 'look' ? null : 'look'))}
            >
              <Icon name="sparkles" size="sm" />
              {packs.find((pk) => pk.id === direction.lookPackId)?.displayName ?? 'Any look'}
              {direction.lookPackId && (
                <span
                  className={styles.directionClear}
                  role="button"
                  aria-label="Clear look"
                  onClick={(e) => { e.stopPropagation(); setDirection({ lookPackId: undefined }); }}
                >
                  <Icon name="close" size="sm" />
                </span>
              )}
              {openChip === 'look' && (
                <div className={styles.directionPopover} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.popoverHeader}>Look pack</div>
                  <button
                    type="button"
                    className={`${styles.directionOption} ${!direction.lookPackId ? styles.directionOptionActive : ''}`}
                    onClick={() => { setDirection({ lookPackId: undefined }); setOpenChip(null); }}
                  >
                    <span>Let the AI choose</span>
                    <span className={styles.directionOptionIntent}>
                      It reads the brief and picks the pack that fits.
                    </span>
                  </button>
                  {packs.map((pk) => (
                    <button
                      key={pk.id}
                      type="button"
                      className={`${styles.directionOption} ${direction.lookPackId === pk.id ? styles.directionOptionActive : ''}`}
                      onClick={() => { setDirection({ lookPackId: pk.id }); setOpenChip(null); }}
                    >
                      <span>{pk.displayName}</span>
                      <span className={styles.directionOptionIntent}>{pk.intent}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className={`${styles.directionChip} ${
                direction.energy !== undefined || direction.totalDurationMs || direction.accent
                  ? styles.directionChipSet
                  : ''
              }`}
              title="Energy, length and brand colour"
              onClick={() => setOpenChip((c) => (c === 'shape' ? null : 'shape'))}
            >
              <Icon name="settings" size="sm" />
              Shape
              {openChip === 'shape' && (
                <div className={styles.directionPopover} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.popoverHeader}>Energy</div>
                  <div className={styles.directionRow}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((direction.energy ?? 0.5) * 100)}
                      onChange={(e) => setDirection({ energy: Number(e.target.value) / 100 })}
                    />
                    <span className={styles.directionValue}>
                      {direction.energy === undefined ? 'auto' : direction.energy.toFixed(2)}
                    </span>
                  </div>

                  <div className={styles.popoverHeader}>Length</div>
                  <div className={styles.directionRow}>
                    <input
                      type="range"
                      min={4}
                      max={60}
                      value={Math.round((direction.totalDurationMs ?? 12000) / 1000)}
                      onChange={(e) => setDirection({ totalDurationMs: Number(e.target.value) * 1000 })}
                    />
                    <span className={styles.directionValue}>
                      {direction.totalDurationMs ? `${Math.round(direction.totalDurationMs / 1000)}s` : 'auto'}
                    </span>
                  </div>

                  <div className={styles.popoverHeader}>Brand colour</div>
                  <div className={styles.directionRow}>
                    <input
                      type="color"
                      value={direction.accent ?? '#2b7eff'}
                      onChange={(e) => setDirection({ accent: e.target.value })}
                    />
                    <span className={styles.directionValue}>{direction.accent ?? 'auto'}</span>
                  </div>

                  <button
                    type="button"
                    className={styles.directionOption}
                    onClick={() => {
                      setDirection({ energy: undefined, totalDurationMs: undefined, accent: undefined });
                      setOpenChip(null);
                    }}
                  >
                    <span>Reset to automatic</span>
                  </button>
                </div>
              )}
            </div>

            <div
              className={`${styles.directionChip} ${direction.variants > 1 ? styles.directionChipSet : ''}`}
              title="Emit several alternatives and rank them - costs no extra model calls"
              onClick={() => setOpenChip((c) => (c === 'variants' ? null : 'variants'))}
            >
              <Icon name="copy" size="sm" />
              {direction.variants > 1 ? `${direction.variants} directions` : '1 direction'}
              {openChip === 'variants' && (
                <div className={styles.directionPopover} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.popoverHeader}>Alternatives</div>
                  {[1, 2, 3, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`${styles.directionOption} ${direction.variants === n ? styles.directionOptionActive : ''}`}
                      onClick={() => { setDirection({ variants: n }); setOpenChip(null); }}
                    >
                      <span>{n === 1 ? 'One' : `${n} alternatives`}</span>
                      <span className={styles.directionOptionIntent}>
                        {n === 1
                          ? 'Emit a single piece.'
                          : 'Same brief and casting, re-seeded. No extra model calls - the strongest by the linters is applied.'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={styles.composerPill}>
            {pendingImages.length > 0 && (
              <div className={styles.attachStrip}>
                {pendingImages.map((img, i) => (
                  <span key={i} className={styles.attachThumbWrap}>
                    <img src={img.dataUrl} className={styles.attachThumb} alt="" />
                    <button
                      type="button"
                      className={styles.attachRemove}
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Icon name="close" size="sm" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              className={styles.textarea}
              placeholder={
                ready || !aiVerified
                  ? 'Create a cinematic trailer for my brand…'
                  : anyProviderReady
                    ? 'Pick a connected provider below'
                    : 'Connect an AI provider first'
              }
              value={value}
              rows={2}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
                if (files.length) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
            />
            <div className={styles.composerControls}>
              <div className={styles.controlsLeft}>
                <button
                  type="button"
                  className={styles.plusBtn}
                  title="Attach reference image"
                  onClick={() => fileRef.current?.click()}
                >
                  <Icon name="plus" size="md" />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />

                <div
                  ref={modelPickerRef}
                  className={styles.modelPickerWrap}
                  title={`AI Model: ${getModelLabel(dropdownValue)}`}
                  onClick={() => setModelDropdownOpen((o) => !o)}
                >
                  {renderProviderIcon(aiProvider)}
                  <span className={styles.modelPickerLabel}>{getModelLabel(dropdownValue)}</span>
                  <Icon name="chevron-down" size="sm" className={`${styles.chevron} ${modelDropdownOpen ? styles.chevronOpen : ''}`} />

                  {modelDropdownOpen && (
                    <div className={styles.customPopoverMenu} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.popoverHeader}>Select AI Model</div>
                      {/* A "Motion AI" group stood here, gated on
                          `aiMotion?.present`. Hosted AI is gone — the assistant is
                          BYOK in both editions — so that flag is permanently false
                          and the group could never render. Deleted rather than left
                          as an option that looks selectable and 400s. */}
                      {PROVIDER_OPTIONS.map((p) => {
                        const ready = providerReady(p.id);
                        const suggestions = modelsFor(p.id as AiProviderId);
                        return (
                          <div key={p.id} className={styles.popoverGroup}>
                            <div className={styles.groupLabel}>
                              {p.label} {!ready && <span className={styles.noKeyTag}>no key</span>}
                            </div>
                            {suggestions.map((m) => {
                              const val = `${p.id}:${m}`;
                              const active = dropdownValue === val;
                              return (
                                <button
                                  key={val}
                                  type="button"
                                  className={`${styles.popoverOption} ${active ? styles.popoverOptionActive : ''}`}
                                  disabled={!ready}
                                  onClick={() => {
                                    onChangeModel(val);
                                    setModelDropdownOpen(false);
                                  }}
                                >
                                  <span className={styles.optionLabel}>{getModelLabel(val)}</span>
                                  {active && <Icon name="check" size="sm" className={styles.optionCheck} />}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.controlsRight}>
                <div
                  ref={modePickerRef}
                  className={styles.modePickerWrap}
                  title={`Execution mode: ${isManualMode ? 'Manual (Review preview)' : 'Auto (Direct apply)'}`}
                  onClick={() => setModeDropdownOpen((o) => !o)}
                >
                  <Icon name={isManualMode ? 'eye' : 'sparkles'} size="sm" className={styles.modeIcon} />
                  <span className={styles.modePickerLabel}>{isManualMode ? 'Manual' : 'Auto'}</span>
                  <Icon name="chevron-down" size="sm" className={`${styles.chevron} ${modeDropdownOpen ? styles.chevronOpen : ''}`} />

                  {modeDropdownOpen && (
                    <div className={styles.customPopoverMenuRight} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.popoverHeader}>Execution Mode</div>
                      <button
                        type="button"
                        className={`${styles.popoverOption} ${!isManualMode ? styles.popoverOptionActive : ''}`}
                        onClick={() => {
                          toggleManualMode(false);
                          setModeDropdownOpen(false);
                        }}
                      >
                        <div>
                          <div className={styles.optionLabel}>Auto (Direct apply)</div>
                          <div className={styles.optionSub}>AI changes apply immediately</div>
                        </div>
                        {!isManualMode && <Icon name="check" size="sm" className={styles.optionCheck} />}
                      </button>
                      <button
                        type="button"
                        className={`${styles.popoverOption} ${isManualMode ? styles.popoverOptionActive : ''}`}
                        onClick={() => {
                          toggleManualMode(true);
                          setModeDropdownOpen(false);
                        }}
                      >
                        <div>
                          <div className={styles.optionLabel}>Manual (Review preview)</div>
                          <div className={styles.optionSub}>Review preview before applying</div>
                        </div>
                        {isManualMode && <Icon name="check" size="sm" className={styles.optionCheck} />}
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={styles.neonSendBtn}
                  title={busy ? 'Stop' : 'Send prompt'}
                  onClick={busy ? cancel : send}
                  disabled={!busy && !value.trim() && pendingImages.length === 0}
                >
                  <Icon name={busy ? 'stop' : 'arrow-up'} size="md" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AiChatPanel;
